/**
 * ================================================================
 * 🔱 ASTERION AI Evolution Engine v3.0
 * ================================================================
 * L0: VedAstro 천문 계산 (15 tools)
 * L3: System Ops & Evolution (7 tools)
 *     - GitHub 파일 읽기/쓰기/목록 → 코드 수정 → Cloud Build 자동배포
 *     - Google Sheets 읽기/쓰기 → Archive 데이터 관리
 *     - HTTP 범용 요청 → BTR 서버, 상태확인 등
 *
 * 환경변수:
 *   VEDASTRO_API_KEY      → VedAstro API 키
 *   GITHUB_PAT            → GitHub Personal Access Token
 *   GITHUB_OWNER          → GitHub 사용자명 (기본: victuar918)
 *   GOOGLE_CLIENT_ID      → GCP OAuth2 클라이언트 ID
 *   GOOGLE_CLIENT_SECRET  → GCP OAuth2 클라이언트 시크릿
 *   GOOGLE_REFRESH_TOKEN  → Google OAuth Refresh Token
 *   MCP_SECRET_KEY        → MCP 서버 Bearer 인증 (선택)
 * ================================================================
 */

import express from 'express';
import cors from 'cors';

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', true);

const MCP_SECRET_KEY  = process.env.MCP_SECRET_KEY  || '';
const VEDASTRO_BASE   = 'https://api.vedastro.org';
const VEDASTRO_KEY    = process.env.VEDASTRO_API_KEY || '';
const GITHUB_PAT      = process.env.GITHUB_PAT      || '';
const GITHUB_OWNER    = process.env.GITHUB_OWNER    || 'victuar918';

// ── 인증 미들웨어 ──────────────────────────────────────────────
function requireMcpAuth(req, res, next) {
  if (!MCP_SECRET_KEY) return next();
  const token = req.headers['authorization']?.replace(/^Bearer\s+/i, '') || req.headers['x-mcp-token'];
  if (token !== MCP_SECRET_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

const sessions = new Map();

// ── Google OAuth Access Token 갱신 ────────────────────────────
async function getGoogleAccessToken() {
  const rt  = process.env.GOOGLE_REFRESH_TOKEN;
  const cid = process.env.GOOGLE_CLIENT_ID;
  const cs  = process.env.GOOGLE_CLIENT_SECRET;
  if (!rt || !cid || !cs) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: cid, client_secret: cs }),
    });
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}

// ── 도구 정의 ──────────────────────────────────────────────────
const ALL_TOOLS = [
  // ══════════════ L0: VedAstro 천문 계산 ══════════════
  { name: 'geocode_location',        description: '출생지를 위도/경도로 변환합니다.',                                                  inputSchema: { type:'object', properties:{ location:{type:'string'} }, required:['location'] } },
  { name: 'get_timezone',            description: '위도/경도+날짜로 DST 포함 타임존을 반환합니다.',                                    inputSchema: { type:'object', properties:{ latitude:{type:'number'}, longitude:{type:'number'}, dateTime:{type:'string'} }, required:['latitude','longitude','dateTime'] } },
  { name: 'get_planet_positions',    description: '모든 행성의 라그나(D1) 라시·도수·역행 여부 계산. Lahiri 아야남샤.',                inputSchema: { type:'object', properties:{ dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['dateTime','latitude','longitude'] } },
  { name: 'get_house_positions',     description: '12하우스 커스프 위치와 라시 계산.',                                               inputSchema: { type:'object', properties:{ dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['dateTime','latitude','longitude'] } },
  { name: 'get_navamsa_chart',       description: 'D9(나밤샤) 차트 계산. BTR D-9 정렬 검증 필수.',                                   inputSchema: { type:'object', properties:{ dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['dateTime','latitude','longitude'] } },
  { name: 'get_ascendant',           description: '라그나(상승점) 라시와 도수 반환.',                                                 inputSchema: { type:'object', properties:{ dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['dateTime','latitude','longitude'] } },
  { name: 'get_planet_in_house',     description: '특정 행성이 위치한 하우스 번호 반환.',                                             inputSchema: { type:'object', properties:{ planet:{type:'string'}, dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['planet','dateTime','latitude','longitude'] } },
  { name: 'get_planet_in_sign',      description: '특정 행성이 위치한 라시(12궁) 반환.',                                             inputSchema: { type:'object', properties:{ planet:{type:'string'}, dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['planet','dateTime','latitude','longitude'] } },
  { name: 'get_current_dasha',       description: '현재(또는 특정 날짜) 비심다샤 기간 반환.',                                         inputSchema: { type:'object', properties:{ birthDateTime:{type:'string'}, targetDate:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['birthDateTime','latitude','longitude'] } },
  { name: 'get_dasha_timeline',      description: '전체 비심다샤 타임라인. BTR 사건 부합성 검증 핵심.',                               inputSchema: { type:'object', properties:{ dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'}, startYear:{type:'number'}, endYear:{type:'number'} }, required:['dateTime','latitude','longitude'] } },
  { name: 'get_dasha_sandhi',        description: '다샤 전환점(Sandhi) 날짜 목록. BTR Sandhi 15점 항목.',                            inputSchema: { type:'object', properties:{ dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['dateTime','latitude','longitude'] } },
  { name: 'get_birth_nakshatra',     description: '출생 달의 낙샤트라(27개 별자리) 반환.',                                            inputSchema: { type:'object', properties:{ dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['dateTime','latitude','longitude'] } },
  { name: 'get_planet_yogas',        description: '차트 주요 요가(Raja/Dhana Yoga 등) 분석.',                                        inputSchema: { type:'object', properties:{ dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['dateTime','latitude','longitude'] } },
  { name: 'get_transit_planets',     description: '특정 날짜의 행성 위치(트랜짓) 반환.',                                             inputSchema: { type:'object', properties:{ targetDate:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['targetDate','latitude','longitude'] } },
  { name: 'get_full_chart_analysis', description: '전체 베딕 차트 계산 (행성/하우스/다샤/D9/요가). BTR 종합.',                       inputSchema: { type:'object', properties:{ dateTime:{type:'string'}, latitude:{type:'number'}, longitude:{type:'number'}, timezone:{type:'string'} }, required:['dateTime','latitude','longitude'] } },

  // ══════════════ L3: System Ops & Evolution ══════════════
  {
    name: 'github_read_file',
    description: 'GitHub 리포지토리에서 파일 내용을 읽습니다. 코드 검토, 현재 상태 파악에 사용.',
    inputSchema: { type:'object', properties:{ repo:{type:'string', description:'리포지토리명 (예: MCP_Server, HubChat)'}, path:{type:'string', description:'파일 경로 (예: index.js)'}, branch:{type:'string', description:'브랜치 (기본: main)'} }, required:['repo','path'] }
  },
  {
    name: 'github_write_file',
    description: '★ GitHub 리포지토리에 파일을 작성/수정하고 커밋합니다. Cloud Build 자동 배포 트리거. 이 도구로 코드 수정 → 자동 배포가 이루어집니다.',
    inputSchema: { type:'object', properties:{ repo:{type:'string'}, path:{type:'string'}, content:{type:'string', description:'파일 전체 내용'}, message:{type:'string', description:'커밋 메시지'}, branch:{type:'string', description:'기본: main'} }, required:['repo','path','content','message'] }
  },
  {
    name: 'github_list_files',
    description: 'GitHub 리포지토리의 파일/폴더 목록을 조회합니다.',
    inputSchema: { type:'object', properties:{ repo:{type:'string'}, path:{type:'string', description:'디렉토리 경로 (기본: 루트)'}, branch:{type:'string'} }, required:['repo'] }
  },
  {
    name: 'sheets_read',
    description: 'Google Sheets에서 데이터를 읽습니다. Archive, StoneMaster, JuliarCalendar 조회.',
    inputSchema: { type:'object', properties:{ spreadsheetId:{type:'string'}, range:{type:'string', description:'예: Archive!A:Z'} }, required:['spreadsheetId','range'] }
  },
  {
    name: 'sheets_write',
    description: 'Google Sheets에 데이터를 씁니다. Archive 업데이트, BTR 상태 기록 등.',
    inputSchema: { type:'object', properties:{ spreadsheetId:{type:'string'}, range:{type:'string'}, values:{type:'array', description:'2차원 배열'} }, required:['spreadsheetId','range','values'] }
  },
  {
    name: 'http_request',
    description: '임의의 HTTP 요청을 보냅니다. BTR 서버 호출, 서비스 상태확인, 외부 API 연동 등.',
    inputSchema: { type:'object', properties:{ url:{type:'string'}, method:{type:'string', enum:['GET','POST','PUT','PATCH','DELETE'], description:'기본: GET'}, body:{type:'object'}, headers:{type:'object'} }, required:['url'] }
  },
  {
    name: 'get_system_status',
    description: 'ASTERION 핵심 서비스들의 현재 상태를 한번에 확인합니다.',
    inputSchema: { type:'object', properties:{}, required:[] }
  },
];

// ── L0 도구 실행 (VedAstro) ────────────────────────────────────
async function executeVedAstroTool(name, args) {
  const headers = { 'Content-Type':'application/json', ...(VEDASTRO_KEY ? { 'Authorization':`Bearer ${VEDASTRO_KEY}` } : {}) };
  const lat = args.latitude || args.lat;
  const lng = args.longitude || args.lng;
  const tz  = args.timezone || 'Asia/Seoul';
  const dt  = args.dateTime || args.birthDateTime || args.targetDate;
  try {
    if (name === 'geocode_location') {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/Location/Name/${encodeURIComponent(args.location)}/0/0`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json();
    }
    if (name === 'get_timezone') {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/TimeZone/Location/${lat}/${lng}/Time/${encodeURIComponent(dt)}`, { headers });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json();
    }
    const map = { get_planet_positions:'AllPlanetData', get_house_positions:'AllHouseData', get_navamsa_chart:'NavamsaChart', get_ascendant:'AscendantSign', get_planet_yogas:'AllYogas', get_dasha_sandhi:'DashaSandhi', get_birth_nakshatra:'BirthNakshatra', get_transit_planets:'CurrentPlanetData', get_full_chart_analysis:'AllPlanetData' };
    if (map[name]) {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/${map[name]}`, { method:'POST', headers, body: JSON.stringify({ BirthTime:dt, Location:{Latitude:lat,Longitude:lng}, TimeZone:tz }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json();
    }
    if (name === 'get_planet_in_house' || name === 'get_planet_in_sign') {
      const ep = name==='get_planet_in_house' ? 'PlanetHouseNumber' : 'PlanetRasiSign';
      const r  = await fetch(`${VEDASTRO_BASE}/api/Calculate/${ep}/${args.planet}`, { method:'POST', headers, body: JSON.stringify({ BirthTime:dt, Location:{Latitude:lat,Longitude:lng}, TimeZone:tz }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json();
    }
    if (name === 'get_current_dasha') {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/CurrentDasha`, { method:'POST', headers, body: JSON.stringify({ BirthTime:dt, TargetTime:args.targetDate||new Date().toISOString(), Location:{Latitude:lat,Longitude:lng}, TimeZone:tz }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json();
    }
    if (name === 'get_dasha_timeline') {
      const r = await fetch(`${VEDASTRO_BASE}/api/Calculate/DashaTimeline`, { method:'POST', headers, body: JSON.stringify({ BirthTime:dt, Location:{Latitude:lat,Longitude:lng}, TimeZone:tz, StartYear:args.startYear, EndYear:args.endYear }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json();
    }
    return { error:`미구현: ${name}` };
  } catch(err) { return { error:`${name}: ${err.message}` }; }
}

// ── L3 도구 실행 (System Ops) ──────────────────────────────────
const GITHUB_HEADERS = () => ({
  'Authorization': `Bearer ${GITHUB_PAT}`,
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'ASTERION-Evolution-Engine',
  'Content-Type': 'application/json',
});

async function executeSystemTool(name, args) {
  // ── GitHub 파일 읽기
  if (name === 'github_read_file') {
    if (!GITHUB_PAT) return { error: 'GITHUB_PAT 환경변수 미설정' };
    const { repo, path, branch='main' } = args;
    const r = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`, { headers: GITHUB_HEADERS() });
    if (!r.ok) return { error: `GitHub API ${r.status}: ${await r.text()}` };
    const data = await r.json();
    return {
      path: data.path,
      sha:  data.sha,
      size: data.size,
      content: Buffer.from(data.content, 'base64').toString('utf8'),
    };
  }

  // ── GitHub 파일 쓰기 (커밋 → Cloud Build 자동 배포 트리거)
  if (name === 'github_write_file') {
    if (!GITHUB_PAT) return { error: 'GITHUB_PAT 환경변수 미설정' };
    const { repo, path, content, message, branch='main' } = args;
    // 현재 파일 SHA 조회 (업데이트 시 필요)
    let sha;
    const existing = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`, { headers: GITHUB_HEADERS() });
    if (existing.ok) sha = (await existing.json()).sha;
    // 파일 작성
    const r = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: GITHUB_HEADERS(),
      body: JSON.stringify({ message, content: Buffer.from(content).toString('base64'), branch, ...(sha ? { sha } : {}) }),
    });
    if (!r.ok) return { error: `GitHub API ${r.status}: ${await r.text()}` };
    const data = await r.json();
    return { success: true, commit: data.commit?.sha, url: data.content?.html_url, message, note: 'Cloud Build 자동배포 트리거됨' };
  }

  // ── GitHub 파일 목록
  if (name === 'github_list_files') {
    if (!GITHUB_PAT) return { error: 'GITHUB_PAT 환경변수 미설정' };
    const { repo, path='', branch='main' } = args;
    const r = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`, { headers: GITHUB_HEADERS() });
    if (!r.ok) return { error: `GitHub API ${r.status}: ${await r.text()}` };
    const data = await r.json();
    return { files: (Array.isArray(data) ? data : [data]).map(f => ({ name:f.name, type:f.type, size:f.size, path:f.path })) };
  }

  // ── Sheets 읽기
  if (name === 'sheets_read') {
    const token = await getGoogleAccessToken();
    if (!token) return { error: 'Google OAuth 미설정. GOOGLE_REFRESH_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET 환경변수 확인.' };
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(args.range)}`, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) return { error: `Sheets API ${r.status}: ${await r.text()}` };
    const data = await r.json();
    return { values: data.values || [], range: data.range };
  }

  // ── Sheets 쓰기
  if (name === 'sheets_write') {
    const token = await getGoogleAccessToken();
    if (!token) return { error: 'Google OAuth 미설정.' };
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(args.range)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: args.values }),
    });
    if (!r.ok) return { error: `Sheets API ${r.status}: ${await r.text()}` };
    return await r.json();
  }

  // ── HTTP 범용 요청
  if (name === 'http_request') {
    const { url, method='GET', body, headers={} } = args;
    const options = { method, headers: { 'Content-Type':'application/json', ...headers } };
    if (body && method !== 'GET') options.body = JSON.stringify(body);
    const r = await fetch(url, options);
    let responseData;
    try { responseData = await r.json(); } catch { responseData = await r.text(); }
    return { status: r.status, ok: r.ok, data: responseData };
  }

  // ── 시스템 상태 일괄 확인
  if (name === 'get_system_status') {
    const checks = await Promise.allSettled([
      fetch('https://mcp-server-611151539232.asia-northeast3.run.app/').then(r => r.json()),
    ]);
    return {
      mcp_server:  checks[0].status === 'fulfilled' ? { status:'running', server: checks[0].value?.server } : { status:'error' },
      github_pat:  GITHUB_PAT ? '✓ 설정됨' : '✗ 미설정',
      google_oauth: process.env.GOOGLE_REFRESH_TOKEN ? '✓ 설정됨' : '✗ 미설정',
      vedastro_key: VEDASTRO_KEY ? '✓ 설정됨' : '공개 엔드포인트',
      timestamp:   new Date().toISOString(),
    };
  }

  return { error: `알 수 없는 도구: ${name}` };
}

// ── 통합 도구 실행 라우터 ──────────────────────────────────────
const L0_NAMES = new Set(['geocode_location','get_timezone','get_planet_positions','get_house_positions','get_navamsa_chart','get_ascendant','get_planet_in_house','get_planet_in_sign','get_current_dasha','get_dasha_timeline','get_dasha_sandhi','get_birth_nakshatra','get_planet_yogas','get_transit_planets','get_full_chart_analysis']);

async function executeTool(name, args) {
  console.log(`🔧 [Tool] ${name}`);
  if (L0_NAMES.has(name)) return await executeVedAstroTool(name, args);
  return await executeSystemTool(name, args);
}

// ── SSE Transport ───────────────────────────────────────────────
app.get('/sse', requireMcpAuth, (req, res) => {
  const sessionId = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
  sessions.set(sessionId, res);
  req.on('close', () => sessions.delete(sessionId));
  console.log(`[SSE] 연결: ${sessionId}`);
});

app.post('/message', requireMcpAuth, async (req, res) => {
  const sseRes = sessions.get(req.query.sessionId);
  if (!sseRes) return res.status(404).json({ error:'세션 없음' });
  const { id, method, params } = req.body || {};
  async function send(data) { sseRes.write(`data: ${JSON.stringify(data)}\n\n`); }
  try {
    if (method === 'initialize') {
      await send({ jsonrpc:'2.0', id, result:{ protocolVersion:'2025-03-26', capabilities:{tools:{}}, serverInfo:{name:'ASTERION AI Evolution Engine',version:'3.0.0'} } });
    } else if (method === 'notifications/initialized') {
      /* nothing */
    } else if (method === 'tools/list') {
      await send({ jsonrpc:'2.0', id, result:{ tools: ALL_TOOLS.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})) } });
    } else if (method === 'tools/call') {
      const result = await executeTool(params?.name, params?.arguments || {});
      await send({ jsonrpc:'2.0', id, result:{ content:[{type:'text',text:JSON.stringify(result,null,2)}] } });
    } else if (method === 'ping') {
      await send({ jsonrpc:'2.0', id, result:{} });
    } else {
      await send({ jsonrpc:'2.0', id, error:{code:-32601,message:`Method not found: ${method}`} });
    }
    res.status(200).end();
  } catch(err) {
    await send({ jsonrpc:'2.0', id, error:{code:-32603,message:err.message} });
    res.status(200).end();
  }
});

// ── Streamable HTTP ─────────────────────────────────────────────
app.post('/', requireMcpAuth, async (req, res) => {
  const { id, method, params } = req.body || {};
  const ok  = r => res.json({ jsonrpc:'2.0', id, result:r });
  const err = (c,m) => res.json({ jsonrpc:'2.0', id, error:{code:c,message:m} });
  console.log(`[HTTP] ${method}`);
  try {
    if (method === 'initialize')             return ok({ protocolVersion:'2025-03-26', capabilities:{tools:{}}, serverInfo:{name:'ASTERION AI Evolution Engine',version:'3.0.0'} });
    if (method === 'notifications/initialized') return res.status(200).json({jsonrpc:'2.0'});
    if (method === 'tools/list')             return ok({ tools: ALL_TOOLS.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})) });
    if (method === 'tools/call') {
      const result = await executeTool(params?.name, params?.arguments || {});
      return ok({ content:[{type:'text',text:JSON.stringify(result,null,2)}] });
    }
    if (method === 'ping') return ok({});
    return err(-32601, `Method not found: ${method}`);
  } catch(e) { return res.status(500).json({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}}); }
});

// ── 헬스체크 ───────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
  status:'running', server:'ASTERION AI Evolution Engine v3.0',
  layers:{ L0:`VedAstro 천문계산 (${L0_NAMES.size}tools)`, L3:`System Ops & Evolution (${ALL_TOOLS.length - L0_NAMES.size}tools)` },
  totalTools: ALL_TOOLS.length,
  toolList: ALL_TOOLS.map(t=>t.name),
  capabilities:{ github: GITHUB_PAT?'✓':'✗ GITHUB_PAT 미설정', google: process.env.GOOGLE_REFRESH_TOKEN?'✓':'✗ GOOGLE_REFRESH_TOKEN 미설정' },
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔱 ASTERION AI Evolution Engine v3.0 | port:${PORT}`);
  console.log(`   L0 VedAstro: ${L0_NAMES.size}개 | L3 System Ops: ${ALL_TOOLS.length - L0_NAMES.size}개 | 합계: ${ALL_TOOLS.length}개`);
  console.log(`   GitHub: ${GITHUB_PAT?'✓':'✗ GITHUB_PAT 미설정'}`);
  console.log(`   Google: ${process.env.GOOGLE_REFRESH_TOKEN?'✓':'✗ GOOGLE_REFRESH_TOKEN 미설정'}\n`);
});
