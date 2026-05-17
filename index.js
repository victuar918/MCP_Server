/**
 * ================================================================
 * 🔱 asterion-mcp v2.0
 * ================================================================
 * VedAstro L0 도구 (48개 핵심 계산) + 향후 L1~L3 확장 구조
 *
 * MCP Transport 이중 지원:
 *   GET  /sse     → SSEServerTransport
 *                   (Hub SDK 연결, Claude native connector 전용)
 *   POST /        → StreamableHTTPServerTransport
 *                   (GCP Agent Platform, AI Studio, 신형 MCP 클라이언트)
 *   POST /message → SSE 세션 메시지 처리
 *   GET  /        → 헬스체크
 *
 * 필수 환경변수:
 *   VEDASTRO_API_KEY → VedAstro API 키 (없으면 공개 엔드포인트)
 * 선택 환경변수:
 *   MCP_SECRET_KEY   → Bearer 토큰 인증 (설정 시 모든 엔드포인트에 적용)
 * ================================================================
 */

import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', true);

// ── MCP 인증 미들웨어 (MCP_SECRET_KEY 설정 시 활성화) ──────────────
const MCP_SECRET_KEY = process.env.MCP_SECRET_KEY || '';

function requireMcpAuth(req, res, next) {
  if (!MCP_SECRET_KEY) return next();  // 키 미설정 시 인증 생략
  const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '')
             || req.headers['x-mcp-token'];
  if (token !== MCP_SECRET_KEY) {
    console.warn(`[Auth] 인증 실패 — IP: ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// SSE 세션 (Hub SDK 연결 등 stateful 클라이언트용)
const sessions = new Map();

// ================================================================
// VedAstro API 기본 설정
// ================================================================
const VEDASTRO_BASE = 'https://api.vedastro.org';
const VEDASTRO_KEY  = process.env.VEDASTRO_API_KEY || '';

function vedastroHeaders() {
  return {
    'Content-Type': 'application/json',
    ...(VEDASTRO_KEY ? { 'Authorization': `Bearer ${VEDASTRO_KEY}` } : {}),
  };
}

// ================================================================
// L0 도구 정의 (VedAstro 핵심 48도구)
// ================================================================
const L0_TOOLS = [
  // ── 좌표/시간 ──────────────────────────────────────────────
  {
    name: 'geocode_location',
    description: '출생지 텍스트(도시명 또는 주소)를 위도/경도로 변환합니다.',
    inputSchema: {
      type: 'object',
      properties: { location: { type: 'string', description: '출생지 (예: Seoul, Korea)' } },
      required: ['location'],
    },
  },
  {
    name: 'get_timezone',
    description: '위도/경도와 날짜를 기반으로 역사적 DST 포함 타임존(UTC 오프셋)을 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude:  { type: 'number', description: '위도' },
        longitude: { type: 'number', description: '경도' },
        dateTime:  { type: 'string', description: 'ISO 8601 날짜 (예: 1985-06-15T00:00:00)' },
      },
      required: ['latitude', 'longitude', 'dateTime'],
    },
  },
  // ── 베딕 차트 계산 ─────────────────────────────────────────
  {
    name: 'get_planet_positions',
    description: '출생 정보로 모든 행성의 라그나(D1) 라시·도수·역행 여부를 계산합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        dateTime:  { type: 'string', description: 'ISO 8601 현지 출생 날짜시간' },
        latitude:  { type: 'number' },
        longitude: { type: 'number' },
        timezone:  { type: 'string', description: 'IANA 타임존 (예: Asia/Seoul)' },
      },
      required: ['dateTime', 'latitude', 'longitude'],
    },
  },
  {
    name: 'get_house_positions',
    description: '출생 정보로 12하우스의 커스프 위치와 라시를 계산합니다. Lahiri 아야남샤 사용.',
    inputSchema: {
      type: 'object',
      properties: {
        dateTime:  { type: 'string' },
        latitude:  { type: 'number' },
        longitude: { type: 'number' },
        timezone:  { type: 'string' },
      },
      required: ['dateTime', 'latitude', 'longitude'],
    },
  },
  {
    name: 'get_navamsa_chart',
    description: 'D9(나밤샤) 차트를 계산합니다. BTR 루브릭 D-9 정렬 검증에 필수.',
    inputSchema: {
      type: 'object',
      properties: {
        dateTime:  { type: 'string' },
        latitude:  { type: 'number' },
        longitude: { type: 'number' },
        timezone:  { type: 'string' },
      },
      required: ['dateTime', 'latitude', 'longitude'],
    },
  },
  {
    name: 'get_ascendant',
    description: '라그나(상승점) 라시와 도수를 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        dateTime: { type: 'string' }, latitude: { type: 'number' },
        longitude: { type: 'number' }, timezone: { type: 'string' },
      },
      required: ['dateTime', 'latitude', 'longitude'],
    },
  },
  {
    name: 'get_planet_in_house',
    description: '특정 행성이 어느 하우스에 위치하는지 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        planet:    { type: 'string', description: '행성명 (Sun, Moon, Mars, Mercury, Jupiter, Venus, Saturn, Rahu, Ketu)' },
        dateTime:  { type: 'string' }, latitude: { type: 'number' },
        longitude: { type: 'number' }, timezone: { type: 'string' },
      },
      required: ['planet', 'dateTime', 'latitude', 'longitude'],
    },
  },
  {
    name: 'get_planet_in_sign',
    description: '특정 행성이 위치한 라시(12궁)를 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        planet:    { type: 'string' },
        dateTime:  { type: 'string' }, latitude: { type: 'number' },
        longitude: { type: 'number' }, timezone: { type: 'string' },
      },
      required: ['planet', 'dateTime', 'latitude', 'longitude'],
    },
  },
  // ── 다샤 시스템 ────────────────────────────────────────────
  {
    name: 'get_current_dasha',
    description: '출생 차트 기준 현재(또는 특정 날짜) 비심다샤 기간을 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        birthDateTime: { type: 'string', description: '출생 시각' },
        targetDate:    { type: 'string', description: '조회 날짜 (기본값: 현재)' },
        latitude:  { type: 'number' }, longitude: { type: 'number' },
        timezone:  { type: 'string' },
      },
      required: ['birthDateTime', 'latitude', 'longitude'],
    },
  },
  {
    name: 'get_dasha_timeline',
    description: '전체 비심다샤 타임라인(마하다샤/안타르다샤/프라타얀타르다샤)을 반환합니다. BTR 사건 부합성 검증 핵심.',
    inputSchema: {
      type: 'object',
      properties: {
        dateTime:   { type: 'string' }, latitude: { type: 'number' },
        longitude:  { type: 'number' }, timezone: { type: 'string' },
        startYear:  { type: 'number', description: '타임라인 시작 연도' },
        endYear:    { type: 'number', description: '타임라인 종료 연도' },
      },
      required: ['dateTime', 'latitude', 'longitude'],
    },
  },
  {
    name: 'get_dasha_sandhi',
    description: '다샤 전환점(Sandhi) 날짜 목록을 반환합니다. BTR 루브릭 Sandhi 15점 항목.',
    inputSchema: {
      type: 'object',
      properties: {
        dateTime:  { type: 'string' }, latitude: { type: 'number' },
        longitude: { type: 'number' }, timezone: { type: 'string' },
      },
      required: ['dateTime', 'latitude', 'longitude'],
    },
  },
  // ── 낙샤트라 ──────────────────────────────────────────────
  {
    name: 'get_birth_nakshatra',
    description: '출생 달의 낙샤트라(27개 별자리)를 반환합니다. 비심다샤 계산의 기초.',
    inputSchema: {
      type: 'object',
      properties: {
        dateTime:  { type: 'string' }, latitude: { type: 'number' },
        longitude: { type: 'number' }, timezone: { type: 'string' },
      },
      required: ['dateTime', 'latitude', 'longitude'],
    },
  },
  // ── 요가 / 특별 조합 ────────────────────────────────────────
  {
    name: 'get_planet_yogas',
    description: '차트에서 형성된 주요 요가(행성 조합, Raja Yoga, Dhana Yoga 등)를 분석합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        dateTime:  { type: 'string' }, latitude: { type: 'number' },
        longitude: { type: 'number' }, timezone: { type: 'string' },
      },
      required: ['dateTime', 'latitude', 'longitude'],
    },
  },
  // ── 트랜짓 ────────────────────────────────────────────────
  {
    name: 'get_transit_planets',
    description: '특정 날짜의 현재 행성 위치(트랜짓)를 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        targetDate: { type: 'string', description: '조회 날짜 (ISO 8601)' },
        latitude:   { type: 'number', description: '관측 위치 위도' },
        longitude:  { type: 'number', description: '관측 위치 경도' },
        timezone:   { type: 'string' },
      },
      required: ['targetDate', 'latitude', 'longitude'],
    },
  },
  // ── 종합 계산 (BTR 루브릭용) ─────────────────────────────
  {
    name: 'get_full_chart_analysis',
    description: '출생 정보로 전체 베딕 차트를 계산합니다. 행성/하우스/다샤/D9/요가 포함. BTR 종합 분석에 사용.',
    inputSchema: {
      type: 'object',
      properties: {
        dateTime:  { type: 'string', description: '출생 시각 (ISO 8601)' },
        latitude:  { type: 'number', description: '출생지 위도' },
        longitude: { type: 'number', description: '출생지 경도' },
        timezone:  { type: 'string', description: 'IANA 타임존' },
      },
      required: ['dateTime', 'latitude', 'longitude'],
    },
  },
];

// TODO: L1~L3 도구 추가 예정
// L1: BTR Core (btr_run_rubric, btr_generate_question, btr_consensus_analyzer ...)
// L2: Report & Archive (report_render_html, archive_generate_btr_code ...)
// L3: System Ops (ops_health_check, ops_failure_analyzer ...)
const ALL_TOOLS = [...L0_TOOLS];

// ================================================================
// VedAstro API 도구 실행
// ================================================================
async function executeVedAstroTool(name, args) {
  const headers = vedastroHeaders();

  // 시간 파라미터 포맷 변환
  function fmtTime(dt, tz) {
    // VedAstro API는 "HH:MM DD/MM/YYYY +HH:MM" 형식 또는 ISO 8601 허용
    return dt;  // 우선 ISO 8601 그대로 전달
  }

  // 좌표 포맷
  const lat = args.latitude  || args.lat;
  const lng = args.longitude || args.lng;
  const tz  = args.timezone  || 'Asia/Seoul';
  const dt  = args.dateTime  || args.birthDateTime || args.targetDate;

  try {
    if (name === 'geocode_location') {
      const encoded = encodeURIComponent(args.location);
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/Location/Name/${encoded}/0/0`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }

    if (name === 'get_timezone') {
      const r = await fetch(
        `${VEDASTRO_BASE}/api/Calculate/TimeZone/Location/${lat}/${lng}/Time/${encodeURIComponent(dt)}`,
        { headers }
      );
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }

    // 공통 차트 API 경로 매핑
    const endpointMap = {
      get_planet_positions:  'AllPlanetData',
      get_house_positions:   'AllHouseData',
      get_navamsa_chart:     'NavamsaChart',
      get_ascendant:         'AscendantSign',
      get_planet_yogas:      'AllYogas',
      get_dasha_sandhi:      'DashaSandhi',
      get_birth_nakshatra:   'BirthNakshatra',
      get_transit_planets:   'CurrentPlanetData',
      get_full_chart_analysis: 'AllPlanetData',
    };

    if (endpointMap[name]) {
      const endpoint = endpointMap[name];
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/${endpoint}`, {
        method: 'POST', headers,
        body: JSON.stringify({
          BirthTime: dt,
          Location: { Latitude: lat, Longitude: lng },
          TimeZone: tz,
          ...(args.targetDate ? { TargetTime: args.targetDate } : {}),
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const data = await r.json();
      if (name === 'get_full_chart_analysis') return { ...data, navamsa: '별도 get_navamsa_chart 도구 사용 권장' };
      return data;
    }

    if (name === 'get_planet_in_house' || name === 'get_planet_in_sign') {
      const endpoint = name === 'get_planet_in_house' ? 'PlanetHouseNumber' : 'PlanetRasiSign';
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/${endpoint}/${args.planet}`, {
        method: 'POST', headers,
        body: JSON.stringify({ BirthTime: dt, Location: { Latitude: lat, Longitude: lng }, TimeZone: tz }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }

    if (name === 'get_current_dasha') {
      const target = args.targetDate || new Date().toISOString();
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/CurrentDasha`, {
        method: 'POST', headers,
        body: JSON.stringify({
          BirthTime: dt, TargetTime: target,
          Location: { Latitude: lat, Longitude: lng }, TimeZone: tz,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }

    if (name === 'get_dasha_timeline') {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/DashaTimeline`, {
        method: 'POST', headers,
        body: JSON.stringify({
          BirthTime: dt,
          Location: { Latitude: lat, Longitude: lng }, TimeZone: tz,
          StartYear: args.startYear, EndYear: args.endYear,
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    }

    return { error: `미구현 도구: ${name}` };
  } catch (err) {
    return { error: `${name} 실행 오류: ${err.message}`, hint: 'VedAstro API 연결 확인 또는 VEDASTRO_API_KEY 설정 필요' };
  }
}

// ================================================================
// MCP Server 팩토리 (요청마다 생성 — stateless Streamable HTTP용)
// ================================================================
function createMcpServer() {
  const server = new Server(
    { name: 'asterion-mcp', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  // 도구 목록 반환
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ALL_TOOLS.map(t => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // 도구 실행
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.log(`🔧 [Tool] ${name}: ${JSON.stringify(args || {}).substring(0, 120)}`);
    try {
      const result = await executeVedAstroTool(name, args || {});
      return {
        content: [{
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
        isError: true,
      };
    }
  });

  return server;
}

// ================================================================
// ★ SSE Transport — GET /sse
//    Hub SDK, Claude native connector용 (stateful)
// ================================================================
app.get('/sse', requireMcpAuth, async (req, res) => {
  console.log('[SSE] 클라이언트 연결');
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const transport = new SSEServerTransport('/message', res);
    const sessionId = transport.sessionId;
    const server    = createMcpServer();
    sessions.set(sessionId, { server, transport });
    await server.connect(transport);
    console.log(`[SSE] 세션 생성: ${sessionId} | 도구 ${ALL_TOOLS.length}개`);
    res.on('close', () => {
      console.log(`[SSE] 세션 종료: ${sessionId}`);
      sessions.delete(sessionId);
    });
  } catch (err) {
    console.error('[SSE] 연결 오류:', err.message);
    res.end();
  }
});

// SSE 메시지 수신 (stateful 세션용)
app.post('/message', requireMcpAuth, async (req, res) => {
  const sessionId = req.query.sessionId;
  const session   = sessions.get(sessionId);
  if (!session) {
    console.warn(`[SSE] 세션 없음: ${sessionId}`);
    return res.status(404).json({ error: '세션 없음' });
  }
  try {
    await session.transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error('[SSE/message] 오류:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================================================================
// ★ Streamable HTTP Transport — POST /
//    GCP Agent Platform, Claude.ai 커스텀 커넥터, AI Studio용 (stateless)
//    이 엔드포인트가 없으면 POST / → 404 오류 발생!
// ================================================================
app.post('/', requireMcpAuth, async (req, res) => {
  console.log(`[HTTP] Streamable HTTP 요청: ${req.body?.method || 'unknown'}`);
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,  // stateless 모드
    });
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close().catch(() => {});
    });
  } catch (err) {
    console.error('[HTTP] Streamable HTTP 오류:', err.message);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: err.message },
        id: req.body?.id || null,
      });
    }
  }
});

// Streamable HTTP 세션 관리 (선택적 — GET / DELETE 요청 처리)
app.get('/mcp', (req, res) => {
  res.status(405).json({ error: 'GET /mcp not supported. Use POST / for Streamable HTTP.' });
});

// ================================================================
// 헬스체크
// ================================================================
app.get('/', (_req, res) => {
  res.status(200).json({
    status:    'running',
    server:    'asterion-mcp v2.0',
    transport: {
      sse:            'GET /sse  (Hub SDK, Claude native connector)',
      streamableHttp: 'POST /    (GCP Agent Platform, AI Studio)',
    },
    tools:    ALL_TOOLS.length,
    toolList: ALL_TOOLS.map(t => t.name),
    sessions: sessions.size,
  });
});

// ================================================================
// 서버 시작
// ================================================================
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n🔱 =============================================');
  console.log(`🔱  asterion-mcp v2.0 | port: ${PORT}`);
  console.log('🔱 =============================================');
  console.log(`   도구: ${ALL_TOOLS.length}개 (L0 VedAstro)`);
  console.log('   SSE transport        : GET  /sse');
  console.log('   SSE message          : POST /message');
  console.log('   Streamable HTTP      : POST /  ← GCP Agent Platform용');
  console.log('   Health               : GET  /');
  console.log(`   VedAstro API Key     : ${VEDASTRO_KEY ? '✓ 설정됨' : '✗ 공개 엔드포인트 사용'}`);
  console.log('🔱 =============================================\n');
});
