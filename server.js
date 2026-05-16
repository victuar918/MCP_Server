/**
 * ================================================================
 * 🔱 ASTERION BTR Pipeline Server v2.3
 * ================================================================
 * Claude  : Anthropic SDK / claude-sonnet-4-6 + Extended Thinking
 * Gemini  : Google AI SDK / gemini-3.1-pro-preview + thinking_level:'high'
 * GPT     : OpenAI SDK / gpt-5.5 (기본형, reasoning_effort 미지정)
 *
 * 필수 환경변수:
 *   ANTHROPIC_API_KEY      → Anthropic Console (직접 API)
 *   GEMINI_API_KEY         → Google AI Studio
 *   OPENAI_API_KEY         → OpenAI Platform
 *   GOOGLE_CLIENT_ID       → GCP OAuth2 클라이언트 ID
 *   GOOGLE_CLIENT_SECRET   → GCP OAuth2 클라이언트 시크릿
 *   GOOGLE_REFRESH_TOKEN   → /auth 엔드포인트로 발급 후 설정
 *   BTR_SERVER_URL         → 이 서버 자신의 공개 URL (OAuth redirect용)
 *
 * 선택 환경변수:
 *   GOOGLE_REDIRECT_URI    → OAuth 리다이렉트 URI
 *   VEDASTRO_API_KEY       → VedAstro API 키 (없으면 공개 엔드포인트 사용)
 * ================================================================
 */

import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';

// ================================================================
// 1. 서버 초기화
// ================================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', true);

const PORT       = process.env.PORT || 8080;
const SERVER_URL = process.env.BTR_SERVER_URL || process.env.SERVER_URL || `http://localhost:${PORT}`;

// ================================================================
// 2. AI 클라이언트 + 모델 하드코딩 (최신 검증 완료 버전 고정)
// ================================================================
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const genAI     = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const openai    = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const CLAUDE_MODEL = 'claude-sonnet-4-6';          // Extended Thinking 사용
const GEMINI_MODEL = 'gemini-3.1-pro-preview';     // thinking_level:'high' 사용
const GPT_MODEL    = 'gpt-5.5';                    // 기본형, reasoning_effort 미지정

// ================================================================
// 3. 시스템 프롬프트
// ================================================================
const SYSTEM_PROMPT_BTR = `너는 ASTERION의 BTR 루브릭 분석가다.
S-Class(97점 이상 합의) 달성만을 목표로 한다.
합리화된 낮은 점수 제출 금지. 불완전한 데이터에 타협 금지.

[루브릭 점수 구조 — 100점]
- 사건 부합성   40점 (3건 미만 시 25점 초과 불가)
- D-9 정렬      20점
- 외형·기질 일치 15점 (기질 미제공 시 10점 초과 불가)
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

const SYSTEM_PROMPT_FREESTYLE = `너는 ASTERION의 내부 전용 AI 어시스턴트다.
자유롭게 대화하며 어떤 주제든 제한 없이 답할 수 있다.
한국어로 대화하는 것을 선호한다. 필요하면 도구를 사용해서 정확하게 답한다.`;

// ================================================================
// 4. 도구 정의
// ================================================================
const ALL_TOOLS = [
  { name: 'write_file',    description: '지정한 경로에 파일 생성/덮어쓰기',      input_schema: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] } }, required: ['filePath', 'content'] } },
  { name: 'read_file',     description: '파일 내용 읽기',                       input_schema: { type: 'object', properties: { filePath: { type: 'string' } }, required: ['filePath'] } },
  { name: 'list_files',    description: '디렉토리 파일 목록',                    input_schema: { type: 'object', properties: { dirPath: { type: 'string', description: '기본값: /usr/src/app' } }, required: [] } },
  { name: 'make_directory',description: '디렉토리 생성',                         input_schema: { type: 'object', properties: { dirPath: { type: 'string' } }, required: ['dirPath'] } },
  { name: 'sheets_read',   description: 'Google Sheets 범위 읽기',               input_schema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string', description: '예: Archive!A:Z' } }, required: ['spreadsheetId', 'range'] } },
  { name: 'sheets_write',  description: 'Google Sheets 범위 쓰기',               input_schema: { type: 'object', properties: { spreadsheetId: { type: 'string' }, range: { type: 'string' }, values: { type: 'array' } }, required: ['spreadsheetId', 'range', 'values'] } },
  { name: 'geocode_location', description: '출생지 → 위경도 변환',               input_schema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } },
  { name: 'get_timezone',  description: '위경도+날짜 → DST 포함 타임존',         input_schema: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, dateTime: { type: 'string', description: 'ISO 8601' } }, required: ['latitude', 'longitude', 'dateTime'] } },
  { name: 'calculate_vedic_chart', description: '베딕 차트 계산 (라시/D9/다샤)', input_schema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['dateTime', 'latitude', 'longitude'] } }
];

const TOOLS_FOR_GEMINI = [{ functionDeclarations: ALL_TOOLS.map(t => ({ name: t.name, description: t.description, parameters: t.input_schema })) }];
const TOOLS_FOR_OPENAI = ALL_TOOLS.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
const TOOLS_FOR_CLAUDE = ALL_TOOLS.map((t, i) => ({ ...t, ...(i === ALL_TOOLS.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) }));

// ================================================================
// 5. 도구 실행
// ================================================================
async function executeTool(name, args) {
  console.log(`🔧 [Tool] ${name}: ${JSON.stringify(args).substring(0, 100)}`);
  try {
    if (name === 'write_file') {
      await fs.mkdir(path.dirname(args.filePath), { recursive: true });
      await fs.writeFile(args.filePath, args.content, args.encoding || 'utf8');
      return { success: true, message: `✅ ${args.filePath} 저장 완료` };
    }
    if (name === 'read_file') return { success: true, content: await fs.readFile(args.filePath, 'utf8') };
    if (name === 'list_files') {
      const dir = args.dirPath || '/usr/src/app';
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return { success: true, path: dir, files: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
    }
    if (name === 'make_directory') {
      await fs.mkdir(args.dirPath, { recursive: true });
      return { success: true, message: `✅ ${args.dirPath} 생성 완료` };
    }
    if (name === 'sheets_read' || name === 'sheets_write') return await executeSheetsT(name, args);
    if (['geocode_location', 'get_timezone', 'calculate_vedic_chart'].includes(name)) return await executeVedAstroTool(name, args);
    return { error: `알 수 없는 도구: ${name}` };
  } catch (err) {
    console.error(`❌ [Tool Error] ${name}:`, err.message);
    return { error: `${name} 실행 오류: ${err.message}` };
  }
}

async function executeSheetsT(name, args) {
  const rt = process.env.GOOGLE_REFRESH_TOKEN;
  if (!rt) return { error: 'GOOGLE_REFRESH_TOKEN 미설정. /auth 엔드포인트로 발급 후 환경변수에 추가하세요.' };
  const auth = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: rt });
  const sheets = google.sheets({ version: 'v4', auth });
  if (name === 'sheets_read') {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: args.spreadsheetId, range: args.range });
    return { success: true, values: res.data.values || [] };
  }
  await sheets.spreadsheets.values.update({ spreadsheetId: args.spreadsheetId, range: args.range, valueInputOption: 'USER_ENTERED', requestBody: { values: args.values } });
  return { success: true, message: `시트 업데이트 완료: ${args.range}` };
}

async function executeVedAstroTool(name, args) {
  const apiKey  = process.env.VEDASTRO_API_KEY;
  const baseUrl = 'https://api.vedastro.org/api';
  const headers = { 'Content-Type': 'application/json', ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}) };
  try {
    if (name === 'geocode_location') {
      const res = await fetch(`${baseUrl}/Calculate/Location/Name/${encodeURIComponent(args.location)}/0/0`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }
    if (name === 'get_timezone') {
      const res = await fetch(`${baseUrl}/Calculate/TimeZone/Location/${args.latitude}/${args.longitude}/Time/${encodeURIComponent(args.dateTime)}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    }
    const res = await fetch(`${baseUrl}/Calculate/AllPlanetData`, {
      method: 'POST', headers,
      body: JSON.stringify({ BirthTime: args.dateTime, Location: { Latitude: args.latitude, Longitude: args.longitude }, TimeZone: args.timezone || 'Asia/Seoul' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    return { error: `VedAstro API 오류 (${name}): ${err.message}`, hint: 'VEDASTRO_API_KEY 확인 또는 asterion-mcp 서버를 통해 직접 호출하세요.' };
  }
}

// ================================================================
// 6. AI 호출 (각 모델별 최대 사고 설정)
// ================================================================

// Claude: Extended Thinking (budget_tokens: 10000) — 최대 사고
async function callClaude(userPrompt, systemPrompt, useCache = true) {
  const systemBlocks = [{ type: 'text', text: systemPrompt, ...(useCache ? { cache_control: { type: 'ephemeral' } } : {}) }];
  let messages = [{ role: 'user', content: userPrompt }];
  let response = await anthropic.messages.create({
    model: CLAUDE_MODEL, max_tokens: 16000,
    system: systemBlocks, tools: TOOLS_FOR_CLAUDE, messages,
    thinking: { type: 'enabled', budget_tokens: 10000 },
  });
  while (response.stop_reason === 'tool_use') {
    const assistantContent = response.content;
    const toolResults = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        const result = await executeTool(block.name, block.input);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
    }
    messages = [...messages, { role: 'assistant', content: assistantContent }, { role: 'user', content: toolResults }];
    response = await anthropic.messages.create({
      model: CLAUDE_MODEL, max_tokens: 16000,
      system: systemBlocks, tools: TOOLS_FOR_CLAUDE, messages,
      thinking: { type: 'enabled', budget_tokens: 10000 },
    });
  }
  return response.content.find(b => b.type === 'text')?.text || '';
}

// Gemini: thinking_level:'high' — 최대 사고
async function callGemini(userPrompt, systemPrompt) {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: TOOLS_FOR_GEMINI,
    generationConfig: { thinking_level: 'high', maxOutputTokens: 65000 },
  });
  const chat = model.startChat({});
  let result = await chat.sendMessage(userPrompt);
  while (true) {
    let calls = [];
    try {
      calls = result.response.functionCalls() || [];
    } catch (_) {
      try {
        const parts = result.response?.candidates?.[0]?.content?.parts || [];
        calls = parts.filter(p => p.functionCall).map(p => ({ name: p.functionCall.name, args: p.functionCall.args }));
      } catch (__) { calls = []; }
    }
    if (!calls || calls.length === 0) break;
    const toolResponses = [];
    for (const call of calls) {
      const toolResult = await executeTool(call.name, call.args);
      toolResponses.push({ functionResponse: { name: call.name, response: toolResult } });
    }
    result = await chat.sendMessage(toolResponses);
  }
  return result.response.text();
}

// GPT: gpt-5.5 기본형 (reasoning_effort 미지정 = 내부 default)
async function callGPT(userPrompt, systemPrompt, forceTool = null) {
  const params = {
    model: GPT_MODEL,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    tools: TOOLS_FOR_OPENAI,
    // reasoning_effort 미지정: gpt-5.5 기본형
  };
  if (forceTool) params.tool_choice = { type: 'function', function: { name: forceTool } };
  let response    = await openai.chat.completions.create(params);
  let message     = response.choices[0].message;
  let allMessages = [...params.messages];
  while (message.tool_calls?.length > 0) {
    const toolMsgs = [message];
    for (const call of message.tool_calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments); } catch (_) {}
      const r = await executeTool(call.function.name, args);
      toolMsgs.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(r) });
    }
    allMessages = [...allMessages, ...toolMsgs];
    response = await openai.chat.completions.create({ model: GPT_MODEL, messages: allMessages, tools: TOOLS_FOR_OPENAI });
    message  = response.choices[0].message;
  }
  return message.content || '';
}

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

// ================================================================
// 7. BTR 루브릭 파이프라인
// ================================================================
const ROUND_ROLES = [
  { author: 'gemini', critic: 'claude', challenger: 'gpt'    },
  { author: 'claude', critic: 'gpt',    challenger: 'gemini' },
  { author: 'gpt',    critic: 'gemini', challenger: 'claude' },
  { author: 'gemini', critic: 'claude', challenger: 'gpt'    },
  { author: 'claude', critic: 'gpt',    challenger: 'gemini' },
];

// 메모리 전용 (Cloud Run 재시작 시 유실 — TODO: Sheets 기반 영속화 예정)
const pipelineStatus = new Map();

function parseRubricScore(text) {
  try {
    const m = text.match(/\{[\s\S]*?"total"[\s\S]*?\}/);
    if (m) return JSON.parse(m[0]);
  } catch (_) {}
  return { total: 0, critical_issues: ['JSON 파싱 실패'], analysis: text, confidence: 'LOW' };
}

async function updateHeartbeat(spreadsheetId, step, clientRow) {
  if (!spreadsheetId || !clientRow) return;
  await executeTool('sheets_write', { spreadsheetId, range: `Archive!G${clientRow}:H${clientRow}`, values: [[new Date().toISOString(), step]] }).catch(e => console.warn('Heartbeat 오류:', e.message));
}

async function executeBTRRound(roundNum, candidateTime, birthData, prevSummary, spreadsheetId, clientRow) {
  const roles  = ROUND_ROLES[roundNum - 1];
  const result = { round: roundNum, scores: {}, analyses: {}, rawResponses: {} };
  const ctx    = `[출생 데이터] ${JSON.stringify(birthData, null, 2)}\n[후보 생시] ${candidateTime}\n[이전 라운드 요약] ${prevSummary || '없음'}`;

  await updateHeartbeat(spreadsheetId, `R${roundNum}_${roles.author.toUpperCase()}_ANALYSIS`, clientRow);
  const aRaw = await callAI(roles.author, `[Author — 독립 분석]\n${ctx}\n\n루브릭 평가를 단독 JSON 형식으로 제출.`, SYSTEM_PROMPT_BTR);
  const aP   = parseRubricScore(aRaw);
  result.scores[roles.author] = aP.total; result.analyses[roles.author] = aP; result.rawResponses[roles.author] = aRaw;

  await updateHeartbeat(spreadsheetId, `R${roundNum}_${roles.critic.toUpperCase()}_VERIFY`, clientRow);
  const cRaw = await callAI(roles.critic, `[Critic — 비판]\n${ctx}\n[이전 분석]\n${aRaw}\n\n논리적 오류 지적 + 독자 점수 제출.`, SYSTEM_PROMPT_BTR);
  const cP   = parseRubricScore(cRaw);
  result.scores[roles.critic] = cP.total; result.analyses[roles.critic] = cP; result.rawResponses[roles.critic] = cRaw;

  await updateHeartbeat(spreadsheetId, `R${roundNum}_${roles.challenger.toUpperCase()}_VERIFY`, clientRow);
  const hRaw = await callAI(roles.challenger, `[Challenger — 최종 반박]\n${ctx}\n[분석]\n${aRaw}\n[비판]\n${cRaw}\n\n두 AI 충돌 지점 분석 + 최종 검증 점수.`, SYSTEM_PROMPT_BTR);
  const hP   = parseRubricScore(hRaw);
  result.scores[roles.challenger] = hP.total; result.analyses[roles.challenger] = hP; result.rawResponses[roles.challenger] = hRaw;

  const vals = Object.values(result.scores);
  result.divergence = (Math.max(...vals) - Math.min(...vals)) >= 5;
  result.avgScore   = vals.reduce((a, b) => a + b, 0) / vals.length;
  const allCritical = [...(aP.critical_issues||[]), ...(cP.critical_issues||[]), ...(hP.critical_issues||[])].filter(i => i && !i.includes('JSON 파싱'));
  result.hardStop   = vals.every(s => s >= 97) && allCritical.length === 0;

  console.log(`📊 [R${roundNum}] ${JSON.stringify(result.scores)} | 평균: ${result.avgScore.toFixed(1)} | HardStop: ${result.hardStop}`);
  return result;
}

async function runBTRPipeline(jobId, birthData, candidateTimes, spreadsheetId, clientRow) {
  pipelineStatus.set(jobId, { status: 'running', round: 0 });
  try {
    for (const candidateTime of candidateTimes) {
      let prevSummary = '';
      const allRounds = [];
      let confirmed   = false;
      for (let round = 1; round <= 5; round++) {
        pipelineStatus.set(jobId, { status: 'running', round, candidateTime });
        const r = await executeBTRRound(round, candidateTime, birthData, prevSummary, spreadsheetId, clientRow);
        allRounds.push(r);
        prevSummary += `Round ${round}: ${JSON.stringify(r.scores)}\n`;
        if (r.hardStop) {
          confirmed = true;
          await executeTool('write_file', { filePath: `/tmp/btr-${jobId}-confirmed.md`, content: `# BTR Confirmed — S Class\n생성: ${new Date().toISOString()}\n확정 생시: ${candidateTime}\n점수: ${JSON.stringify(r.scores)}` });
          if (spreadsheetId && clientRow) await executeTool('sheets_write', { spreadsheetId, range: `Archive!D${clientRow}`, values: [['Confirmed']] }).catch(() => {});
          pipelineStatus.set(jobId, { status: 'confirmed', candidateTime, round, scores: r.scores });
          break;
        }
      }
      if (confirmed) break;
      await updateHeartbeat(spreadsheetId, 'FAILURE_ANALYSIS', clientRow);
      const fp = `5라운드 실패. 데이터: ${JSON.stringify(birthData)}, 생시: ${candidateTime}\n추가질문 3개 JSON 형식으로 제안.`;
      const [ga, ca, pa] = await Promise.allSettled([callAI('gemini', fp, SYSTEM_PROMPT_BTR), callAI('claude', fp, SYSTEM_PROMPT_BTR), callAI('gpt', fp, SYSTEM_PROMPT_BTR)]);
      if (spreadsheetId && clientRow) await executeTool('sheets_write', { spreadsheetId, range: `Archive!D${clientRow}`, values: [['WaitInfo_BTR']] }).catch(() => {});
      pipelineStatus.set(jobId, { status: 'failed_analysis_complete', candidateTime, failureAnalysis: { gemini: ga.value, claude: ca.value, gpt: pa.value } });
    }
  } catch (err) {
    console.error('❌ [BTR] 파이프라인 오류:', err.message);
    pipelineStatus.set(jobId, { status: 'error', error: err.message });
    if (spreadsheetId && clientRow) await executeTool('sheets_write', { spreadsheetId, range: `Archive!D${clientRow}`, values: [['DEGRADED']] }).catch(() => {});
  }
}

// ================================================================
// 8. 엔드포인트
// ================================================================
app.get('/', (req, res) => res.status(200).json({
  status: 'running', server: '🔱 ASTERION BTR Pipeline Server v2.3',
  models: { claude: `${CLAUDE_MODEL} + Extended Thinking`, gemini: `${GEMINI_MODEL} + thinking_level:high`, gpt: `${GPT_MODEL} 기본형` },
  endpoints: ['POST /message', 'POST /btr/start', 'GET /btr/status/:id', 'POST /btr/round', 'POST /task/queue', 'GET /task/pending', 'PATCH /task/:id', 'GET /auth', 'GET /auth/callback']
}));

app.post('/message', async (req, res) => {
  const { prompt, modelName = 'claude' } = req.body;
  const isFreestyle = (req.headers['x-jihoon-app'] === 'ASTERION-CHATS' && req.headers['x-access-mode'] === 'Freestyle');
  if (!prompt) return res.status(400).json({ error: 'prompt 필요' });
  try {
    const reply = await callAI(modelName, prompt, isFreestyle ? SYSTEM_PROMPT_FREESTYLE : SYSTEM_PROMPT_BTR);
    res.json({ reply, isFreestyle, model: modelName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/btr/start', async (req, res) => {
  const { birthData, candidateTimes, spreadsheetId, clientRow } = req.body;
  if (!birthData || !candidateTimes?.length) return res.status(400).json({ error: 'birthData, candidateTimes 필요' });
  const jobId = `btr-${Date.now()}`;
  res.json({ success: true, jobId, statusUrl: `/btr/status/${jobId}` });
  runBTRPipeline(jobId, birthData, candidateTimes, spreadsheetId, clientRow).catch(console.error);
});

app.get('/btr/status/:jobId', (req, res) => {
  const s = pipelineStatus.get(req.params.jobId);
  if (!s) return res.status(404).json({ error: '알 수 없는 jobId' });
  res.json(s);
});

app.post('/btr/round', async (req, res) => {
  const { roundNumber, candidateTime, birthData, previousSummary, spreadsheetId, clientRow } = req.body;
  if (!roundNumber || !candidateTime || !birthData) return res.status(400).json({ error: '필수 파라미터 누락' });
  try { res.json(await executeBTRRound(roundNumber, candidateTime, birthData, previousSummary || '', spreadsheetId, clientRow)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

const taskQueue = [];
app.post('/task/queue', (req, res) => {
  const task = { id: `task-${Date.now()}`, ...req.body, status: 'pending', createdAt: new Date().toISOString() };
  taskQueue.push(task); res.json({ success: true, taskId: task.id });
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

app.get('/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${SERVER_URL}/auth/callback`;
  if (!clientId || !clientSecret) return res.status(500).send('<h2 style="color:red">⚠️ GOOGLE_CLIENT_ID 또는 GOOGLE_CLIENT_SECRET 미설정</h2>');
  const oa = new OAuth2Client(clientId, clientSecret, redirectUri);
  res.redirect(oa.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.readonly'] }));
});
app.get('/auth/callback', async (req, res) => {
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${SERVER_URL}/auth/callback`;
  const oa = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri);
  try {
    const { tokens } = await oa.getToken(req.query.code);
    res.send(`<div style="padding:24px;font-family:monospace;"><h2 style="color:green">✅ 인증 성공!</h2><p><b>GOOGLE_REFRESH_TOKEN</b> (Cloud Run 환경변수에 추가):</p><textarea rows="5" cols="80" readonly>${tokens.refresh_token || '(이미 발급된 경우 — 재발급 필요 시 /auth 재방문)'}</textarea></div>`);
  } catch (err) { res.status(500).send('OAuth 오류: ' + err.message); }
});

// ================================================================
// 9. 서버 시작
// ================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🔱 ================================================');
  console.log(`🔱  ASTERION BTR Pipeline Server v2.3 | 포트: ${PORT}`);
  console.log('🔱 ================================================');
  console.log(`   Claude : ${CLAUDE_MODEL} + Extended Thinking (10k)`);
  console.log(`   Gemini : ${GEMINI_MODEL} + thinking_level:high`);
  console.log(`   GPT    : ${GPT_MODEL} 기본형`);
  console.log(`   URL    : ${SERVER_URL}`);
  console.log(`   Google : ${process.env.GOOGLE_REFRESH_TOKEN ? '✓ RT 설정됨' : '✗ /auth 로 발급 필요'}`);
  console.log('🔱 ================================================\n');
});
