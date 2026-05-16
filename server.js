/**
 * ============================================================
 * 🔱 ASTERION MCP Server v2.1
 * ============================================================
 * Claude  : Anthropic API 직접 호출 (claude-sonnet-4-6) + 프롬프트 캐싱
 * Gemini  : Google AI API 직접 호출 (Vertex AI 미사용)
 * GPT     : OpenAI API 직접 호출 (gpt-5.5) + tool_choice 강제
 *
 * 연결 방식: 모두 각 회사 API 직접 호출 (Agent Studio / Vertex 미사용)
 * ============================================================
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

// ============================================================
// 1. 서버 초기화
// ============================================================
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', true);

const PORT       = process.env.PORT || 8080;
const SERVER_URL = 'https://mcp-server-611151539232.asia-northeast3.run.app';

// ============================================================
// 2. AI 클라이언트 초기화 (모두 직접 API 호출)
// ============================================================

// Claude: Anthropic 직접 API (프롬프트 캐싱 지원)
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Gemini: Google AI 직접 API (Vertex AI 아님)
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// GPT: OpenAI 직접 API
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 모델명 (환경변수로 교체 가능)
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-pro';
const GPT_MODEL    = process.env.OPENAI_MODEL || 'gpt-5.5';

// ============================================================
// 3. 시스템 프롬프트
// ============================================================

const SYSTEM_PROMPT_BTR = `당신은 ASTERION의 BTR 루브릭 엔진입니다.
S-Class(97점 이상) 합의 전까지 어떤 결과도 확정하지 않으며, 논리적 완결성을 최우선으로 합니다.

[역할]
분석자(Author) · 검증자(Critic) · 반박자(Challenger) · 수정자(Refiner)를 모두 수행합니다.

[루브릭 점수 구조 — 100점]
- 사건 부합성   40점 (3건 미만 시 25점 초과 불가)
- D-9 정렬      20점
- 외형·기질     15점 (기질 미제공 시 10점 초과 불가)
- 다샤 Sandhi   15점
- 논리 일관성   10점 (세 AI 결론 일치 시 자동 반영)

[Hard Stop 조건]
세 AI 모두 97점 이상 AND critical_issues 없음 → Confirmed (S Class)

[응답 형식 — 반드시 JSON]
{
  "candidate_time": "HH:MM",
  "analysis": "상세 분석 내용",
  "scores": {
    "events": 0,
    "navamsa": 0,
    "appearance": 0,
    "sandhi": 0,
    "bonus": 0
  },
  "total": 0,
  "critical_issues": [],
  "minor_issues": [],
  "suggestions": [],
  "confidence": "LOW|MEDIUM|HIGH"
}`;

const SYSTEM_PROMPT_FREESTYLE = `당신은 지훈님의 완전한 자유분방 멀티플레이어 파트너이자 수석 아키텍트입니다.
격식 없이 창의적이고 솔직하게 대화합니다.
파일 시스템 도구를 적극 활용하여 직접 코드를 생성·저장하는 '자동 빌더' 역할을 수행합니다.
모든 도구를 자유롭게 사용하고, 결과를 바로 실행합니다.`;

// ============================================================
// 4. 도구(Tools) 정의 — Anthropic 형식 기준
// ============================================================
const ALL_TOOLS = [
  {
    name: 'write_file',
    description: '지정된 경로에 파일을 생성하고 저장합니다. 경로가 없으면 자동 생성.',
    input_schema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '저장 경로' },
        content:  { type: 'string', description: '파일 내용' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] }
      },
      required: ['filePath', 'content']
    }
  },
  {
    name: 'read_file',
    description: '서버의 특정 파일 내용을 읽어옵니다.',
    input_schema: {
      type: 'object',
      properties: { filePath: { type: 'string' } },
      required: ['filePath']
    }
  },
  {
    name: 'list_files',
    description: '지정된 디렉토리의 파일 및 폴더 목록을 조회합니다.',
    input_schema: {
      type: 'object',
      properties: { dirPath: { type: 'string', description: '기본값: /usr/src/app' } },
      required: []
    }
  },
  {
    name: 'make_directory',
    description: '새 디렉토리를 생성합니다. 중간 경로 자동 생성.',
    input_schema: {
      type: 'object',
      properties: { dirPath: { type: 'string' } },
      required: ['dirPath']
    }
  },
  {
    name: 'sheets_read',
    description: 'Google Sheets에서 데이터를 읽어옵니다.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        range:         { type: 'string', description: '예: Archive!A:Z' }
      },
      required: ['spreadsheetId', 'range']
    }
  },
  {
    name: 'sheets_write',
    description: 'Google Sheets에 데이터를 씁니다.',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        range:         { type: 'string' },
        values:        { type: 'array', description: '2차원 배열' }
      },
      required: ['spreadsheetId', 'range', 'values']
    }
  },
  {
    name: 'geocode_location',
    description: '출생지 이름을 위경도로 변환합니다.',
    input_schema: {
      type: 'object',
      properties: { location: { type: 'string' } },
      required: ['location']
    }
  },
  {
    name: 'get_timezone',
    description: '특정 시각·위치의 역사적 타임존(DST 포함)을 조회합니다.',
    input_schema: {
      type: 'object',
      properties: {
        latitude:  { type: 'number' },
        longitude: { type: 'number' },
        dateTime:  { type: 'string', description: 'ISO 8601 형식' }
      },
      required: ['latitude', 'longitude', 'dateTime']
    }
  },
  {
    name: 'calculate_vedic_chart',
    description: '베다 점성술 차트를 계산합니다. 라시/D9/다샤/Yogas 포함.',
    input_schema: {
      type: 'object',
      properties: {
        dateTime:  { type: 'string' },
        latitude:  { type: 'number' },
        longitude: { type: 'number' },
        timezone:  { type: 'string' }
      },
      required: ['dateTime', 'latitude', 'longitude']
    }
  }
];

// Gemini용 변환
const TOOLS_FOR_GEMINI = [{
  functionDeclarations: ALL_TOOLS.map(t => ({
    name: t.name, description: t.description, parameters: t.input_schema
  }))
}];

// OpenAI용 변환
const TOOLS_FOR_OPENAI = ALL_TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema }
}));

// Claude용 (마지막 도구에 캐시 태그)
const TOOLS_FOR_CLAUDE = ALL_TOOLS.map((t, i) => ({
  ...t,
  ...(i === ALL_TOOLS.length - 1 ? { cache_control: { type: 'ephemeral' } } : {})
}));

// ============================================================
// 5. 도구 실행 엔진
// ============================================================
async function executeTool(name, args) {
  console.log(`🔧 [Tool] ${name}: ${JSON.stringify(args).substring(0, 100)}`);
  try {
    if (name === 'write_file') {
      await fs.mkdir(path.dirname(args.filePath), { recursive: true });
      await fs.writeFile(args.filePath, args.content, args.encoding || 'utf8');
      return { success: true, message: `✅ ${args.filePath} 저장 완료` };
    }
    if (name === 'read_file') {
      return { success: true, content: await fs.readFile(args.filePath, 'utf8') };
    }
    if (name === 'list_files') {
      const dir = args.dirPath || '/usr/src/app';
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return { success: true, path: dir, files: entries.map(e => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' })) };
    }
    if (name === 'make_directory') {
      await fs.mkdir(args.dirPath, { recursive: true });
      return { success: true, message: `✅ ${args.dirPath} 생성 완료` };
    }
    if (name === 'sheets_read' || name === 'sheets_write') {
      return await executeSheetsTool(name, args);
    }
    if (['geocode_location', 'get_timezone', 'calculate_vedic_chart'].includes(name)) {
      return await executeVedAstroTool(name, args);
    }
    return { error: `알 수 없는 도구: ${name}` };
  } catch (err) {
    console.error(`❌ [Tool Error] ${name}:`, err.message);
    return { error: `${name} 실행 오류: ${err.message}` };
  }
}

async function executeSheetsTool(name, args) {
  const rt  = process.env.GOOGLE_REFRESH_TOKEN;
  if (!rt) return { error: 'GOOGLE_REFRESH_TOKEN 누락. /auth 에서 먼저 발급하세요.' };
  const auth = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: rt });
  const sheets = google.sheets({ version: 'v4', auth });

  if (name === 'sheets_read') {
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: args.spreadsheetId, range: args.range });
    return { success: true, values: res.data.values || [] };
  }
  await sheets.spreadsheets.values.update({ spreadsheetId: args.spreadsheetId, range: args.range, valueInputOption: 'USER_ENTERED', requestBody: { values: args.values } });
  return { success: true, message: `업데이트 완료: ${args.range}` };
}

async function executeVedAstroTool(name, args) {
  const apiKey  = process.env.VEDASTRO_API_KEY;
  const baseUrl = 'https://api.vedastro.org/api';
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  if (name === 'geocode_location') {
    const res = await fetch(`${baseUrl}/Calculate/Location/Name/${encodeURIComponent(args.location)}/0/0`, { headers });
    return await res.json();
  }
  if (name === 'get_timezone') {
    const res = await fetch(`${baseUrl}/Calculate/TimeZone/Location/${args.latitude}/${args.longitude}/Time/${encodeURIComponent(args.dateTime)}`, { headers });
    return await res.json();
  }
  const res = await fetch(`${baseUrl}/Calculate/AllPlanetData`, {
    method: 'POST', headers,
    body: JSON.stringify({ BirthTime: args.dateTime, Location: { Latitude: args.latitude, Longitude: args.longitude }, TimeZone: args.timezone || 'Asia/Seoul' })
  });
  return await res.json();
}

// ============================================================
// 6. AI 호출 함수 (모두 직접 API 호출)
// ============================================================

// Claude — Anthropic 직접 API + 프롬프트 캐싱
async function callClaude(userPrompt, systemPrompt, useCache = true) {
  const systemBlocks = [{
    type: 'text', text: systemPrompt,
    ...(useCache ? { cache_control: { type: 'ephemeral' } } : {})
  }];

  let messages = [{ role: 'user', content: userPrompt }];
  let response = await anthropic.messages.create({
    model: CLAUDE_MODEL, max_tokens: 8096,
    system: systemBlocks, tools: TOOLS_FOR_CLAUDE, messages
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
      model: CLAUDE_MODEL, max_tokens: 8096,
      system: systemBlocks, tools: TOOLS_FOR_CLAUDE, messages
    });
  }
  return response.content.find(b => b.type === 'text')?.text || '';
}

// Gemini — Google AI 직접 API (Vertex 아님)
async function callGemini(userPrompt, systemPrompt) {
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    tools: TOOLS_FOR_GEMINI
  });

  const chat = model.startChat({});
  let result = await chat.sendMessage(userPrompt);

  while (true) {
    const calls = result.response.functionCalls();
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

// GPT — OpenAI 직접 API (gpt-5.5, tool_choice 강제)
async function callGPT(userPrompt, systemPrompt, forceTool = null) {
  const params = {
    model: GPT_MODEL,
    messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    tools: TOOLS_FOR_OPENAI
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

// AI 디스패처
async function callAI(model, prompt, systemPrompt) {
  const t = Date.now();
  console.log(`🤖 [${model.toUpperCase()}] 호출...`);
  try {
    let r;
    if      (model === 'claude') r = await callClaude(prompt, systemPrompt, true);
    else if (model === 'gemini') r = await callGemini(prompt, systemPrompt);
    else if (model === 'gpt')    r = await callGPT(prompt, systemPrompt);
    else throw new Error(`지원 모델 아님: ${model}`);
    console.log(`✅ [${model.toUpperCase()}] ${Date.now() - t}ms`);
    return r;
  } catch (err) {
    console.error(`❌ [${model.toUpperCase()}] 오류:`, err.message);
    throw err;
  }
}

// ============================================================
// 7. BTR 루브릭 파이프라인
// ============================================================
const ROUND_ROLES = [
  { author: 'gemini', critic: 'claude', challenger: 'gpt'    },
  { author: 'claude', critic: 'gpt',    challenger: 'gemini' },
  { author: 'gpt',    critic: 'gemini', challenger: 'claude' },
  { author: 'gemini', critic: 'claude', challenger: 'gpt'    },
  { author: 'claude', critic: 'gpt',    challenger: 'gemini' },
];
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
  await executeTool('sheets_write', { spreadsheetId, range: `Archive!G${clientRow}:H${clientRow}`, values: [[new Date().toISOString(), step]] }).catch(e => console.warn('Heartbeat 실패:', e.message));
}

async function executeBTRRound(roundNum, candidateTime, birthData, prevSummary, spreadsheetId, clientRow) {
  const roles  = ROUND_ROLES[roundNum - 1];
  const result = { round: roundNum, scores: {}, analyses: {}, rawResponses: {} };
  const ctx    = `[출생 데이터] ${JSON.stringify(birthData, null, 2)}\n[후보 시각] ${candidateTime}\n[이전 라운드 요약] ${prevSummary || '없음'}`;

  // Author
  await updateHeartbeat(spreadsheetId, `R${roundNum}_${roles.author.toUpperCase()}_ANALYSIS`, clientRow);
  const aRaw = await callAI(roles.author, `[Author — 초안 분석]\n${ctx}\n\n루브릭 기준으로 분석 후 JSON 응답.`, SYSTEM_PROMPT_BTR);
  const aP   = parseRubricScore(aRaw);
  result.scores[roles.author]       = aP.total;
  result.analyses[roles.author]     = aP;
  result.rawResponses[roles.author] = aRaw;

  // Critic
  await updateHeartbeat(spreadsheetId, `R${roundNum}_${roles.critic.toUpperCase()}_VERIFY`, clientRow);
  const cRaw = await callAI(roles.critic, `[Critic — 검증]\n${ctx}\n[선공 분석]\n${aRaw}\n\n논리적 오류 탐색 및 독립 재채점.`, SYSTEM_PROMPT_BTR);
  const cP   = parseRubricScore(cRaw);
  result.scores[roles.critic]       = cP.total;
  result.analyses[roles.critic]     = cP;
  result.rawResponses[roles.critic] = cRaw;

  // Challenger
  await updateHeartbeat(spreadsheetId, `R${roundNum}_${roles.challenger.toUpperCase()}_VERIFY`, clientRow);
  const hRaw = await callAI(roles.challenger, `[Challenger — 최종 반박]\n${ctx}\n[선공]\n${aRaw}\n[비판]\n${cRaw}\n\n충돌 해소 및 최종 결론.`, SYSTEM_PROMPT_BTR);
  const hP   = parseRubricScore(hRaw);
  result.scores[roles.challenger]       = hP.total;
  result.analyses[roles.challenger]     = hP;
  result.rawResponses[roles.challenger] = hRaw;

  const vals        = Object.values(result.scores);
  result.divergence = (Math.max(...vals) - Math.min(...vals)) >= 5;
  result.avgScore   = vals.reduce((a, b) => a + b, 0) / vals.length;

  const allCritical = [...(aP.critical_issues || []), ...(cP.critical_issues || []), ...(hP.critical_issues || [])].filter(i => i && !i.includes('파싱 실패'));
  result.hardStop   = vals.every(s => s >= 97) && allCritical.length === 0;

  console.log(`📈 [R${roundNum}] ${JSON.stringify(result.scores)} | 평균: ${result.avgScore.toFixed(1)} | HardStop: ${result.hardStop}`);
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
          const doc = `# BTR Confirmed — S Class\n생성: ${new Date().toISOString()}\n확정시각: ${candidateTime}\n점수: ${JSON.stringify(r.scores)}`;
          await executeTool('write_file', { filePath: `/tmp/btr-${jobId}-confirmed.md`, content: doc });
          if (spreadsheetId && clientRow) await executeTool('sheets_write', { spreadsheetId, range: `Archive!D${clientRow}`, values: [['Confirmed']] }).catch(() => {});
          pipelineStatus.set(jobId, { status: 'confirmed', candidateTime, round, scores: r.scores });
          break;
        }
      }
      if (confirmed) break;

      // 실패 분석
      await updateHeartbeat(spreadsheetId, 'FAILURE_ANALYSIS', clientRow);
      const fp = `5라운드 소진. 출생: ${JSON.stringify(birthData)}, 시각: ${candidateTime}, 점수이력: ${JSON.stringify(allRounds.map(r => r.scores))}\n추가질문 JSON 응답 (생시 직접 질문 금지).`;
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

// ============================================================
// 8. 라우팅
// ============================================================

// Health Check
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'running', server: '🔱 ASTERION MCP Server v2.1', version: '2.1.0',
    models: {
      claude: `${CLAUDE_MODEL} — Anthropic 직접 API + 캐싱`,
      gemini: `${GEMINI_MODEL} — Google AI 직접 API`,
      gpt:    `${GPT_MODEL} — OpenAI 직접 API`
    },
    endpoints: ['POST /message', 'POST /btr/start', 'GET /btr/status/:id', 'POST /btr/round', 'POST /task/queue', 'GET /task/pending', 'PATCH /task/:id', 'GET /auth', 'GET /auth/callback']
  });
});

// 단일 AI 채팅 (채팅앱 → MCP 서버 호출)
app.post('/message', async (req, res) => {
  const { prompt, modelName = 'claude' } = req.body;
  const isFreestyle  = (req.headers['x-jihoon-app'] === 'ASTERION-CHATS' && req.headers['x-access-mode'] === 'Freestyle');
  const systemPrompt = isFreestyle ? SYSTEM_PROMPT_FREESTYLE : SYSTEM_PROMPT_BTR;

  if (!prompt) return res.status(400).json({ error: 'prompt 필드 필요' });
  if (isFreestyle) console.log('🚀 [Mode] 자유분방 모드');

  try {
    const reply = await callAI(modelName, prompt, systemPrompt);
    res.json({ reply, isFreestyle, model: modelName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// BTR 파이프라인 시작
app.post('/btr/start', async (req, res) => {
  const { birthData, candidateTimes, spreadsheetId, clientRow } = req.body;
  if (!birthData || !candidateTimes?.length) return res.status(400).json({ error: 'birthData, candidateTimes 필수' });
  const jobId = `btr-${Date.now()}`;
  res.json({ success: true, jobId, statusUrl: `/btr/status/${jobId}` });
  runBTRPipeline(jobId, birthData, candidateTimes, spreadsheetId, clientRow).catch(console.error);
});

app.get('/btr/status/:jobId', (req, res) => {
  const s = pipelineStatus.get(req.params.jobId);
  if (!s) return res.status(404).json({ error: '해당 jobId 없음' });
  res.json(s);
});

app.post('/btr/round', async (req, res) => {
  const { roundNumber, candidateTime, birthData, previousSummary, spreadsheetId, clientRow } = req.body;
  if (!roundNumber || !candidateTime || !birthData) return res.status(400).json({ error: 'roundNumber, candidateTime, birthData 필수' });
  try {
    res.json(await executeBTRRound(roundNumber, candidateTime, birthData, previousSummary || '', spreadsheetId, clientRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Task Queue (AI 간 비동기 협업)
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

// Google OAuth (Refresh Token 발급)
app.get('/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${SERVER_URL}/auth/callback`;
  if (!clientId || !clientSecret) return res.status(500).send('<h2 style="color:red">🚨 GOOGLE_CLIENT_ID 또는 GOOGLE_CLIENT_SECRET 누락</h2>');
  const oa = new OAuth2Client(clientId, clientSecret, redirectUri);
  res.redirect(oa.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.projects', 'https://www.googleapis.com/auth/drive.readonly'] }));
});
app.get('/auth/callback', async (req, res) => {
  const oa = new OAuth2Client(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI || `${SERVER_URL}/auth/callback`);
  try {
    const { tokens } = await oa.getToken(req.query.code);
    res.send(`<div style="padding:24px;font-family:monospace;"><h2 style="color:green">✅ 인증 성공!</h2><p><b>GOOGLE_REFRESH_TOKEN</b> (Cloud Run 환경변수에 추가):</p><textarea rows="5" cols="80" readonly>${tokens.refresh_token || '(기존 토큰 유효)'}</textarea></div>`);
  } catch (err) {
    res.status(500).send('OAuth 오류: ' + err.message);
  }
});

// ============================================================
// 9. 서버 시작
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🔱 =========================================');
  console.log(`🔱  ASTERION MCP Server v2.1 | 포트: ${PORT}`);
  console.log('🔱 =========================================');
  console.log(`  Claude : ${CLAUDE_MODEL} (Anthropic 직접 API + 캐싱)`);
  console.log(`  Gemini : ${GEMINI_MODEL} (Google AI 직접 API)`);
  console.log(`  GPT    : ${GPT_MODEL} (OpenAI 직접 API)`);
  console.log('🔱 =========================================\n');
});
