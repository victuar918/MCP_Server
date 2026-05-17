/**
 * ================================================================
 * 🔱 ASTERION AI Evolution Engine v4.0
 * ================================================================
 * L0: VedAstro 천문 계산         (15 tools)
 * L2: Google Cloud 제어          (5 tools)  ← 신규
 *     - gcloud_submit      : Cloud Build로 gcloud 명령어 실행
 *     - cloudbuild_status  : 빌드 결과 조회
 *     - cloudrun_services  : Cloud Run 서비스 목록/상태
 *     - artifact_list      : Artifact Registry 이미지 목록
 *     - cloudrun_set_env   : Cloud Run 환경변수 설정
 * L3: System Ops & Evolution     (8 tools)
 *     - github_read/write/list_files
 *     - sheets_read/write
 *     - http_request
 *     - get_system_status
 *
 * GCP 인증: Cloud Run ADC (메타데이터 서버, 추가 설정 불필요)
 * GitHub:   GITHUB_PAT 환경변수
 * Sheets:   GOOGLE_REFRESH_TOKEN 환경변수
 * ================================================================
 */

import express from 'express';
import cors from 'cors';

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', true);

const MCP_SECRET_KEY = process.env.MCP_SECRET_KEY || '';
const VEDASTRO_BASE  = 'https://api.vedastro.org';
const VEDASTRO_KEY   = process.env.VEDASTRO_API_KEY || '';
const GITHUB_PAT     = process.env.GITHUB_PAT      || '';
const GITHUB_OWNER   = process.env.GITHUB_OWNER    || 'victuar918';
const GCP_PROJECT    = process.env.GCP_PROJECT     || 'asterion-server';
const GCP_REGION     = process.env.GCP_REGION      || 'asia-northeast3';

function requireMcpAuth(req, res, next) {
  if (!MCP_SECRET_KEY) return next();
  const token = req.headers['authorization']?.replace(/^Bearer\s+/i,'') || req.headers['x-mcp-token'];
  if (token !== MCP_SECRET_KEY) return res.status(401).json({ error:'Unauthorized' });
  next();
}

const sessions = new Map();

// ── 인증 토큰 획득 ─────────────────────────────────────────────

// Cloud Run ADC (메타데이터 서버) — 추가 설정 불필요
async function getGCPToken() {
  try {
    const r = await fetch(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      { headers: { 'Metadata-Flavor': 'Google' } }
    );
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}

// Google OAuth (Sheets용)
async function getGoogleOAuthToken() {
  const rt=process.env.GOOGLE_REFRESH_TOKEN, cid=process.env.GOOGLE_CLIENT_ID, cs=process.env.GOOGLE_CLIENT_SECRET;
  if (!rt||!cid||!cs) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ grant_type:'refresh_token', refresh_token:rt, client_id:cid, client_secret:cs }),
    });
    return r.ok ? (await r.json()).access_token : null;
  } catch { return null; }
}

// GitHub 헤더
const ghHeaders = () => ({
  'Authorization': `Bearer ${GITHUB_PAT}`,
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'ASTERION-Evolution-Engine',
  'Content-Type': 'application/json',
});

// ── 도구 정의 ──────────────────────────────────────────────────
const ALL_TOOLS = [
  // ══ L0: VedAstro ══
  { name:'geocode_location',        description:'출생지를 위도/경도로 변환합니다.',                                                 inputSchema:{type:'object',properties:{location:{type:'string'}},required:['location']} },
  { name:'get_timezone',            description:'위도/경도+날짜로 DST 포함 타임존 반환.',                                           inputSchema:{type:'object',properties:{latitude:{type:'number'},longitude:{type:'number'},dateTime:{type:'string'}},required:['latitude','longitude','dateTime']} },
  { name:'get_planet_positions',    description:'모든 행성의 D1 라시·도수·역행 계산. Lahiri 아야남샤.',                             inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_house_positions',     description:'12하우스 커스프 위치와 라시 계산.',                                                inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_navamsa_chart',       description:'D9(나밤샤) 차트 계산. BTR D-9 정렬 검증 필수.',                                   inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_ascendant',           description:'라그나(상승점) 라시와 도수 반환.',                                                 inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_planet_in_house',     description:'특정 행성이 위치한 하우스 번호 반환.',                                             inputSchema:{type:'object',properties:{planet:{type:'string'},dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['planet','dateTime','latitude','longitude']} },
  { name:'get_planet_in_sign',      description:'특정 행성이 위치한 라시(12궁) 반환.',                                             inputSchema:{type:'object',properties:{planet:{type:'string'},dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['planet','dateTime','latitude','longitude']} },
  { name:'get_current_dasha',       description:'현재(또는 특정 날짜) 비심다샤 기간 반환.',                                         inputSchema:{type:'object',properties:{birthDateTime:{type:'string'},targetDate:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['birthDateTime','latitude','longitude']} },
  { name:'get_dasha_timeline',      description:'전체 비심다샤 타임라인. BTR 사건 부합성 검증 핵심.',                               inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'},startYear:{type:'number'},endYear:{type:'number'}},required:['dateTime','latitude','longitude']} },
  { name:'get_dasha_sandhi',        description:'다샤 전환점(Sandhi) 날짜 목록.',                                                  inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_birth_nakshatra',     description:'출생 달의 낙샤트라(27개 별자리) 반환.',                                           inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_planet_yogas',        description:'차트 주요 요가(Raja/Dhana Yoga 등) 분석.',                                        inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_transit_planets',     description:'특정 날짜의 행성 위치(트랜짓) 반환.',                                             inputSchema:{type:'object',properties:{targetDate:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['targetDate','latitude','longitude']} },
  { name:'get_full_chart_analysis', description:'전체 베딕 차트 계산 (행성/하우스/다샤/D9/요가).',                                 inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },

  // ══ L2: Google Cloud 제어 ══
  {
    name: 'gcloud_submit',
    description: '★ Cloud Build를 통해 gcloud 명령어를 실행합니다. Agent Registry 등록, Artifact Registry 관리, Cloud Run 배포 등 모든 gcloud 작업 가능. 빌드 ID를 반환하며 cloudbuild_status로 결과 확인.',
    inputSchema: { type:'object', properties:{
      commands: { type:'array', items:{type:'string'}, description:'실행할 명령어 배열. 각 항목은 bash -c로 실행됨. 예: ["gcloud run services list --region=asia-northeast3"]' },
      project:  { type:'string', description:`GCP 프로젝트 (기본: ${GCP_PROJECT})` },
    }, required:['commands'] }
  },
  {
    name: 'cloudbuild_status',
    description: 'Cloud Build 빌드 상태와 로그를 조회합니다. gcloud_submit 후 결과 확인에 사용.',
    inputSchema: { type:'object', properties:{
      buildId: { type:'string', description:'빌드 ID (gcloud_submit 반환값)' },
      project: { type:'string', description:`기본: ${GCP_PROJECT}` },
    }, required:['buildId'] }
  },
  {
    name: 'cloudrun_services',
    description: 'Cloud Run 서비스 목록과 현재 상태(URL, 트래픽, revision 등)를 조회합니다.',
    inputSchema: { type:'object', properties:{
      project: { type:'string', description:`기본: ${GCP_PROJECT}` },
      region:  { type:'string', description:`기본: ${GCP_REGION}` },
    }, required:[] }
  },
  {
    name: 'artifact_list',
    description: 'Artifact Registry에서 Docker 이미지와 태그 목록을 조회합니다.',
    inputSchema: { type:'object', properties:{
      repository: { type:'string', description:'리포지토리명 (예: mcp-server). 비어있으면 전체 목록.' },
      project:    { type:'string', description:`기본: ${GCP_PROJECT}` },
      location:   { type:'string', description:`기본: ${GCP_REGION}` },
    }, required:[] }
  },
  {
    name: 'cloudrun_set_env',
    description: 'Cloud Run 서비스에 환경변수를 추가/업데이트합니다. GITHUB_PAT, MCP_SECRET_KEY 등 설정에 사용.',
    inputSchema: { type:'object', properties:{
      service: { type:'string', description:'서비스명 (예: mcp-server)' },
      envVars: { type:'object', description:'설정할 환경변수 키-값 쌍. 예: {"GITHUB_PAT": "ghp_..."}' },
      project: { type:'string', description:`기본: ${GCP_PROJECT}` },
      region:  { type:'string', description:`기본: ${GCP_REGION}` },
    }, required:['service','envVars'] }
  },

  // ══ L3: System Ops & Evolution ══
  {
    name: 'github_read_file',
    description: 'GitHub 리포지토리에서 파일 내용을 읽습니다.',
    inputSchema: { type:'object', properties:{ repo:{type:'string'}, path:{type:'string'}, branch:{type:'string',description:'기본: main'} }, required:['repo','path'] }
  },
  {
    name: 'github_write_file',
    description: '★ GitHub에 파일을 작성/수정하고 커밋합니다. Cloud Build 자동 배포 트리거.',
    inputSchema: { type:'object', properties:{ repo:{type:'string'}, path:{type:'string'}, content:{type:'string'}, message:{type:'string'}, branch:{type:'string',description:'기본: main'} }, required:['repo','path','content','message'] }
  },
  {
    name: 'github_list_files',
    description: 'GitHub 리포지토리의 파일/폴더 목록 조회.',
    inputSchema: { type:'object', properties:{ repo:{type:'string'}, path:{type:'string',description:'기본: 루트'}, branch:{type:'string'} }, required:['repo'] }
  },
  {
    name: 'sheets_read',
    description: 'Google Sheets에서 데이터를 읽습니다. Archive, StoneMaster, JuliarCalendar 조회.',
    inputSchema: { type:'object', properties:{ spreadsheetId:{type:'string'}, range:{type:'string',description:'예: Archive!A:Z'} }, required:['spreadsheetId','range'] }
  },
  {
    name: 'sheets_write',
    description: 'Google Sheets에 데이터를 씁니다.',
    inputSchema: { type:'object', properties:{ spreadsheetId:{type:'string'}, range:{type:'string'}, values:{type:'array'} }, required:['spreadsheetId','range','values'] }
  },
  {
    name: 'http_request',
    description: '임의의 HTTP 요청. BTR 서버 호출, 상태확인, 외부 API 연동.',
    inputSchema: { type:'object', properties:{ url:{type:'string'}, method:{type:'string',enum:['GET','POST','PUT','PATCH','DELETE'],description:'기본: GET'}, body:{type:'object'}, headers:{type:'object'} }, required:['url'] }
  },
  {
    name: 'get_system_status',
    description: 'ASTERION 전체 시스템 상태 확인.',
    inputSchema: { type:'object', properties:{}, required:[] }
  },
];

// ── L0 VedAstro 실행 ────────────────────────────────────────────
const L0 = new Set(['geocode_location','get_timezone','get_planet_positions','get_house_positions','get_navamsa_chart','get_ascendant','get_planet_in_house','get_planet_in_sign','get_current_dasha','get_dasha_timeline','get_dasha_sandhi','get_birth_nakshatra','get_planet_yogas','get_transit_planets','get_full_chart_analysis']);

async function execVedAstro(name, args) {
  const h = { 'Content-Type':'application/json', ...(VEDASTRO_KEY?{'Authorization':`Bearer ${VEDASTRO_KEY}`}:{}) };
  const lat=args.latitude||args.lat, lng=args.longitude||args.lng, tz=args.timezone||'Asia/Seoul';
  const dt=args.dateTime||args.birthDateTime||args.targetDate;
  try {
    if (name==='geocode_location') {
      const r=await fetch(`${VEDASTRO_BASE}/api/Calculate/Location/Name/${encodeURIComponent(args.location)}/0/0`,{headers:h});
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_timezone') {
      const r=await fetch(`${VEDASTRO_BASE}/api/Calculate/TimeZone/Location/${lat}/${lng}/Time/${encodeURIComponent(dt)}`,{headers:h});
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    const map={get_planet_positions:'AllPlanetData',get_house_positions:'AllHouseData',get_navamsa_chart:'NavamsaChart',get_ascendant:'AscendantSign',get_planet_yogas:'AllYogas',get_dasha_sandhi:'DashaSandhi',get_birth_nakshatra:'BirthNakshatra',get_transit_planets:'CurrentPlanetData',get_full_chart_analysis:'AllPlanetData'};
    if (map[name]) {
      const r=await fetch(`${VEDASTRO_BASE}/api/Calculate/${map[name]}`,{method:'POST',headers:h,body:JSON.stringify({BirthTime:dt,Location:{Latitude:lat,Longitude:lng},TimeZone:tz})});
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_planet_in_house'||name==='get_planet_in_sign') {
      const ep=name==='get_planet_in_house'?'PlanetHouseNumber':'PlanetRasiSign';
      const r=await fetch(`${VEDASTRO_BASE}/api/Calculate/${ep}/${args.planet}`,{method:'POST',headers:h,body:JSON.stringify({BirthTime:dt,Location:{Latitude:lat,Longitude:lng},TimeZone:tz})});
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_current_dasha') {
      const r=await fetch(`${VEDASTRO_BASE}/api/Calculate/CurrentDasha`,{method:'POST',headers:h,body:JSON.stringify({BirthTime:dt,TargetTime:args.targetDate||new Date().toISOString(),Location:{Latitude:lat,Longitude:lng},TimeZone:tz})});
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_dasha_timeline') {
      const r=await fetch(`${VEDASTRO_BASE}/api/Calculate/DashaTimeline`,{method:'POST',headers:h,body:JSON.stringify({BirthTime:dt,Location:{Latitude:lat,Longitude:lng},TimeZone:tz,StartYear:args.startYear,EndYear:args.endYear})});
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    return {error:`미구현: ${name}`};
  } catch(e) { return {error:e.message}; }
}

// ── L2 Google Cloud 실행 ────────────────────────────────────────
const L2 = new Set(['gcloud_submit','cloudbuild_status','cloudrun_services','artifact_list','cloudrun_set_env']);

async function execGCloud(name, args) {
  const project = args.project || GCP_PROJECT;
  const region  = args.region  || GCP_REGION;
  const token   = await getGCPToken();
  if (!token) return { error: 'GCP 인증 실패. Cloud Run 서비스 계정 권한 확인 필요.' };

  // Cloud Build로 gcloud 명령어 실행
  if (name === 'gcloud_submit') {
    const steps = args.commands.map(cmd => ({
      name: 'gcr.io/google.com/cloudsdktool/cloud-sdk',
      entrypoint: 'bash',
      args: ['-c', cmd],
    }));
    const r = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${project}/builds`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ steps, options: { logging: 'CLOUD_LOGGING_ONLY' } }),
    });
    if (!r.ok) return { error: `Cloud Build API ${r.status}: ${await r.text()}` };
    const data = await r.json();
    const buildId = data.metadata?.build?.id || data.name?.split('/').pop();
    return { buildId, status: 'QUEUED', message: '빌드 제출 완료. cloudbuild_status로 결과 확인.', commands: args.commands };
  }

  // 빌드 상태 조회
  if (name === 'cloudbuild_status') {
    const r = await fetch(`https://cloudbuild.googleapis.com/v1/projects/${project}/builds/${args.buildId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) return { error: `Cloud Build ${r.status}` };
    const data = await r.json();
    return {
      status:   data.status,
      id:       data.id,
      steps:    (data.steps||[]).map(s => ({ name:s.name, status:s.status, timing:s.timing })),
      logUrl:   data.logUrl,
      duration: data.timing?.BUILD?.endTime,
    };
  }

  // Cloud Run 서비스 목록
  if (name === 'cloudrun_services') {
    const r = await fetch(`https://run.googleapis.com/v2/projects/${project}/locations/${region}/services`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!r.ok) return { error: `Cloud Run API ${r.status}` };
    const data = await r.json();
    return { services: (data.services||[]).map(s => ({
      name:     s.name?.split('/').pop(),
      url:      s.uri,
      traffic:  s.traffic,
      revision: s.latestReadyRevision?.split('/').pop(),
      updated:  s.updateTime,
    })) };
  }

  // Artifact Registry 이미지 목록
  if (name === 'artifact_list') {
    const location = args.location || GCP_REGION;
    const repo     = args.repository || '';
    const url = repo
      ? `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${location}/repositories/${repo}/dockerImages`
      : `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${location}/repositories`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    if (!r.ok) return { error: `Artifact Registry ${r.status}: ${await r.text()}` };
    const data = await r.json();
    return data;
  }

  // Cloud Run 환경변수 설정
  if (name === 'cloudrun_set_env') {
    const { service, envVars } = args;
    // 현재 서비스 조회
    const getR = await fetch(`https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${service}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!getR.ok) return { error: `Cloud Run GET ${getR.status}` };
    const svc = await getR.json();
    // 기존 env에 새 값 병합
    const existingEnv = svc.template?.containers?.[0]?.env || [];
    const envMap = {};
    existingEnv.forEach(e => { envMap[e.name] = e.value; });
    Object.assign(envMap, envVars);
    const newEnv = Object.entries(envMap).map(([name, value]) => ({ name, value }));
    // PATCH
    const patchR = await fetch(`https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${service}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template: { containers: [{ ...svc.template?.containers?.[0], env: newEnv }] } }),
    });
    if (!patchR.ok) return { error: `Cloud Run PATCH ${patchR.status}: ${await patchR.text()}` };
    return { success: true, service, updatedVars: Object.keys(envVars), message: '환경변수 업데이트 완료. 새 revision 배포 중.' };
  }

  return { error: `미구현 L2 도구: ${name}` };
}

// ── L3 System Ops 실행 ──────────────────────────────────────────
async function execSystem(name, args) {
  if (name === 'github_read_file') {
    if (!GITHUB_PAT) return { error: 'GITHUB_PAT 환경변수 미설정' };
    const { repo, path, branch='main' } = args;
    const r = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`, { headers:ghHeaders() });
    if (!r.ok) return { error: `GitHub ${r.status}: ${await r.text()}` };
    const d = await r.json();
    return { path:d.path, sha:d.sha, size:d.size, content: Buffer.from(d.content,'base64').toString('utf8') };
  }

  if (name === 'github_write_file') {
    if (!GITHUB_PAT) return { error: 'GITHUB_PAT 환경변수 미설정' };
    const { repo, path, content, message, branch='main' } = args;
    let sha;
    const ex = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`, { headers:ghHeaders() });
    if (ex.ok) sha = (await ex.json()).sha;
    const r = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}`, {
      method:'PUT', headers:ghHeaders(),
      body: JSON.stringify({ message, content:Buffer.from(content).toString('base64'), branch, ...(sha?{sha}:{}) }),
    });
    if (!r.ok) return { error: `GitHub ${r.status}: ${await r.text()}` };
    const d = await r.json();
    return { success:true, commit:d.commit?.sha, url:d.content?.html_url, message, note:'Cloud Build 자동배포 트리거됨' };
  }

  if (name === 'github_list_files') {
    if (!GITHUB_PAT) return { error: 'GITHUB_PAT 환경변수 미설정' };
    const { repo, path='', branch='main' } = args;
    const r = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`, { headers:ghHeaders() });
    if (!r.ok) return { error: `GitHub ${r.status}` };
    const d = await r.json();
    return { files: (Array.isArray(d)?d:[d]).map(f=>({name:f.name,type:f.type,size:f.size,path:f.path})) };
  }

  if (name === 'sheets_read') {
    const token = await getGoogleOAuthToken() || await getGCPToken();
    if (!token) return { error: 'Google 인증 실패' };
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(args.range)}`, { headers:{'Authorization':`Bearer ${token}`} });
    if (!r.ok) return { error: `Sheets ${r.status}` };
    const d = await r.json();
    return { values:d.values||[], range:d.range };
  }

  if (name === 'sheets_write') {
    const token = await getGoogleOAuthToken() || await getGCPToken();
    if (!token) return { error: 'Google 인증 실패' };
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(args.range)}?valueInputOption=USER_ENTERED`, {
      method:'PUT', headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({ values:args.values }),
    });
    if (!r.ok) return { error: `Sheets ${r.status}` };
    return await r.json();
  }

  if (name === 'http_request') {
    const { url, method='GET', body, headers={} } = args;
    const opts = { method, headers:{'Content-Type':'application/json',...headers} };
    if (body && method!=='GET') opts.body = JSON.stringify(body);
    const r = await fetch(url, opts);
    try { return { status:r.status, ok:r.ok, data:await r.json() }; }
    catch { return { status:r.status, ok:r.ok, data:await r.text() }; }
  }

  if (name === 'get_system_status') {
    const [mcp] = await Promise.allSettled([
      fetch('https://mcp-server-611151539232.asia-northeast3.run.app/').then(r=>r.json())
    ]);
    return {
      mcp_server:   mcp.status==='fulfilled' ? { ok:true, server:mcp.value?.server, tools:mcp.value?.totalTools } : { ok:false },
      github_pat:   GITHUB_PAT ? '✓' : '✗ 미설정',
      google_oauth: process.env.GOOGLE_REFRESH_TOKEN ? '✓' : '✗ 미설정',
      gcp_adc:      (await getGCPToken()) ? '✓ ADC 정상' : '✗ ADC 실패',
      timestamp:    new Date().toISOString(),
    };
  }

  return { error: `알 수 없는 도구: ${name}` };
}

// ── 통합 라우터 ─────────────────────────────────────────────────
async function executeTool(name, args) {
  console.log(`🔧 [Tool:${L0.has(name)?'L0':L2.has(name)?'L2':'L3'}] ${name}`);
  if (L0.has(name)) return await execVedAstro(name, args);
  if (L2.has(name)) return await execGCloud(name, args);
  return await execSystem(name, args);
}

// ── SSE Transport ───────────────────────────────────────────────
app.get('/sse', requireMcpAuth, (req, res) => {
  const sid = `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no');
  res.write(`event: endpoint\ndata: /message?sessionId=${sid}\n\n`);
  sessions.set(sid, res);
  req.on('close', () => sessions.delete(sid));
  console.log(`[SSE] ${sid}`);
});

app.post('/message', requireMcpAuth, async (req, res) => {
  const sseRes = sessions.get(req.query.sessionId);
  if (!sseRes) return res.status(404).json({ error:'세션 없음' });
  const { id, method, params } = req.body || {};
  const send = d => sseRes.write(`data: ${JSON.stringify(d)}\n\n`);
  try {
    if (method==='initialize')
      send({ jsonrpc:'2.0', id, result:{ protocolVersion:'2025-03-26', capabilities:{tools:{}}, serverInfo:{name:'ASTERION AI Evolution Engine',version:'4.0.0'} } });
    else if (method==='tools/list')
      send({ jsonrpc:'2.0', id, result:{ tools:ALL_TOOLS.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})) } });
    else if (method==='tools/call')
      send({ jsonrpc:'2.0', id, result:{ content:[{type:'text',text:JSON.stringify(await executeTool(params?.name, params?.arguments||{}),null,2)}] } });
    else if (method==='ping')
      send({ jsonrpc:'2.0', id, result:{} });
    else if (method!=='notifications/initialized')
      send({ jsonrpc:'2.0', id, error:{code:-32601,message:`Method not found: ${method}`} });
    res.status(200).end();
  } catch(e) {
    send({ jsonrpc:'2.0', id, error:{code:-32603,message:e.message} });
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
    if (method==='initialize')                return ok({ protocolVersion:'2025-03-26', capabilities:{tools:{}}, serverInfo:{name:'ASTERION AI Evolution Engine',version:'4.0.0'} });
    if (method==='notifications/initialized') return res.status(200).json({jsonrpc:'2.0'});
    if (method==='tools/list')                return ok({ tools:ALL_TOOLS.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})) });
    if (method==='tools/call')                return ok({ content:[{type:'text',text:JSON.stringify(await executeTool(params?.name, params?.arguments||{}),null,2)}] });
    if (method==='ping')                      return ok({});
    return err(-32601, `Method not found: ${method}`);
  } catch(e) { return res.status(500).json({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}}); }
});

// ── 헬스체크 ────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
  status:'running', server:'ASTERION AI Evolution Engine v4.0',
  layers:{ L0:`VedAstro 천문계산 (${L0.size})`, L2:`Google Cloud 제어 (${L2.size})`, L3:`System Ops (${ALL_TOOLS.length-L0.size-L2.size})` },
  totalTools: ALL_TOOLS.length,
  toolList: ALL_TOOLS.map(t=>t.name),
  capabilities:{
    github:  GITHUB_PAT?'✓':'✗ GITHUB_PAT 미설정',
    google:  process.env.GOOGLE_REFRESH_TOKEN?'✓ OAuth':'ADC 자동',
    gcp_adc: 'Cloud Run 서비스계정 자동',
  },
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔱 ASTERION AI Evolution Engine v4.0 | port:${PORT}`);
  console.log(`   L0(VedAstro):${L0.size} | L2(GCloud):${L2.size} | L3(Ops):${ALL_TOOLS.length-L0.size-L2.size} | 합계:${ALL_TOOLS.length}`);
  console.log(`   GitHub: ${GITHUB_PAT?'✓':'✗'}  |  GCP ADC: 자동\n`);
});
