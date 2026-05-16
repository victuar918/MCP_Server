/**
 * ================================================================
 * 🔱 ASTERION BTR Pipeline Server v2.5
 * ================================================================
 * Claude  : claude-sonnet-4-6 + Extended Thinking(10k) + Prompt Caching
 *           └ tool_use 루프 최대 10회 (BUG-B 수정)
 * Gemini  : gemini-3.1-pro-preview + thinkingLevel:high (direct fetch)
 *           └ thinkingConfig 최상위 위치 유지
 *           └ thinking 활성화 시 temperature 제거 (BUG-C 수정)
 * GPT     : gpt-5.5 + reasoning_effort:'medium' 명시 (v2.4 미지정 수정)
 *
 * v2.5 변경사항:
 *   - GPT reasoning_effort: 'medium' 명시적 설정
 *   - X-API-Key 서버 인증 미들웨어 추가 (모든 엔드포인트)
 *   - Claude tool_use 루프 최대 10회 제한
 *   - Gemini thinkingConfig 사용 시 temperature 제거
 *   - pipelineStatus TTL 자동 정리 (1시간)
 *   - 환경변수 시작 시 검증
 *
 * 필수 환경변수:
 *   ANTHROPIC_API_KEY    GEMINI_API_KEY    OPENAI_API_KEY
 *   GOOGLE_CLIENT_ID     GOOGLE_CLIENT_SECRET    GOOGLE_REFRESH_TOKEN
 *   BTR_SERVER_URL       SERVER_API_KEY    (← 신규: 서버 인증 키)
 * ================================================================
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

// ── 환경변수 시작 시 검증 ────────────────────────────────────────
const REQUIRED_ENV = ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'];
const MISSING_ENV  = REQUIRED_ENV.filter(k => !process.env[k]);
if (MISSING_ENV.length > 0) {
  console.error(`❌ 필수 환경변수 누락: ${MISSING_ENV.join(', ')}`);
  process.exit(1);
}
if (!process.env.SERVER_API_KEY) {
  console.warn('⚠️  SERVER_API_KEY 미설정 — 인증 없이 실행됩니다 (개발 모드)');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', true);

const PORT       = process.env.PORT || 8080;
const SERVER_URL = process.env.BTR_SERVER_URL || process.env.SERVER_URL || `http://localhost:${PORT}`;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CLAUDE_MODEL = 'claude-sonnet-4-6';
const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const GPT_MODEL    = 'gpt-5.5';
const GEMINI_KEY   = process.env.GEMINI_API_KEY || '';

// ── 서버 인증 미들웨어 ───────────────────────────────────────────
// /auth, /auth/callback, GET / 는 인증 제외
// 나머지 모든 엔드포인트에 X-API-Key 헤더 필요
function authMiddleware(req, res, next) {
  const PUBLIC_PATHS = ['/', '/auth', '/auth/callback'];
  if (PUBLIC_PATHS.includes(req.path)) return next();

  const serverKey = process.env.SERVER_API_KEY;
  if (!serverKey) return next(); // 개발 모드: 키 미설정 시 통과

  const clientKey = req.headers['x-api-key'];
  if (!clientKey || clientKey !== serverKey) {
    console.warn(`🚫 [Auth] 인증 실패 — IP: ${req.ip} | Path: ${req.path}`);
    return res.status(401).json({ error: '인증 실패: X-API-Key 헤더를 확인하세요.' });
  }
  next();
}
app.use(authMiddleware);

// ── 시스템 프롬프트 ──────────────────────────────────────────────
const SYSTEM_PROMPT_BTR = `너는 ASTERION의 BTR 루브릭 분석가다.
S-Class(97점 이상 합의) 달성만을 목표로 한다.
합리화된 낮은 점수 제출 금지. 불완전한 데이터에 타협 금지.

[루브릭 점수 구조 — 100점]
- 사건 부합성         40점 (3건 미만 시 25점 초과 불가)
- D-9 정렬            20점
- 외형·기질 일치      15점 (기질 미제공 시 10점 초과 불가)
- 다샤 전환점(Sandhi) 15점
- 논리 일관성 보너스  10점 (세 AI 결론 일치 시 자동 반영)

[Hard Stop]
세 AI 모두 97점 이상 AND critical_issues 없음 → Confirmed (S Class)

[응답 형식 — 반드시 JSON]
{
  "candidate_time": "HH:MM",
  "analysis": "상세 분석",
  "scores": { "events": 0, "navamsa": 0, "appearance": 0, "sandhi": 0, "bonus": 0 },
  "total": 0,
  "critical_issues": [],
  "minor_issues": [],
  "suggestions": [],
  "confidence": "LOW|MEDIUM|HIGH"
}`;

const SYSTEM_PROMPT_FREESTYLE = `너는 ASTERION의 내부 전용 AI 어시스턴트다. 자유롭게 대화하며 어떤 주제든 제한 없이 답할 수 있다. 한국어 선호.`;

// ── 도구 정의 ───────────────────────────────────────────────────
const ALL_TOOLS = [
  { name: 'write_file',          description: '파일 생성/덮어쓰기',      input_schema: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] } }, required: ['filePath', 'content'] } },
  { name: 'read_file',           description: '파일 읽기',                input_schema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
  { name: 'list_files',          description: '디렉토리 파일 목록',        input_schema: { type: 'object', properties: { dirPath: { type: 'string' } }, required: [] } },
  { name: 'make_directory',      description: '디렉토리 생성',             input_schema: { type: 'object', properties: { dirPath: { type: 'string' } }, required: ['dirPath'] } },
  { name: 'sheets_read',         description: 'Google Sheets 범위 읽기',   input_schema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' } }, required: ['spreadsheetId', 'range'] } },
  { name: 'sheets_write',        description: 'Google Sheets 범위 쓰기',   input_schema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array' } }, required: ['spreadsheetId', 'range', 'values'] } },
  { name: 'geocode_location',    description: '출생지 → 위경도',           input_schema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } },
  { name: 'get_timezone',        description: '위경도 → DST 포함 타임존',  input_schema: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, dateTime: { type: 'string' } }, required: ['latitude', 'longitude', 'dateTime'] } },
  { name: 'calculate_vedic_chart', description: '베딕 차트 계산',          input_schema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['dateTime', 'latitude', 'longitude'] } },
];

// Claude: 마지막 도구에 캐시 마커
const TOOLS_FOR_CLAUDE = ALL_TOOLS.map((t, i) => ({
  ...t,
  ...(i === ALL_TOOLS.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
}));
// OpenAI: function 형식
const TOOLS_FOR_OPENAI = ALL_TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));
// Gemini: functionDeclarations 형식
const TOOLS_FOR_GEMINI = [{
  functionDeclarations: ALL_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  })),
}];

// ── 도구 실행 ───────────────────────────────────────────────────
async function executeTool(name, args) {
  console.log(`🔧 [Tool] ${name}: ${JSON.stringify(args).substring(0, 100)}`);
  try {
    if (name === 'write_file') {
      await fs.mkdir(path.dirname(args.filePath), { recursive: true });
      await fs.writeFile(args.filePath, args.content, args.encoding || 'utf8');
      return { success: true };
    }
    if (name === 'read_file')
      return { success: true, content: await fs.readFile(args.filePath, 'utf8') };
    if (name === 'list_files') {
      const dir     = args.dirPath || '/usr/src/app';
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return { success: true, files: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
    }
    if (name === 'make_directory') {
      await fs.mkdir(args.dirPath, { recursive: true });
      return { success: true };
    }
    if (name === 'sheets_read' || name === 'sheets_write')
      return await executeSheetsT(name, args);
    if (['geocode_location', 'get_timezone', 'calculate_vedic_chart'].includes(name))
      return await executeVedAstroTool(name, args);
    return { error: `알 수 없는 도구: ${name}` };
  } catch (err) {
    console.error(`❌ [Tool] ${name}:`, err.message);
    return { error: err.message };
  }
}

async function executeSheetsT(name, args) {
  const rt = process.env.GOOGLE_REFRESH_TOKEN;
  if (!rt) return { error: 'GOOGLE_REFRESH_TOKEN 미설정. /auth 방문 후 발급하세요.' };
  const auth = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: rt });
  const sheets = google.sheets({ version: 'v4', auth });
  if (name === 'sheets_read') {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: args.spreadsheetId, range: args.range });
    return { success: true, values: res.data.values || [] };
  }
  await sheets.spreadsheets.values.update({
    spreadsheetId: args.spreadsheetId,
    range:         args.range,
    valueInputOption: 'USER_ENTERED',
    requestBody:   { values: args.values },
  });
  return { success: true };
}

async function executeVedAstroTool(name, args) {
  const apiKey  = process.env.VEDASTRO_API_KEY;
  const baseUrl = 'https://api.vedastro.org/api';
  const headers = { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  try {
    if (name === 'geocode_location') {
      const r = await fetch(`${baseUrl}/Calculate/Location/Name/${encodeURIComponent(args.location)}/0/0`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    if (name === 'get_timezone') {
      const r = await fetch(`${baseUrl}/Calculate/TimeZone/Location/${args.latitude}/${args.longitude}/Time/${encodeURIComponent(args.dateTime)}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    const r = await fetch(`${baseUrl}/Calculate/AllPlanetData`, {
      method: 'POST', headers,
      body: JSON.stringify({ BirthTime: args.dateTime, Location: { Latitude: args.latitude, Longitude: args.longitude }, TimeZone: args.timezone || 'Asia/Seoul' }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (err) {
    return { error: `VedAstro (${name}): ${err.message}` };
  }
}

// ════════════════════════════════════════════════════════════════
// AI 호출 함수
// ════════════════════════════════════════════════════════════════

// ── Claude: Extended Thinking + Prompt Caching ──────────────────
// BUG-B 수정: tool_use 루프 최대 10회 제한 (무한루프 방지)
async function callClaude(userPrompt, systemPrompt, useCache = true) {
  const systemBlocks = [{
    type: 'text',
    text: systemPrompt,
    ...(useCache ? { cache_control: { type: 'ephemeral' } } : {}),
  }];

  let messages  = [{ role: 'user', content: userPrompt }];
  let loopCount = 0;
  const MAX_TOOL_LOOPS = 10;

  let response = await anthropic.messages.create({
    model:     CLAUDE_MODEL,
    max_tokens: 16000,       // budget_tokens(10000)보다 반드시 커야 함
    system:    systemBlocks,
    tools:     TOOLS_FOR_CLAUDE,
    messages,
    thinking:  { type: 'enabled', budget_tokens: 10000 },
  });

  while (response.stop_reason === 'tool_use') {
    if (++loopCount > MAX_TOOL_LOOPS) {
      console.warn(`⚠️  [Claude] 도구 루프 ${MAX_TOOL_LOOPS}회 초과 — 강제 종료`);
      break;
    }
    const assistantContent = response.content;
    const toolResults      = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        const result = await executeTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
    }
    messages = [...messages, { role: 'assistant', content: assistantContent }, { role: 'user', content: toolResults }];
    response = await anthropic.messages.create({
      model:     CLAUDE_MODEL,
      max_tokens: 16000,
      system:    systemBlocks,
      tools:     TOOLS_FOR_CLAUDE,
      messages,
      thinking:  { type: 'enabled', budget_tokens: 10000 },
    });
  }
  return response.content.find(b => b.type === 'text')?.text || '';
}

// ── Gemini: direct fetch, thinkingConfig 최상위 ─────────────────
// BUG-C 수정: thinking 활성화 시 temperature 제거
//   (thinkingLevel:high + temperature 공존 → API 오류 발생)
async function callGemini(userPrompt, systemPrompt) {
  if (!GEMINI_KEY) throw new Error('GEMINI_API_KEY 미설정');
  const url      = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;
  let   contents = [{ role: 'user', parts: [{ text: userPrompt }] }];

  for (let depth = 0; depth < 8; depth++) {
    const bodyObj = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      tools: TOOLS_FOR_GEMINI,
      // ★ thinkingConfig 최상위 위치 유지 (BUG-A 이미 수정)
      // ★ temperature 제거: thinking 활성화 시 함께 전달하면 API 오류 (BUG-C 수정)
      thinkingConfig:   { thinkingLevel: 'high' },
      generationConfig: { maxOutputTokens: 65000 },
    };

    const response = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(bodyObj),
    });
    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini ${response.status}: ${err.slice(0, 400)}`);
    }

    const result        = await response.json();
    const candidate     = result.candidates?.[0];
    if (!candidate) throw new Error('Gemini 응답 없음');

    const parts         = candidate.content?.parts || [];
    const functionCalls = parts.filter(p => p.functionCall);

    if (functionCalls.length === 0)
      return parts.filter(p => p.text && !p.thought).map(p => p.text).join('');

    const functionResponses = [];
    for (const p of functionCalls) {
      const { name, args } = p.functionCall;
      const toolResult      = await executeTool(name, args || {});
      functionResponses.push({ functionResponse: { name, response: toolResult } });
    }
    contents = [...contents, { role: 'model', parts }, { role: 'user', parts: functionResponses }];
  }
  return '[최대 도구 깊이 초과]';
}

// ── GPT: gpt-5.5 + reasoning_effort:'medium' 명시 ───────────────
// v2.4 에서 reasoning_effort 미지정 → API 기본값(medium)에 의존
// v2.5: 명시적으로 'medium' 설정 — 비용 예측 가능성 확보
// ※ 'high' / 'xhigh' 는 BTR 루프 5회 시 비용 폭증 위험 → 금지
async function callGPT(userPrompt, systemPrompt, forceTool = null) {
  const params = {
    model:            GPT_MODEL,
    reasoning_effort: 'medium',   // ★ 명시적 설정 (standard 형)
    messages:         [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    tools:            TOOLS_FOR_OPENAI,
  };
  if (forceTool) params.tool_choice = { type: 'function', function: { name: forceTool } };

  let response    = await openai.chat.completions.create(params);
  let message     = response.choices[0].message;
  let allMessages = [...params.messages];
  let loopCount   = 0;
  const MAX_TOOL_LOOPS = 10;

  while (message.tool_calls?.length > 0) {
    if (++loopCount > MAX_TOOL_LOOPS) {
      console.warn(`⚠️  [GPT] 도구 루프 ${MAX_TOOL_LOOPS}회 초과 — 강제 종료`);
      break;
    }
    const toolMsgs = [message];
    for (const call of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments); } catch (_) {}
      const r = await executeTool(call.function.name, args);
      toolMsgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(r) });
    }
    allMessages = [...allMessages, ...toolMsgs];
    response    = await openai.chat.completions.create({
      model:            GPT_MODEL,
      reasoning_effort: 'medium',
      messages:         allMessages,
      tools:            TOOLS_FOR_OPENAI,
    });
    message = response.choices[0].message;
  }
  return message.content || '';
}

// ── 통합 AI 호출 ────────────────────────────────────────────────
async function callAI(model, prompt, systemPrompt) {
  const t = Date.now();
  console.log(`🧠 [${model.toUpperCase()}] 호출...`);
  try {
    let r;
    if      (model === 'claude') r = await callClaude(prompt, systemPrompt, true);
    else if (model === 'gemini') r = await callGemini(prompt, systemPrompt);
    else if (model === 'gpt')    r = await callGPT(prompt, systemPrompt);
    else throw new Error(`알 수 없는 모델: ${model}`);
    console.log(`✅ [${model.toUpperCase()}] ${Date.now() - t}ms`);
    return r;
  } catch (err) {
    console.error(`❌ [${model.toUpperCase()}] 오류:`, err.message);
    throw err;
  }
}

// ════════════════════════════════════════════════════════════════
// BTR 파이프라인
// ════════════════════════════════════════════════════════════════

// 라운드별 Author → Critic → Challenger 역할 순환
const ROUND_ROLES = [
  { author: 'gemini', critic: 'claude', challenger: 'gpt'    },
  { author: 'claude', critic: 'gpt',    challenger: 'gemini' },
  { author: 'gpt',    critic: 'gemini', challenger: 'claude' },
  { author: 'gemini', critic: 'claude', challenger: 'gpt'    },
  { author: 'claude', critic: 'gpt',    challenger: 'gemini' },
];

// pipelineStatus: TTL 1시간 자동 정리
const pipelineStatus = new Map();
setInterval(() => {
  const ONE_HOUR = 60 * 60 * 1000;
  const now      = Date.now();
  for (const [id, val] of pipelineStatus.entries()) {
    if (val._ts && (now - val._ts) > ONE_HOUR) {
      pipelineStatus.delete(id);
      console.log(`🗑️  [Pipeline] 만료 삭제: ${id}`);
    }
  }
}, 10 * 60 * 1000); // 10분마다 실행

function setPipelineStatus(jobId, data) {
  pipelineStatus.set(jobId, { ...data, _ts: Date.now() });
}

function parseRubricScore(text) {
  try {
    const m = text.match(/\{[\s\S]*?"total"[\s\S]*?\}/);
    if (m) return JSON.parse(m[0]);
  } catch (_) {}
  return { total: 0, critical_issues: ['JSON 파싱 실패'], analysis: text, confidence: 'LOW' };
}

async function updateHeartbeat(spreadsheetId, step, clientRow) {
  if (!spreadsheetId || !clientRow) return;
  await executeTool('sheets_write', {
    spreadsheetId,
    range:  `Archive!G${clientRow}:H${clientRow}`,
    values: [[new Date().toISOString(), step]],
  }).catch(e => console.warn('HB:', e.message));
}

async function executeBTRRound(roundNum, candidateTime, birthData, prevSummary, spreadsheetId, clientRow) {
  const roles  = ROUND_ROLES[roundNum - 1];
  const result = { round: roundNum, scores: {}, analyses: {}, rawResponses: {} };
  const ctx    = `[출생 데이터] ${JSON.stringify(birthData, null, 2)}\n[후보 생시] ${candidateTime}\n[이전 요약] ${prevSummary || '없음'}`;

  // Author 단계
  await updateHeartbeat(spreadsheetId, `R${roundNum}_${roles.author.toUpperCase()}_ANALYSIS`, clientRow);
  const aRaw = await callAI(roles.author, `[Author — 독립 분석]\n${ctx}\nJSON 루브릭 평가.`, SYSTEM_PROMPT_BTR);
  const aP   = parseRubricScore(aRaw);
  result.scores[roles.author]       = aP.total;
  result.analyses[roles.author]     = aP;
  result.rawResponses[roles.author] = aRaw;

  // Critic 단계
  await updateHeartbeat(spreadsheetId, `R${roundNum}_${roles.critic.toUpperCase()}_VERIFY`, clientRow);
  const cRaw = await callAI(roles.critic, `[Critic — 비판]\n${ctx}\n[분석]\n${aRaw}\n논리 오류 + 독자 점수.`, SYSTEM_PROMPT_BTR);
  const cP   = parseRubricScore(cRaw);
  result.scores[roles.critic]       = cP.total;
  result.analyses[roles.critic]     = cP;
  result.rawResponses[roles.critic] = cRaw;

  // Challenger 단계
  await updateHeartbeat(spreadsheetId, `R${roundNum}_${roles.challenger.toUpperCase()}_VERIFY`, clientRow);
  const hRaw = await callAI(roles.challenger, `[Challenger — 반박]\n${ctx}\n[분석]\n${aRaw}\n[비판]\n${cRaw}\n최종 검증 점수.`, SYSTEM_PROMPT_BTR);
  const hP   = parseRubricScore(hRaw);
  result.scores[roles.challenger]       = hP.total;
  result.analyses[roles.challenger]     = hP;
  result.rawResponses[roles.challenger] = hRaw;

  const vals = Object.values(result.scores);
  result.divergence = (Math.max(...vals) - Math.min(...vals)) >= 5;
  result.avgScore   = vals.reduce((a, b) => a + b, 0) / vals.length;
  const allCritical = [
    ...(aP.critical_issues || []),
    ...(cP.critical_issues || []),
    ...(hP.critical_issues || []),
  ].filter(i => i && !i.includes('JSON 파싱'));
  result.hardStop = vals.every(s => s >= 97) && allCritical.length === 0;

  console.log(`📊 [R${roundNum}] ${JSON.stringify(result.scores)} | 평균: ${result.avgScore.toFixed(1)} | HardStop: ${result.hardStop}`);
  return result;
}

async function runBTRPipeline(jobId, birthData, candidateTimes, spreadsheetId, clientRow) {
  setPipelineStatus(jobId, { status: 'running', round: 0 });
  try {
    for (const candidateTime of candidateTimes) {
      let prevSummary = '';
      let confirmed   = false;

      for (let round = 1; round <= 5; round++) {
        setPipelineStatus(jobId, { status: 'running', round, candidateTime });
        const r = await executeBTRRound(round, candidateTime, birthData, prevSummary, spreadsheetId, clientRow);
        prevSummary += `Round ${round}: ${JSON.stringify(r.scores)}\n`;

        if (r.hardStop) {
          confirmed = true;
          await executeTool('write_file', {
            filePath: `/tmp/btr-${jobId}-confirmed.md`,
            content:  `# BTR S Class\n${new Date().toISOString()}\n생시: ${candidateTime}\n${JSON.stringify(r.scores)}`,
          });
          if (spreadsheetId && clientRow)
            await executeTool('sheets_write', { spreadsheetId, range: `Archive!D${clientRow}`, values: [['Confirmed']] }).catch(() => {});
          setPipelineStatus(jobId, { status: 'confirmed', candidateTime, round, scores: r.scores });
          break;
        }
      }
      if (confirmed) break;

      // 5라운드 실패 → 추가 정보 요청
      await updateHeartbeat(spreadsheetId, 'FAILURE_ANALYSIS', clientRow);
      const fp = `5라운드 실패. 데이터: ${JSON.stringify(birthData)}, 생시: ${candidateTime}\n추가질문 3개 JSON 제안.`;
      const [ga, ca, pa] = await Promise.allSettled([
        callAI('gemini', fp, SYSTEM_PROMPT_BTR),
        callAI('claude', fp, SYSTEM_PROMPT_BTR),
        callAI('gpt',    fp, SYSTEM_PROMPT_BTR),
      ]);
      if (spreadsheetId && clientRow)
        await executeTool('sheets_write', { spreadsheetId, range: `Archive!D${clientRow}`, values: [['WaitInfo_BTR']] }).catch(() => {});
      setPipelineStatus(jobId, {
        status:          'failed_analysis_complete',
        candidateTime,
        failureAnalysis: { gemini: ga.value, claude: ca.value, gpt: pa.value },
      });
    }
  } catch (err) {
    console.error('❌ [BTR]', err.message);
    setPipelineStatus(jobId, { status: 'error', error: err.message });
    if (spreadsheetId && clientRow)
      await executeTool('sheets_write', { spreadsheetId, range: `Archive!D${clientRow}`, values: [['DEGRADED']] }).catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════
// 엔드포인트
// ════════════════════════════════════════════════════════════════

// 헬스체크 (인증 제외)
app.get('/', (req, res) => res.status(200).json({
  status:  'running',
  server:  '🔱 ASTERION BTR Pipeline Server v2.5',
  models:  {
    claude: `${CLAUDE_MODEL} + ExtendedThinking(10k) + Cache`,
    gemini: `${GEMINI_MODEL} + thinkingLevel:high`,
    gpt:    `${GPT_MODEL} + reasoning_effort:medium`,
  },
  auth:    process.env.SERVER_API_KEY ? 'enabled (X-API-Key)' : 'disabled (dev mode)',
}));

// 단일 메시지
app.post('/message', async (req, res) => {
  const { prompt, modelName = 'claude' } = req.body;
  const isFreestyle = req.headers['x-jihoon-app'] === 'ASTERION-CHATS'
                   && req.headers['x-access-mode'] === 'Freestyle';
  if (!prompt) return res.status(400).json({ error: 'prompt 필요' });
  try {
    res.json({
      reply: await callAI(modelName, prompt, isFreestyle ? SYSTEM_PROMPT_FREESTYLE : SYSTEM_PROMPT_BTR),
      model: modelName,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BTR 파이프라인 시작 (비동기)
app.post('/btr/start', async (req, res) => {
  const { birthData, candidateTimes, spreadsheetId, clientRow } = req.body;
  if (!birthData || !candidateTimes?.length)
    return res.status(400).json({ error: 'birthData, candidateTimes 필요' });
  const jobId = `btr-${Date.now()}`;
  res.json({ success: true, jobId, statusUrl: `/btr/status/${jobId}` });
  runBTRPipeline(jobId, birthData, candidateTimes, spreadsheetId, clientRow).catch(console.error);
});

// BTR 파이프라인 상태 조회
app.get('/btr/status/:jobId', (req, res) => {
  const s = pipelineStatus.get(req.params.jobId);
  if (!s) return res.status(404).json({ error: '알 수 없는 jobId' });
  res.json(s);
});

// BTR 단일 라운드 실행
app.post('/btr/round', async (req, res) => {
  const { roundNumber, candidateTime, birthData, previousSummary, spreadsheetId, clientRow } = req.body;
  if (!roundNumber || !candidateTime || !birthData)
    return res.status(400).json({ error: '필수 파라미터 누락' });
  try {
    res.json(await executeBTRRound(roundNumber, candidateTime, birthData, previousSummary || '', spreadsheetId, clientRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 태스크 큐
const taskQueue = [];
app.post('/task/queue', (req, res) => {
  const task = { id: `task-${Date.now()}`, ...req.body, status: 'pending', createdAt: new Date().toISOString() };
  taskQueue.push(task);
  res.json({ success: true, taskId: task.id });
});
app.get('/task/pending', (req, res) => {
  let tasks = taskQueue.filter(t => t.status === 'pending');
  if (req.query.assignedTo) tasks = tasks.filter(t => t.assignedTo === req.query.assignedTo);
  res.json({ count: tasks.length, tasks });
});
app.patch('/task/:id', (req, res) => {
  const task = taskQueue.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: '작업 없음' });
  Object.assign(task, req.body, { completedAt: new Date().toISOString() });
  res.json({ success: true, task });
});

// Google OAuth (인증 제외 — 공개 접근 필요)
app.get('/auth', (req, res) => {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${SERVER_URL}/auth/callback`;
  const { GOOGLE_CLIENT_ID: cid, GOOGLE_CLIENT_SECRET: cs } = process.env;
  if (!cid || !cs) return res.status(500).send('<h2 style="color:red">⚠️ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET 미설정</h2>');
  const oa = new OAuth2Client(cid, cs, redirectUri);
  res.redirect(oa.generateAuthUrl({
    access_type: 'offline',
    prompt:      'consent',
    scope:       ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'],
  }));
});
app.get('/auth/callback', async (req, res) => {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${SERVER_URL}/auth/callback`;
  const oa = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);
  try {
    const { tokens } = await oa.getToken(req.query.code);
    res.send(`
      <div style="padding:24px;font-family:monospace">
        <h2 style="color:green">✅ 인증 성공!</h2>
        <p><b>GOOGLE_REFRESH_TOKEN</b> — Cloud Run 환경변수에 등록하세요:</p>
        <textarea rows="5" cols="80" readonly>${tokens.refresh_token || '이미 발급됨 (기존 토큰 유효)'}</textarea>
      </div>`);
  } catch (err) {
    res.status(500).send('OAuth 오류: ' + err.message);
  }
});

// ── 서버 시작 ───────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🔱 =============================================');
  console.log(`🔱  ASTERION BTR Pipeline Server v2.5 | :${PORT}`);
  console.log(`   Claude : ${CLAUDE_MODEL} + Extended Thinking(10k) + Cache`);
  console.log(`   Gemini : ${GEMINI_MODEL} + thinkingLevel:high`);
  console.log(`   GPT    : ${GPT_MODEL} + reasoning_effort:medium ★`);
  console.log(`   Auth   : ${process.env.SERVER_API_KEY ? 'X-API-Key 활성화' : '비활성화 (개발 모드)'}`);
  console.log(`   URL    : ${SERVER_URL}`);
  console.log(`   Google : ${process.env.GOOGLE_REFRESH_TOKEN ? '✓ RT 설정됨' : '✗ /auth 방문 필요'}`);
  console.log('🔱 =============================================\n');
});
