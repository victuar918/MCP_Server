/**
 * ================================================================
 * 🔱 asterion-mcp v2.2
 * ================================================================
 * MCP Transport 이중 지원:
 *   GET  /sse     → SSEServerTransport (Hub SDK, Claude native connector)
 *   POST /        → Streamable HTTP 직접 구현 (GCP Agent Platform, Claude.ai, ChatGPT)
 *   POST /message → SSE 세션 메시지
 *   GET  /        → 헬스체크
 * ================================================================
 */

import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', true);

const MCP_SECRET_KEY = process.env.MCP_SECRET_KEY || '';
const VEDASTRO_BASE  = 'https://api.vedastro.org';
const VEDASTRO_KEY   = process.env.VEDASTRO_API_KEY || '';

// ── 인증 미들웨어 ──────────────────────────────────────────────
function requireMcpAuth(req, res, next) {
  if (!MCP_SECRET_KEY) return next();
  const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '')
             || req.headers['x-mcp-token'];
  if (token !== MCP_SECRET_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const sessions = new Map();

function vedastroHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(VEDASTRO_KEY ? { 'Authorization': `Bearer ${VEDASTRO_KEY}` } : {}),
  };
}

// ── 도구 정의 ──────────────────────────────────────────────────
const ALL_TOOLS = [
  { name: 'geocode_location',       description: '출생지를 위도/경도로 변환합니다.',                              inputSchema: { type: 'object', properties: { location: { type: 'string' } }, required: ['location'] } },
  { name: 'get_timezone',           description: '위도/경도+날짜로 DST 포함 타임존을 반환합니다.',               inputSchema: { type: 'object', properties: { latitude: { type: 'number' }, longitude: { type: 'number' }, dateTime: { type: 'string' } }, required: ['latitude', 'longitude', 'dateTime'] } },
  { name: 'get_planet_positions',   description: '모든 행성의 라그나(D1) 라시·도수·역행 여부 계산. Lahiri 아야남샤.',  inputSchema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['dateTime', 'latitude', 'longitude'] } },
  { name: 'get_house_positions',    description: '12하우스 커스프 위치와 라시 계산. Lahiri 아야남샤.',            inputSchema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['dateTime', 'latitude', 'longitude'] } },
  { name: 'get_navamsa_chart',      description: 'D9(나밤샤) 차트 계산. BTR D-9 정렬 검증 필수.',               inputSchema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['dateTime', 'latitude', 'longitude'] } },
  { name: 'get_ascendant',          description: '라그나(상승점) 라시와 도수 반환.',                              inputSchema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['dateTime', 'latitude', 'longitude'] } },
  { name: 'get_planet_in_house',    description: '특정 행성이 위치한 하우스 번호 반환.',                          inputSchema: { type: 'object', properties: { planet: { type: 'string' }, dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['planet', 'dateTime', 'latitude', 'longitude'] } },
  { name: 'get_planet_in_sign',     description: '특정 행성이 위치한 라시(12궁) 반환.',                          inputSchema: { type: 'object', properties: { planet: { type: 'string' }, dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['planet', 'dateTime', 'latitude', 'longitude'] } },
  { name: 'get_current_dasha',      description: '현재(또는 특정 날짜) 비심다샤 기간 반환.',                      inputSchema: { type: 'object', properties: { birthDateTime: { type: 'string' }, targetDate: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['birthDateTime', 'latitude', 'longitude'] } },
  { name: 'get_dasha_timeline',     description: '전체 비심다샤 타임라인. BTR 사건 부합성 검증 핵심.',            inputSchema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' }, startYear: { type: 'number' }, endYear: { type: 'number' } }, required: ['dateTime', 'latitude', 'longitude'] } },
  { name: 'get_dasha_sandhi',       description: '다샤 전환점(Sandhi) 날짜 목록. BTR Sandhi 15점 항목.',         inputSchema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['dateTime', 'latitude', 'longitude'] } },
  { name: 'get_birth_nakshatra',    description: '출생 달의 낙샤트라(27개 별자리) 반환.',                         inputSchema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['dateTime', 'latitude', 'longitude'] } },
  { name: 'get_planet_yogas',       description: '차트 주요 요가(Raja/Dhana Yoga 등) 분석.',                      inputSchema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['dateTime', 'latitude', 'longitude'] } },
  { name: 'get_transit_planets',    description: '특정 날짜의 행성 위치(트랜짓) 반환.',                           inputSchema: { type: 'object', properties: { targetDate: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['targetDate', 'latitude', 'longitude'] } },
  { name: 'get_full_chart_analysis',description: '전체 베딕 차트 계산 (행성/하우스/다샤/D9/요가). BTR 종합.',    inputSchema: { type: 'object', properties: { dateTime: { type: 'string' }, latitude: { type: 'number' }, longitude: { type: 'number' }, timezone: { type: 'string' } }, required: ['dateTime', 'latitude', 'longitude'] } },
];

// ── VedAstro API 실행 ──────────────────────────────────────────
async function executeVedAstroTool(name, args) {
  const headers = vedastroHeaders();
  const lat = args.latitude  || args.lat;
  const lng = args.longitude || args.lng;
  const tz  = args.timezone  || 'Asia/Seoul';
  const dt  = args.dateTime  || args.birthDateTime || args.targetDate;

  try {
    if (name === 'geocode_location') {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/Location/Name/${encodeURIComponent(args.location)}/0/0`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    if (name === 'get_timezone') {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/TimeZone/Location/${lat}/${lng}/Time/${encodeURIComponent(dt)}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    const endpointMap = {
      get_planet_positions: 'AllPlanetData', get_house_positions: 'AllHouseData',
      get_navamsa_chart: 'NavamsaChart', get_ascendant: 'AscendantSign',
      get_planet_yogas: 'AllYogas', get_dasha_sandhi: 'DashaSandhi',
      get_birth_nakshatra: 'BirthNakshatra', get_transit_planets: 'CurrentPlanetData',
      get_full_chart_analysis: 'AllPlanetData',
    };
    if (endpointMap[name]) {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/${endpointMap[name]}`, {
        method: 'POST', headers,
        body: JSON.stringify({ BirthTime: dt, Location: { Latitude: lat, Longitude: lng }, TimeZone: tz }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    if (name === 'get_planet_in_house' || name === 'get_planet_in_sign') {
      const ep = name === 'get_planet_in_house' ? 'PlanetHouseNumber' : 'PlanetRasiSign';
      const r  = await fetch(`${VEDASTRO_BASE}/api/Calculate/${ep}/${args.planet}`, { method: 'POST', headers, body: JSON.stringify({ BirthTime: dt, Location: { Latitude: lat, Longitude: lng }, TimeZone: tz }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    if (name === 'get_current_dasha') {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/CurrentDasha`, { method: 'POST', headers, body: JSON.stringify({ BirthTime: dt, TargetTime: args.targetDate || new Date().toISOString(), Location: { Latitude: lat, Longitude: lng }, TimeZone: tz }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    if (name === 'get_dasha_timeline') {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/DashaTimeline`, { method: 'POST', headers, body: JSON.stringify({ BirthTime: dt, Location: { Latitude: lat, Longitude: lng }, TimeZone: tz, StartYear: args.startYear, EndYear: args.endYear }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }
    return { error: `미구현: ${name}` };
  } catch (err) {
    return { error: `${name}: ${err.message}` };
  }
}

// ── MCP Server 팩토리 (SSE용) ──────────────────────────────────
function createMcpServer() {
  const server = new Server(
    { name: 'asterion-mcp', version: '2.2.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    console.log(`🔧 [Tool] ${name}`);
    const result = await executeVedAstroTool(name, args || {});
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  });
  return server;
}

// ── GET /sse — SSE Transport ────────────────────────────────────
app.get('/sse', requireMcpAuth, async (req, res) => {
  console.log('[SSE] 연결');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  try {
    const transport = new SSEServerTransport('/message', res);
    const server    = createMcpServer();
    sessions.set(transport.sessionId, { server, transport });
    await server.connect(transport);
    res.on('close', () => sessions.delete(transport.sessionId));
  } catch (err) {
    console.error('[SSE] 오류:', err.message);
    res.end();
  }
});

app.post('/message', requireMcpAuth, async (req, res) => {
  const session = sessions.get(req.query.sessionId);
  if (!session) return res.status(404).json({ error: '세션 없음' });
  try { await session.transport.handlePostMessage(req, res, req.body); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST / — Streamable HTTP (직접 구현, SDK 불필요) ────────────
// GCP Agent Platform, Claude.ai 커스텀 커넥터, ChatGPT가 여기로 POST
app.post('/', requireMcpAuth, async (req, res) => {
  const body = req.body;
  const id   = body?.id ?? null;
  console.log(`[HTTP] ${body?.method || 'request'}`);

  function jsonrpc(result) {
    return { jsonrpc: '2.0', id, result };
  }
  function jsonrpcError(code, message) {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }

  try {
    const method = body?.method;

    if (method === 'initialize') {
      return res.json(jsonrpc({
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'asterion-mcp', version: '2.2.0' },
      }));
    }

    if (method === 'notifications/initialized') {
      return res.status(200).json({ jsonrpc: '2.0' });
    }

    if (method === 'tools/list') {
      return res.json(jsonrpc({
        tools: ALL_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      }));
    }

    if (method === 'tools/call') {
      const { name, arguments: args } = body?.params || {};
      if (!name) return res.json(jsonrpcError(-32602, 'tool name required'));
      const result = await executeVedAstroTool(name, args || {});
      return res.json(jsonrpc({
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }));
    }

    if (method === 'ping') {
      return res.json(jsonrpc({}));
    }

    return res.json(jsonrpcError(-32601, `Method not found: ${method}`));
  } catch (err) {
    console.error('[HTTP] 오류:', err.message);
    return res.status(500).json(jsonrpcError(-32603, err.message));
  }
});

// ── 헬스체크 ────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({
    status: 'running',
    server: 'asterion-mcp v2.2',
    transport: { sse: 'GET /sse', streamableHttp: 'POST /' },
    auth: MCP_SECRET_KEY ? '✓ Bearer 인증 활성화' : '인증 없음',
    tools: ALL_TOOLS.length,
    toolList: ALL_TOOLS.map(t => t.name),
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔱 asterion-mcp v2.2 | port: ${PORT}`);
  console.log(`   SSE:            GET  /sse`);
  console.log(`   Streamable HTTP: POST /  (직접 구현, SDK 불필요)`);
  console.log(`   도구: ${ALL_TOOLS.length}개`);
  console.log(`   인증: ${MCP_SECRET_KEY ? '✓' : '없음'}\n`);
});
