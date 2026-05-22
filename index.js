/**
 * ASTERION AI Evolution Engine v5.8
 *
 * v5.8 변경사항:
 * ★ 앵커링 방지 가이드라인: critical_issues를 검증 의제로 프레이밍
 *   - 이전 라운드 결론을 확인하는 방향이 아닌 독립 재검증 요청으로 전달
 *   - "결론 확인"이 아닌 "주장 검증" 프레이밍
 * ★ 알림 재설계: sclass_reached·rubric_held 제거
 *   - 관리자 개입이 필요한 알림만 유지: info_request(추가질문), phase_confirm(Phase 구간 확인)
 *   - 5라운드 실패 후 알림은 질문 생성 완료 시 btr_write_notification으로 1회만 발송
 *   - S-Class 달성/Held 전환 시 Archive 업데이트만 수행 (이중 알림 방지)
 * ★ fetchWithTimeout 헬퍼: 모든 외부 HTTP 요청 타임아웃 처리
 * ★ gh_push_files 도구: 여러 파일을 한 번의 커밋으로 GitHub에 push
 * v5.7: save_runtime_snapshot P1 + btr_write_notification/btr_finalize P2
 */

import express from 'express';
import cors from 'cors';

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', true);

const MCP_SECRET_KEY  = process.env.MCP_SECRET_KEY  || '';
const GITHUB_PAT      = process.env.GITHUB_PAT      || '';
const GITHUB_OWNER    = process.env.GITHUB_OWNER    || 'victuar918';
const GCP_PROJECT     = process.env.GCP_PROJECT     || 'asterion-server';
const GCP_REGION      = process.env.GCP_REGION      || 'asia-northeast3';
const VEDASTRO_BASE   = 'https://api.vedastro.org/api';
const VEDASTRO_KEY    = process.env.VEDASTRO_API_KEY || '';
const ARCHIVE_SS_ID   = '1ym1cgr1apEyTlqtJXqrfdnLjoyJTh086CjGycMcUOS8';
const RUNTIME_SHEET   = 'BTRRuntime';
const NOTIF_SHEET     = 'BTRNotifications';
const MCP_URL         = 'https://mcp-server-611151539232.asia-northeast3.run.app';

// ★ v5.8: fetchWithTimeout — 모든 외부 HTTP 요청 타임아웃 처리
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    return r;
  } catch(e) {
    if(e.name === 'AbortError') throw new Error(`요청 타임아웃 (${timeoutMs/1000}s) — ${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function requireMcpAuth(req, res, next) {
  if (!MCP_SECRET_KEY) return next();
  const t = req.headers['authorization']?.replace(/^Bearer\s+/i,'') || req.headers['x-mcp-token'];
  if (t !== MCP_SECRET_KEY) return res.status(401).json({ error:'Unauthorized' });
  next();
}
const sessions = new Map();

async function getGCPToken() {
  try {
    const r = await fetchWithTimeout('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers:{'Metadata-Flavor':'Google'} }, 5000);
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}
async function getGoogleOAuthToken() {
  const rt=process.env.GOOGLE_REFRESH_TOKEN, cid=process.env.GOOGLE_CLIENT_ID, cs=process.env.GOOGLE_CLIENT_SECRET;
  if (!rt||!cid||!cs) return null;
  try {
    const r = await fetchWithTimeout('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type:'refresh_token',refresh_token:rt,client_id:cid,client_secret:cs}) }, 10000);
    return r.ok ? (await r.json()).access_token : null;
  } catch { return null; }
}
async function getGoogleToken() { return await getGoogleOAuthToken() || await getGCPToken(); }
const ghH = () => ({ 'Authorization':`Bearer ${GITHUB_PAT}`, 'Accept':'application/vnd.github.v3+json', 'User-Agent':'ASTERION', 'Content-Type':'application/json' });
function vedPath(la, lo, t, d, tz) { return `/Location/${la},${lo}/Time/${t}/${d}/${tz}/Ayanamsa/LAHIRI`; }
async function vedFetch(url) {
  const h = VEDASTRO_KEY ? {'Authorization':`Bearer ${VEDASTRO_KEY}`} : {};
  const r = await fetchWithTimeout(url, {headers:h}, 25000);
  if (!r.ok) throw new Error(`VedAstro ${r.status}`);
  const j = await r.json();
  if (j.Status !== 'Pass') throw new Error(`VedAstro: ${JSON.stringify(j.Payload)}`);
  return j.Payload;
}

// ────────────────────────────────────────────────────────────
// 내부 헬퍼
// ────────────────────────────────────────────────────────────

// BTRNotifications 시트에 알림 행 작성
// ★ v5.8: 관리자 개입 필요 알림만 (info_request, phase_confirm)
async function writeNotification(tok, session_id, type, title, content) {
  const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  const row = [id, session_id, type, title, content, 'pending', new Date().toISOString()];
  await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(NOTIF_SHEET+'!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method:'POST', headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},
      body: JSON.stringify({majorDimension:'ROWS', values:[row]}) }
  );
  return id;
}

// Archive 시트에서 StructureCode 행 찾아 업데이트
async function updateArchiveRow(tok, structure_code, updates) {
  const r = await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent('Archive')}`,
    { headers:{Authorization:`Bearer ${tok}`} }
  );
  if (!r.ok) return {error:`Archive 읽기 실패 ${r.status}`};
  const rows = ((await r.json()).values) || [];
  const hdr  = rows[0] || [];
  const idx  = k => hdr.indexOf(k);
  const ri   = rows.findIndex((row, i) => i > 0 && row[0] === structure_code);
  if (ri < 0) return {error:`구조코드 없음: ${structure_code}`};
  const row = [...rows[ri]];
  while (row.length < hdr.length) row.push('');
  Object.entries(updates).forEach(([k, v]) => {
    const i = idx(k);
    if (i >= 0) row[i] = v == null ? '' : String(v);
  });
  await fetchWithTimeout(
    `https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent('Archive!A'+(ri+1))}?valueInputOption=USER_ENTERED`,
    { method:'PUT', headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},
      body: JSON.stringify({values:[row]}) }
  );
  return {success:true, row_index:ri};
}

const ALL_TOOLS = [
  // ── L0: VedAstro ──
  {name:'geocode_location',description:'출생지를 위도/경도로 변환.',inputSchema:{type:'object',properties:{location:{type:'string'}},required:['location']}},
  {name:'get_timezone',description:'위도/경도+날짜로 타임존 반환.',inputSchema:{type:'object',properties:{latitude:{type:'number'},longitude:{type:'number'},dateTime:{type:'string'}},required:['latitude','longitude','dateTime']}},
  {name:'get_planet_positions',description:'행성 D1 라시·도수·역행.',inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']}},
  {name:'get_house_positions',description:'12하우스 커스프.',inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']}},
  {name:'get_navamsa_chart',description:'D9(나밤샤) 차트.',inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']}},
  {name:'get_ascendant',description:'라그나(상승점).',inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']}},
  {name:'get_planet_in_house',description:'특정 행성 하우스 번호.',inputSchema:{type:'object',properties:{planet:{type:'string'},dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['planet','dateTime','latitude','longitude']}},
  {name:'get_planet_in_sign',description:'특정 행성 라시.',inputSchema:{type:'object',properties:{planet:{type:'string'},dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['planet','dateTime','latitude','longitude']}},
  {name:'get_current_dasha',description:'현재 비심다샤.',inputSchema:{type:'object',properties:{birthDateTime:{type:'string'},targetDate:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['birthDateTime','latitude','longitude']}},
  {name:'get_dasha_timeline',description:'전체 비심다샤 타임라인.',inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'},startYear:{type:'number'},endYear:{type:'number'}},required:['dateTime','latitude','longitude']}},
  {name:'get_dasha_sandhi',description:'다샤 Sandhi 날짜.',inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']}},
  {name:'get_birth_nakshatra',description:'출생 낙샤트라.',inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']}},
  {name:'get_planet_yogas',description:'주요 요가 분석.',inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']}},
  {name:'get_transit_planets',description:'트랜짓 행성.',inputSchema:{type:'object',properties:{targetDate:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['targetDate','latitude','longitude']}},
  {name:'get_full_chart_analysis',description:'전체 베딕 차트 종합.',inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']}},
  {name:'get_horoscope_predictions',description:'베다 점성술 종합 예측 200+.',inputSchema:{type:'object',properties:{birth_date:{type:'string'},birth_time:{type:'string'},latitude:{type:'string'},longitude:{type:'string'},timezone:{type:'string'}},required:['birth_date','birth_time','latitude','longitude','timezone']}},
  {name:'get_match_report',description:'두 차트 궁합 분석.',inputSchema:{type:'object',properties:{person1_date:{type:'string'},person1_time:{type:'string'},person1_lat:{type:'string'},person1_lng:{type:'string'},person1_tz:{type:'string'},person2_date:{type:'string'},person2_time:{type:'string'},person2_lat:{type:'string'},person2_lng:{type:'string'},person2_tz:{type:'string'}},required:['person1_date','person1_time','person1_lat','person1_lng','person1_tz','person2_date','person2_time','person2_lat','person2_lng','person2_tz']}},
  {name:'get_numerology_prediction',description:'수비학 예측.',inputSchema:{type:'object',properties:{name:{type:'string'},birth_date:{type:'string'}},required:['name','birth_date']}},
  {name:'get_ashtakvarga_data',description:'아슈타크바르가 차트.',inputSchema:{type:'object',properties:{birth_date:{type:'string'},birth_time:{type:'string'},latitude:{type:'string'},longitude:{type:'string'},timezone:{type:'string'}},required:['birth_date','birth_time','latitude','longitude','timezone']}},
  {name:'astro_check_retrograde',description:'행성 역행 여부.',inputSchema:{type:'object',properties:{planet:{type:'string'},dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['planet','dateTime','latitude','longitude']}},
  {name:'astro_planetary_war_check',description:'그라하 유다(행성 전쟁) 감지.',inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']}},

  // ── L1: BTR ──
  {name:'create_btr_session',description:'BTR 분석 세션 초기화.',inputSchema:{type:'object',properties:{structure_code:{type:'string'},birth_data:{type:'string'},parent_folder_id:{type:'string'}},required:['structure_code','birth_data']}},
  {name:'save_runtime_snapshot',description:'BTR 라운드 상태 저장. critical_issues/suggestions/analysis_summary를 저장하면 다음 라운드 컨텍스트로 전달됨 (앵커링 방지 가이드라인 적용됨).',inputSchema:{type:'object',properties:{
    session_id:{type:'string'},
    round:{type:'number'},
    candidate_slots:{type:'array',items:{type:'string'}},
    agreement_score:{type:'number'},
    entropy_score:{type:'number'},
    conflict_axis:{type:'string'},
    next_action:{type:'string',enum:['L0_physics','rubric_continue','question_generation','full_reset','sclass_validation','report_generation']},
    status:{type:'string',enum:['ACTIVE','QUESTION_MODE','RESET','SCLASS_REACHED','HELD']},
    gem_score:{type:'number'},
    cl_score:{type:'number'},
    gpt_score:{type:'number'},
    critical_issues:{type:'array',items:{type:'string'},description:'이 라운드에서 검증이 불충분했던 항목 목록. 다음 라운드에서 독립적으로 재검증됨 (결론이 아닌 검증 의제로 전달).'},
    suggestions:{type:'array',items:{type:'string'},description:'다음 라운드에서 살펴볼 분석 방향 (방법론적 제안, 결론 유도 금지).'},
    analysis_summary:{type:'string',description:'이 라운드 핵심 이견 요약. 다음 라운드에 독립 재검증 요청으로 전달됨.'}
  },required:['session_id','round','candidate_slots','agreement_score','entropy_score','next_action']}},
  {name:'get_runtime_snapshot',description:'BTRRuntime 세션 조회. critical_issues/suggestions/analysis_summary 포함.',inputSchema:{type:'object',properties:{session_id:{type:'string'}},required:['session_id']}},
  {name:'purge_runtime_state',description:'BTRRuntime 세션 삭제.',inputSchema:{type:'object',properties:{session_id:{type:'string'}},required:['session_id']}},
  {name:'save_evolution_log',description:'BTR 진화 로그 Drive 저장.',inputSchema:{type:'object',properties:{session_id:{type:'string'},evolution_folder_id:{type:'string'},round:{type:'number'},log_data:{type:'object'}},required:['session_id','evolution_folder_id','round','log_data']}},
  {name:'get_evolution_history',description:'BTR 로그 파일 목록.',inputSchema:{type:'object',properties:{evolution_folder_id:{type:'string'}},required:['evolution_folder_id']}},
  {name:'validate_sclass_gate',description:'S-Class 조건 확인: 세 AI 97점↑ AND critical_issues 없음.',inputSchema:{type:'object',properties:{session_id:{type:'string'},gem_score:{type:'number'},cl_score:{type:'number'},gpt_score:{type:'number'},critical_issues:{type:'array',items:{type:'string'}}},required:['session_id','gem_score','cl_score','gpt_score','critical_issues']}},
  {name:'btr_init_candidate_slots',description:'BTR 초기 후보 생시 슬롯.',inputSchema:{type:'object',properties:{birth_time_estimate:{type:'string'},range_minutes:{type:'number'},interval_minutes:{type:'number'}},required:['birth_time_estimate']}},
  {name:'btr_consensus_analyzer',description:'세 AI 루브릭 점수 종합.',inputSchema:{type:'object',properties:{gem_analysis:{type:'string'},cl_analysis:{type:'string'},gpt_analysis:{type:'string'},gem_score:{type:'number'},cl_score:{type:'number'},gpt_score:{type:'number'}},required:['gem_analysis','cl_analysis','gpt_analysis','gem_score','cl_score','gpt_score']}},
  {name:'btr_conflict_axis_finder',description:'세 AI 갈등 축 식별.',inputSchema:{type:'object',properties:{analyses:{type:'array',items:{type:'string'}},scores:{type:'array',items:{type:'number'}}},required:['analyses','scores']}},
  {name:'btr_re_eval_pivots',description:'후보 슬롯 재평가.',inputSchema:{type:'object',properties:{candidate_slots:{type:'array',items:{type:'string'}},conflict_axis:{type:'string'},pivot_criteria:{type:'string'}},required:['candidate_slots','conflict_axis']}},
  {name:'btr_weight_adjuster',description:'루브릭 가중치 조정.',inputSchema:{type:'object',properties:{event_count:{type:'number'},has_appearance_data:{type:'boolean'},has_career_data:{type:'boolean'},session_id:{type:'string'}},required:['event_count','has_appearance_data','has_career_data','session_id']}},
  {name:'btr_prediction_tester',description:'미래 예측 테스트.',inputSchema:{type:'object',properties:{candidate_time:{type:'string'},birth_date:{type:'string'},latitude:{type:'string'},longitude:{type:'string'},timezone:{type:'string'},test_period_years:{type:'number'}},required:['candidate_time','birth_date','latitude','longitude','timezone']}},

  // ★ v5.8 알림 재설계: 관리자 개입 필요 알림만 (info_request, phase_confirm)
  // sclass_reached/rubric_held 제거 — S-Class 달성·Held 전환은 Archive 업데이트만 수행
  {name:'btr_write_notification',description:'BTRNotifications 시트에 관리자 개입 알림 작성. info_request(추가정보 요청) 또는 phase_confirm(Phase 구간 확인 요청)만 사용.',inputSchema:{type:'object',properties:{
    session_id:{type:'string'},
    type:{type:'string',enum:['info_request','phase_confirm'],description:'info_request: 추가 정보/질문 필요. phase_confirm: Phase 시작·종료 구간 관리자 확인 필요.'},
    title:{type:'string',description:'알림 카드 제목'},
    content:{type:'string',description:'알림 상세 내용 (질문 목록 또는 Phase 구간 정보)'}
  },required:['session_id','type','title','content']}},

  // ★ v5.8: btr_finalize_confirmed — Archive 업데이트만, 알림 없음 (관리자 개입 불필요)
  {name:'btr_finalize_confirmed',description:'★ S-Class Hard Stop 완료 처리. Archive BTRStatus→Confirmed + AnalysisScore/AnalysisDocs/BTR 기록. 알림 없음 (관리자 개입 불필요).',inputSchema:{type:'object',properties:{
    session_id:{type:'string'},
    structure_code:{type:'string'},
    confirmed_birth_time:{type:'string'},
    final_score:{type:'number'},
    analysis_doc_url:{type:'string'},
    gem_score:{type:'number'},
    cl_score:{type:'number'},
    gpt_score:{type:'number'}
  },required:['session_id','structure_code','confirmed_birth_time','final_score']}},

  // ★ v5.8: btr_finalize_held — Archive 업데이트만, 알림 없음 (질문 생성 후 info_request로 1회만)
  {name:'btr_finalize_held',description:'★ Held 상태 완료 처리. Archive BTRStatus→Held 기록. 알림 없음 (추가질문 생성 완료 후 btr_write_notification(type:info_request)로 1회만 발송할 것).',inputSchema:{type:'object',properties:{
    session_id:{type:'string'},
    structure_code:{type:'string'},
    failure_summary:{type:'string'},
    highest_score:{type:'number'},
    best_candidate_time:{type:'string'}
  },required:['session_id','structure_code','failure_summary']}},

  // ── L2: GCloud ──
  {name:'gcloud_submit',description:'Cloud Build로 gcloud 실행.',inputSchema:{type:'object',properties:{commands:{type:'array',items:{type:'string'}},project:{type:'string'}},required:['commands']}},
  {name:'cloudbuild_status',description:'Cloud Build 빌드 상태.',inputSchema:{type:'object',properties:{buildId:{type:'string'},project:{type:'string'}},required:['buildId']}},
  {name:'cloudrun_services',description:'Cloud Run 서비스 목록.',inputSchema:{type:'object',properties:{project:{type:'string'},region:{type:'string'}},required:[]}},
  {name:'artifact_list',description:'Artifact Registry 이미지 목록.',inputSchema:{type:'object',properties:{repository:{type:'string'},project:{type:'string'},location:{type:'string'}},required:[]}},
  {name:'cloudrun_set_env',description:'Cloud Run 환경변수 설정.',inputSchema:{type:'object',properties:{service:{type:'string'},envVars:{type:'object'},project:{type:'string'},region:{type:'string'}},required:['service','envVars']}},
  {name:'agent_registry_list',description:'★ Agent Registry 서비스 목록 직접 조회.',inputSchema:{type:'object',properties:{location:{type:'string'},project:{type:'string'}},required:[]}},
  {name:'agent_registry_register',description:'★ Agent Registry에 MCP 서버 직접 등록. TOOL_SPEC content+inputSchema로 78개 도구 포함.',inputSchema:{type:'object',properties:{display_name:{type:'string'},endpoint_url:{type:'string'},location:{type:'string'},service_id:{type:'string'},project:{type:'string'}},required:[]}},

  // ── L3: SystemOps ──
  {name:'github_read_file',description:'GitHub 파일 읽기.',inputSchema:{type:'object',properties:{repo:{type:'string'},path:{type:'string'},branch:{type:'string'}},required:['repo','path']}},
  {name:'github_write_file',description:'★ GitHub 파일 쓰기 → 자동배포.',inputSchema:{type:'object',properties:{repo:{type:'string'},path:{type:'string'},content:{type:'string'},message:{type:'string'},branch:{type:'string'}},required:['repo','path','content','message']}},
  {name:'github_list_files',description:'GitHub 파일 목록.',inputSchema:{type:'object',properties:{repo:{type:'string'},path:{type:'string'},branch:{type:'string'}},required:['repo']}},
  // ★ v5.8 신규: 여러 파일을 한 번의 커밋으로 push (대규모 업데이트에 효율적)
  {name:'gh_push_files',description:'★ 여러 파일을 한 번의 커밋으로 GitHub에 push. ROADMAP+index.js 동시 업데이트 등에 사용.',inputSchema:{type:'object',properties:{
    repo:{type:'string'},
    branch:{type:'string',description:'기본값: main'},
    message:{type:'string',description:'커밋 메시지'},
    files:{type:'array',items:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']},description:'push할 파일 목록'}
  },required:['repo','message','files']}},
  {name:'sheets_read',description:'Google Sheets 읽기.',inputSchema:{type:'object',properties:{spreadsheetId:{type:'string'},range:{type:'string'}},required:['spreadsheetId','range']}},
  {name:'sheets_write',description:'Google Sheets 쓰기.',inputSchema:{type:'object',properties:{spreadsheetId:{type:'string'},range:{type:'string'},values:{type:'array',items:{type:'array',items:{type:'string'}}}},required:['spreadsheetId','range','values']}},
  {name:'http_request',description:'임의 HTTP 요청.',inputSchema:{type:'object',properties:{url:{type:'string'},method:{type:'string',enum:['GET','POST','PUT','PATCH','DELETE']},body:{type:'object'},headers:{type:'object'}},required:['url']}},
  {name:'get_system_status',description:'ASTERION 전체 시스템 상태.',inputSchema:{type:'object',properties:{},required:[]}},
  {name:'append_sheet_row',description:'Google Sheets 행 추가.',inputSchema:{type:'object',properties:{spreadsheetId:{type:'string'},range:{type:'string'},values:{type:'array',items:{type:'string'}}},required:['spreadsheetId','range','values']}},

  // ── L4: Workspace ──
  {name:'read_google_doc',description:'Google Docs 텍스트 추출.',inputSchema:{type:'object',properties:{document_id:{type:'string'}},required:['document_id']}},
  {name:'create_google_doc',description:'Google Docs 생성.',inputSchema:{type:'object',properties:{title:{type:'string'},content:{type:'string'},folder_id:{type:'string'}},required:['title']}},
  {name:'create_spreadsheet',description:'Google Sheets 생성.',inputSchema:{type:'object',properties:{title:{type:'string'},sheet_name:{type:'string'},folder_id:{type:'string'}},required:['title']}},
  {name:'export_doc_as_pdf',description:'Google Docs → PDF.',inputSchema:{type:'object',properties:{document_id:{type:'string'},pdf_filename:{type:'string'},folder_id:{type:'string'}},required:['document_id','pdf_filename','folder_id']}},
  {name:'delete_drive_file',description:'Drive 파일 삭제.',inputSchema:{type:'object',properties:{file_id:{type:'string'}},required:['file_id']}},
  {name:'create_drive_folder',description:'Drive 폴더 생성.',inputSchema:{type:'object',properties:{name:{type:'string'},parent_folder_id:{type:'string'}},required:['name']}},
  {name:'delete_drive_folder',description:'Drive 폴더 삭제.',inputSchema:{type:'object',properties:{folder_id:{type:'string'}},required:['folder_id']}},
  {name:'list_drive_contents',description:'Drive 폴더 내용.',inputSchema:{type:'object',properties:{folder_id:{type:'string'},mime_type_filter:{type:'string'},max_results:{type:'number'}},required:[]}},
  {name:'list_script_projects',description:'GAS 프로젝트 목록.',inputSchema:{type:'object',properties:{max_results:{type:'number'}},required:[]}},
  {name:'get_script_content',description:'GAS 소스코드 조회.',inputSchema:{type:'object',properties:{script_id:{type:'string'}},required:['script_id']}},
  {name:'update_script_file',description:'★ GAS 파일 업데이트.',inputSchema:{type:'object',properties:{script_id:{type:'string'},filename:{type:'string'},source:{type:'string'},type:{type:'string',enum:['SERVER_JS','HTML','JSON']}},required:['script_id','filename','source']}},
  {name:'deploy_script_webapp',description:'GAS 웹앱 배포.',inputSchema:{type:'object',properties:{script_id:{type:'string'},description:{type:'string'},access:{type:'string',enum:['MYSELF','DOMAIN','ANYONE','ANYONE_ANONYMOUS']}},required:['script_id']}},
  {name:'backup_script_project',description:'GAS Drive 백업.',inputSchema:{type:'object',properties:{script_id:{type:'string'},backup_folder_id:{type:'string'}},required:['script_id']}},
  {name:'delete_artifact_image',description:'Artifact Registry 이미지 삭제.',inputSchema:{type:'object',properties:{image_path:{type:'string'}},required:['image_path']}},
  {name:'list_run_revisions',description:'Cloud Run 리비전 목록.',inputSchema:{type:'object',properties:{service_name:{type:'string'},project:{type:'string'},region:{type:'string'}},required:[]}},
  {name:'delete_run_revision',description:'Cloud Run 리비전 삭제.',inputSchema:{type:'object',properties:{revision_name:{type:'string'},project:{type:'string'},region:{type:'string'}},required:['revision_name']}},
  {name:'create_btr_report_doc',description:'BTR 보고서 Google Docs 생성.',inputSchema:{type:'object',properties:{structure_code:{type:'string'},analysis_content:{type:'string'},folder_id:{type:'string'}},required:['structure_code','analysis_content','folder_id']}},

  // ── L5: AI ──
  {name:'call_gemini',description:'Gemini AI 직접 호출. BTR 파이프라인에서 독립 분석가로 동작 (역할 주입 없음, 컨텍스트 주입 방식).',inputSchema:{type:'object',properties:{prompt:{type:'string'},system_prompt:{type:'string'},model:{type:'string'},previous_round_context:{type:'object',description:'이전 라운드 컨텍스트 (선택). 앵커링 방지: 검증 의제로 전달됨.'}},required:['prompt']}},
  {name:'call_claude',description:'Claude AI 직접 호출. BTR 파이프라인에서 독립 분석가로 동작 (역할 주입 없음, 컨텍스트 주입 방식).',inputSchema:{type:'object',properties:{prompt:{type:'string'},system_prompt:{type:'string'},model:{type:'string'},max_tokens:{type:'number'},previous_round_context:{type:'object',description:'이전 라운드 컨텍스트 (선택). 앵커링 방지: 검증 의제로 전달됨.'}},required:['prompt']}},
  {name:'call_gpt',description:'GPT AI 직접 호출.',inputSchema:{type:'object',properties:{prompt:{type:'string'},system_prompt:{type:'string'},model:{type:'string'},max_tokens:{type:'number'}},required:['prompt']}},

  // ── L6: Report/Ops ──
  {name:'report_generate_btr_code',description:'BTR 확정 코드 생성.',inputSchema:{type:'object',properties:{session_id:{type:'string'},structure_code:{type:'string'},confirmed_birth_time:{type:'string'},confidence_score:{type:'number'}},required:['session_id','structure_code','confirmed_birth_time','confidence_score']}},
  {name:'report_generate_summary',description:'BTR 결과 요약.',inputSchema:{type:'object',properties:{session_id:{type:'string'},evolution_folder_id:{type:'string'}},required:['session_id','evolution_folder_id']}},
  {name:'report_add_gemstone_advice',description:'원석 배치 조언.',inputSchema:{type:'object',properties:{structure_code:{type:'string'},birth_data:{type:'string'},gemstone_preferences:{type:'string'}},required:['structure_code','birth_data']}},
  {name:'ops_audit_log_exporter',description:'BTR 감사 로그 내보내기.',inputSchema:{type:'object',properties:{session_id:{type:'string'},export_format:{type:'string',enum:['sheets','drive_json']},target_id:{type:'string'}},required:['session_id','export_format']}},
  {name:'ops_pattern_match_failure',description:'BTR 5라운드 실패 패턴 분석.',inputSchema:{type:'object',properties:{session_id:{type:'string'},failed_analyses:{type:'array',items:{type:'string'}},birth_data:{type:'string'}},required:['session_id','failed_analyses','birth_data']}},
];

const L0=new Set(['geocode_location','get_timezone','get_planet_positions','get_house_positions','get_navamsa_chart','get_ascendant','get_planet_in_house','get_planet_in_sign','get_current_dasha','get_dasha_timeline','get_dasha_sandhi','get_birth_nakshatra','get_planet_yogas','get_transit_planets','get_full_chart_analysis','get_horoscope_predictions','get_match_report','get_numerology_prediction','get_ashtakvarga_data','astro_check_retrograde','astro_planetary_war_check']);
const L1=new Set(['create_btr_session','save_runtime_snapshot','get_runtime_snapshot','purge_runtime_state','save_evolution_log','get_evolution_history','validate_sclass_gate','btr_init_candidate_slots','btr_consensus_analyzer','btr_conflict_axis_finder','btr_re_eval_pivots','btr_weight_adjuster','btr_prediction_tester','btr_write_notification','btr_finalize_confirmed','btr_finalize_held']);
// ★ v5.8: gh_push_files 추가 (L3: 8→9개)
const L2=new Set(['gcloud_submit','cloudbuild_status','cloudrun_services','artifact_list','cloudrun_set_env','agent_registry_list','agent_registry_register']);
const L3=new Set(['github_read_file','github_write_file','github_list_files','gh_push_files','sheets_read','sheets_write','http_request','get_system_status','append_sheet_row']);
const L4=new Set(['read_google_doc','create_google_doc','create_spreadsheet','export_doc_as_pdf','delete_drive_file','create_drive_folder','delete_drive_folder','list_drive_contents','list_script_projects','get_script_content','update_script_file','deploy_script_webapp','backup_script_project','delete_artifact_image','list_run_revisions','delete_run_revision','create_btr_report_doc']);
const L5=new Set(['call_gemini','call_claude','call_gpt']);
const L6=new Set(['report_generate_btr_code','report_generate_summary','report_add_gemstone_advice','ops_audit_log_exporter','ops_pattern_match_failure']);

// ★ v5.8 앵커링 방지 컨텍스트 빌더
// 핵심 원칙: 이전 라운드 정보를 "결론"이 아닌 "검증 의제"로 전달
// "이전 라운드에서 X라고 결론났다" → "X가 충분히 검증됐는지 독립 재확인 필요"
function buildAntiAnchoredContext(previous_round_context) {
  if (!previous_round_context) return '';
  const { round, critical_issues, suggestions, analysis_summary } = previous_round_context;
  const lines = [`\n\n<prev_round_verification_agenda round="${round||'?'}">`];
  lines.push(`<!-- ★ 앵커링 방지 원칙: 아래는 이전 라운드의 결론이 아닌 독립 재검증 의제입니다.`);
  lines.push(`     이전 결론을 확인하거나 수정하는 방향으로 접근하지 마십시오.`);
  lines.push(`     아래 항목들을 처음 보는 것처럼 독립적으로 재분석하십시오. -->`);
  if (analysis_summary) {
    lines.push(`  <round_summary>이전 라운드 메모 (참고만): ${analysis_summary}</round_summary>`);
  }
  if (critical_issues && critical_issues.length > 0) {
    lines.push(`  <items_requiring_independent_verification>`);
    critical_issues.forEach(issue => {
      lines.push(`    <item>검증 필요: ${issue} (이전 라운드의 주장 — 독립적으로 재평가할 것)</item>`);
    });
    lines.push(`  </items_requiring_independent_verification>`);
  }
  if (suggestions && suggestions.length > 0) {
    lines.push(`  <methodological_suggestions>`);
    suggestions.forEach(s => {
      lines.push(`    <suggestion>${s}</suggestion>`);
    });
    lines.push(`  </methodological_suggestions>`);
  }
  lines.push(`</prev_round_verification_agenda>`);
  return lines.join('\n');
}

async function execVedAstro(n, a) {
  try {
    const la=String(a.latitude||a.lat||''),lo=String(a.longitude||a.lng||''),tz=a.timezone||'+09:00',dt=a.dateTime||a.birthDateTime||a.targetDate||'';
    const bd=a.birth_date||'',bt=a.birth_time||'',btz=a.timezone||'+09:00';
    if(n==='geocode_location'){const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/Location/Name/${encodeURIComponent(a.location)}/0/0`);return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_timezone'){const r=await fetchWithTimeout(`${VEDASTRO_BASE}/api/Calculate/TimeZone/Location/${la}/${lo}/Time/${encodeURIComponent(dt)}`);return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_horoscope_predictions')return await vedFetch(`${VEDASTRO_BASE}/Calculate/HoroscopePredictions${vedPath(la,lo,bt,bd,btz)}`);
    if(n==='get_numerology_prediction'){const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/NumerologyPrediction/${encodeURIComponent(a.name)}/${a.birth_date}`);return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_match_report'){const p1=vedPath(a.person1_lat,a.person1_lng,a.person1_time,a.person1_date,a.person1_tz),p2=vedPath(a.person2_lat,a.person2_lng,a.person2_time,a.person2_date,a.person2_tz);const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/CompatibilityReport${p1}${p2}`);return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_ashtakvarga_data'){const tp=vedPath(la,lo,bt,bd,btz);const[s,b]=await Promise.all([vedFetch(`${VEDASTRO_BASE}/Calculate/SarvashtakavargaChart${tp}`),vedFetch(`${VEDASTRO_BASE}/Calculate/BhinnashtakavargaChart${tp}`)]);return{SarvashtakavargaChart:s,BhinnashtakavargaChart:b};}
    if(n==='astro_check_retrograde')return await vedFetch(`${VEDASTRO_BASE}/Calculate/IsPlanetRetrograde/${a.planet}${vedPath(la,lo,'00:00',dt.split('T')[0]||dt,tz)}`);
    if(n==='astro_planetary_war_check')return await vedFetch(`${VEDASTRO_BASE}/Calculate/PlanetaryWar${vedPath(la,lo,'00:00',dt,tz)}`);
    const map={get_planet_positions:'AllPlanetData',get_house_positions:'AllHouseData',get_navamsa_chart:'NavamsaChart',get_ascendant:'AscendantSign',get_planet_yogas:'AllYogas',get_dasha_sandhi:'DashaSandhi',get_birth_nakshatra:'BirthNakshatra',get_transit_planets:'CurrentPlanetData',get_full_chart_analysis:'AllPlanetData'};
    if(map[n]){const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/${map[n]}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({BirthTime:dt,Location:{Latitude:parseFloat(la),Longitude:parseFloat(lo)},TimeZone:tz})});return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_planet_in_house'||n==='get_planet_in_sign'){const ep=n==='get_planet_in_house'?'PlanetHouseNumber':'PlanetRasiSign';const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/${ep}/${a.planet}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({BirthTime:dt,Location:{Latitude:parseFloat(la),Longitude:parseFloat(lo)},TimeZone:tz})});return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_current_dasha'){const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/CurrentDasha`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({BirthTime:dt,TargetTime:a.targetDate||new Date().toISOString(),Location:{Latitude:parseFloat(la),Longitude:parseFloat(lo)},TimeZone:tz})});return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_dasha_timeline'){const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/DashaTimeline`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({BirthTime:dt,Location:{Latitude:parseFloat(la),Longitude:parseFloat(lo)},TimeZone:tz,StartYear:a.startYear,EndYear:a.endYear})});return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    return {error:`미구현: ${n}`};
  } catch(e){return{error:`${n}: ${e.message}`};}
}

async function execBTR(n,a){
  const tok=await getGoogleToken();
  if(!tok&&!['btr_init_candidate_slots','btr_consensus_analyzer','btr_conflict_axis_finder','validate_sclass_gate'].includes(n))return{error:'Google 인증 실패'};

  if(n==='btr_init_candidate_slots'){
    const[h,m]=a.birth_time_estimate.split(':').map(Number);
    const rng=a.range_minutes||120,iv=a.interval_minutes||15,sl=[];
    for(let o=-rng;o<=rng;o+=iv){const t=h*60+m+o;sl.push(`${Math.floor(((t%1440)+1440)%1440/60).toString().padStart(2,'0')}:${(((t%1440)+1440)%60).toString().padStart(2,'0')}`)}
    return{candidate_slots:[...new Set(sl)],count:new Set(sl).size};
  }
  if(n==='btr_consensus_analyzer'){
    const s=[a.gem_score,a.cl_score,a.gpt_score],avg=s.reduce((x,y)=>x+y,0)/3,v=s.reduce((x,y)=>x+Math.pow(y-avg,2),0)/3;
    return{agreement_score:+(avg/100).toFixed(3),entropy_score:+(v/1000).toFixed(3),avg_score:+avg.toFixed(1),consensus:avg>=97?'S_CLASS_CANDIDATE':'CONTINUE'};
  }
  if(n==='btr_conflict_axis_finder'){
    const mn=Math.min(...a.scores),mx=Math.max(...a.scores);
    return{score_range:mx-mn,conflict_detected:mx-mn>15,conflict_axis:mx-mn>15?'score_divergence_critical':'minor_variation'};
  }
  if(n==='validate_sclass_gate'){
    const s=[a.gem_score,a.cl_score,a.gpt_score],ap=s.every(x=>x>=97),nc=!a.critical_issues||a.critical_issues.length===0,p=ap&&nc;
    if(tok)await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({majorDimension:'ROWS',values:[[a.session_id,'sclass_gate_check',String(p),a.gem_score,a.cl_score,a.gpt_score,(a.critical_issues||[]).join(','),new Date().toISOString()]]})}).catch(()=>{});
    return{session_id:a.session_id,sclass_passed:p,all_above_97:ap,no_critical_issues:nc,action:p?'CONFIRM_BTR':'CONTINUE_RUBRIC'};
  }
  if(n==='create_btr_session'){
    const ts=new Date().toISOString(),sid=`BTR-${a.structure_code}-${Date.now()}`,fb={name:sid,mimeType:'application/vnd.google-apps.folder'};
    if(a.parent_folder_id)fb.parents=[a.parent_folder_id];
    const fr=await fetchWithTimeout('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify(fb)});
    if(!fr.ok)return{error:`폴더 생성 실패 ${fr.status}`};
    const f=await fr.json();
    await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({majorDimension:'ROWS',values:[[sid,a.structure_code,'0','false','[]','0','1.0','','L0_physics','ACTIVE',ts,ts,f.id,ts,'INIT','','','','','','']]})});
    return{success:true,session_id:sid,evolution_folder_id:f.id,evolution_folder_url:f.webViewLink};
  }
  if(n==='save_runtime_snapshot'){
    const ts=new Date().toISOString();
    const rr=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${tok}`}});
    if(!rr.ok)return{error:`읽기 실패 ${rr.status}`};
    const rows=((await rr.json()).values)||[],hdr=rows[0]||[],ri=rows.findIndex((r,i)=>i>0&&r[0]===a.session_id);
    if(ri<0)return{error:`세션 없음: ${a.session_id}`};
    const idx=k=>hdr.indexOf(k),row=[...rows[ri]];
    ['round','candidate_slots','agreement_score','entropy_score','conflict_axis','next_action','status','gem_score','cl_score','gpt_score'].forEach(k=>{
      const i=idx(k);if(i>=0&&a[k]!=null)row[i]=typeof a[k]==='object'?JSON.stringify(a[k]):String(a[k]);
    });
    ['critical_issues','suggestions'].forEach(k=>{
      const i=idx(k);if(i>=0&&a[k]!=null)row[i]=Array.isArray(a[k])?JSON.stringify(a[k]):String(a[k]);
    });
    const aiIdx=idx('analysis_summary');
    if(aiIdx>=0&&a.analysis_summary!=null)row[aiIdx]=String(a.analysis_summary);
    if(idx('updated_at')>=0)row[idx('updated_at')]=ts;
    await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A'+(ri+1))}?valueInputOption=RAW`,{method:'PUT',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
    return{success:true,session_id:a.session_id,saved_fields:Object.keys(a).filter(k=>k!=='session_id')};
  }
  if(n==='get_runtime_snapshot'){
    const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${tok}`}});
    if(!r.ok)return{error:`읽기 실패 ${r.status}`};
    const rows=((await r.json()).values)||[],hdr=rows[0]||[],row=rows.find((r,i)=>i>0&&r[0]===a.session_id);
    if(!row)return{error:'세션 없음'};
    const snap=Object.fromEntries(hdr.map((k,i)=>[k,row[i]||'']));
    try{if(snap.critical_issues)snap.critical_issues=JSON.parse(snap.critical_issues);}catch{}
    try{if(snap.suggestions)snap.suggestions=JSON.parse(snap.suggestions);}catch{}
    return snap;
  }
  if(n==='save_evolution_log'){
    const c=JSON.stringify({session_id:a.session_id,round:a.round,...a.log_data,timestamp:new Date().toISOString()},null,2),fn=`R${String(a.round).padStart(2,'0')}_${Date.now()}.json`,meta=JSON.stringify({name:fn,parents:[a.evolution_folder_id],mimeType:'application/json'}),body=`--b\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--b\r\nContent-Type: application/json\r\n\r\n${c}\r\n--b--`;
    const r=await fetchWithTimeout('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'multipart/related; boundary=b'},body});
    if(!r.ok)return{error:`저장 실패 ${r.status}`};
    return{success:true,file_id:(await r.json()).id,filename:fn};
  }
  if(n==='get_evolution_history'){
    const r=await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files?q='${a.evolution_folder_id}'+in+parents&orderBy=name&fields=files(id,name,modifiedTime,size)`,{headers:{Authorization:`Bearer ${tok}`}});
    return r.ok?await r.json():{error:`폴더 조회 실패 ${r.status}`};
  }
  if(n==='btr_re_eval_pivots')return{evaluated_slots:a.candidate_slots,conflict_axis:a.conflict_axis};
  if(n==='btr_weight_adjuster')return{session_id:a.session_id,adjusted_weights:{event_bukhti_fit:a.event_count>=3?40:25,d9_alignment:20,appearance_temperament:a.has_appearance_data?15:8,sandhi_transition:15,logic_consistency_bonus:10}};
  if(n==='btr_prediction_tester')return{candidate_time:a.candidate_time,status:'MANUAL_VERIFICATION_RECOMMENDED'};
  if(n==='purge_runtime_state'){
    const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${tok}`}});
    if(!r.ok)return{error:'읽기 실패'};
    const rows=((await r.json()).values)||[],idx=rows.findIndex((r,i)=>i>0&&r[0]===a.session_id);
    if(idx<0)return{error:'세션 없음'};
    await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A'+(idx+1))}?valueInputOption=RAW`,{method:'PUT',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[Array(rows[0]?.length||21).fill('')]})});
    return{success:true};
  }

  // ★ v5.8: 알림 — 관리자 개입 필요한 경우만 (info_request, phase_confirm)
  if(n==='btr_write_notification'){
    const notifId = await writeNotification(tok, a.session_id, a.type, a.title, a.content);
    return{success:true, notification_id:notifId, type:a.type};
  }

  // ★ v5.8: Confirmed — Archive 업데이트만, 알림 없음
  if(n==='btr_finalize_confirmed'){
    const updates = {
      BTRStatus:'Confirmed',
      AnalysisScore:String(a.final_score),
      ...(a.analysis_doc_url?{AnalysisDocs:a.analysis_doc_url}:{}),
      ...(a.confirmed_birth_time?{BTR:a.confirmed_birth_time}:{}),
    };
    const result = await updateArchiveRow(tok, a.structure_code, updates);
    if(result.error) return{error:'Archive 업데이트 실패: '+result.error};
    return{
      success:true,
      structure_code:a.structure_code,
      btr_status:'Confirmed',
      confirmed_birth_time:a.confirmed_birth_time,
      analysis_score:a.final_score,
      note:'알림 없음 — 관리자 개입 불필요. Phase 구간 확인 필요 시 btr_write_notification(phase_confirm) 별도 호출.'
    };
  }

  // ★ v5.8: Held — Archive 업데이트만, 알림 없음 (질문 생성 후 info_request로 1회만)
  if(n==='btr_finalize_held'){
    const noteContent = [
      a.failure_summary,
      a.highest_score ? `최고점수: ${a.highest_score}점` : null,
      a.best_candidate_time ? `유력후보: ${a.best_candidate_time}` : null,
    ].filter(Boolean).join(' | ');
    await updateArchiveRow(tok, a.structure_code, {BTRStatus:'Held',...(noteContent?{BTRStageNote:noteContent}:{})}).catch(()=>{});
    return{
      success:true,
      structure_code:a.structure_code,
      btr_status:'Held',
      note:'알림 없음 — 추가질문 생성 완료 후 btr_write_notification(type:info_request)로 1회만 발송할 것.'
    };
  }
  return{error:`미구현: ${n}`};
}

async function execGCloud(n,a){
  const proj=a.project||GCP_PROJECT,reg=a.region||GCP_REGION;
  const tok=await getGCPToken();
  if(!tok)return{error:'GCP ADC 인증 실패'};
  if(n==='gcloud_submit'){const steps=a.commands.map(cmd=>({name:'gcr.io/google.com/cloudsdktool/cloud-sdk',entrypoint:'bash',args:['-c',cmd]}));const r=await fetchWithTimeout(`https://cloudbuild.googleapis.com/v1/projects/${proj}/builds`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({steps,options:{logging:'CLOUD_LOGGING_ONLY'}})},30000);if(!r.ok)return{error:`Cloud Build ${r.status}: ${await r.text()}`};const d=await r.json();return{buildId:d.metadata?.build?.id||d.name?.split('/').pop(),status:'QUEUED'};}
  if(n==='cloudbuild_status'){const r=await fetchWithTimeout(`https://cloudbuild.googleapis.com/v1/projects/${proj}/builds/${a.buildId}`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)return{error:`CloudBuild ${r.status}`};const d=await r.json();return{status:d.status,id:d.id,steps:(d.steps||[]).map(s=>({name:s.name,status:s.status,timing:s.timing})),logUrl:d.logUrl};}
  if(n==='cloudrun_services'){const r=await fetchWithTimeout(`https://run.googleapis.com/v2/projects/${proj}/locations/${reg}/services`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)return{error:`Cloud Run ${r.status}`};const d=await r.json();return{services:(d.services||[]).map(s=>({name:s.name?.split('/').pop(),url:s.uri,revision:s.latestReadyRevision?.split('/').pop(),updated:s.updateTime}))};}
  if(n==='artifact_list'){const loc=a.location||GCP_REGION,url=a.repository?`https://artifactregistry.googleapis.com/v1/projects/${proj}/locations/${loc}/repositories/${a.repository}/dockerImages`:`https://artifactregistry.googleapis.com/v1/projects/${proj}/locations/${loc}/repositories`;const r=await fetchWithTimeout(url,{headers:{Authorization:`Bearer ${tok}`}});return r.ok?await r.json():{error:`Artifact ${r.status}`};}
  if(n==='cloudrun_set_env'){const{service,envVars}=a,gr=await fetchWithTimeout(`https://run.googleapis.com/v2/projects/${proj}/locations/${reg}/services/${service}`,{headers:{Authorization:`Bearer ${tok}`}});if(!gr.ok)return{error:`Cloud Run GET ${gr.status}`};const svc=await gr.json(),em={};(svc.template?.containers?.[0]?.env||[]).forEach(e=>{em[e.name]=e.value;});Object.assign(em,envVars);const pr=await fetchWithTimeout(`https://run.googleapis.com/v2/projects/${proj}/locations/${reg}/services/${service}`,{method:'PATCH',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({template:{containers:[{...svc.template?.containers?.[0],env:Object.entries(em).map(([k,v])=>({name:k,value:v}))}]}})});if(!pr.ok)return{error:`Cloud Run PATCH ${pr.status}: ${await pr.text()}`};return{success:true,service,updatedVars:Object.keys(envVars)};}
  if(n==='agent_registry_list'){const loc=a.location||GCP_REGION,res={};const r1=await fetchWithTimeout(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/${loc}/services`,{headers:{Authorization:`Bearer ${tok}`}});const t1=await r1.text();res[loc]={status:r1.status,ok:r1.ok,data:r1.ok?(()=>{try{return JSON.parse(t1);}catch{return t1;}})():t1};if(loc!=='global'){const r2=await fetchWithTimeout(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/global/services`,{headers:{Authorization:`Bearer ${tok}`}});const t2=await r2.text();res['global']={status:r2.status,ok:r2.ok,data:r2.ok?(()=>{try{return JSON.parse(t2);}catch{return t2;}})():t2};}return res;}
  if(n==='agent_registry_register'){const loc=a.location||GCP_REGION,endpointUrl=a.endpoint_url||`${MCP_URL}/mcp`,displayName=a.display_name||'ASTERION AI Evolution Engine',serviceId=a.service_id||'asterion-mcp';const delR=await fetchWithTimeout(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/${loc}/services/${serviceId}`,{method:'DELETE',headers:{Authorization:`Bearer ${tok}`}});console.log(`[AgentRegistry] 기존 삭제: ${delR.status}`);const toolContent={tools:ALL_TOOLS.map(t=>({name:t.name,description:t.description,inputSchema:{type:'object'}}))};const body={displayName,interfaces:[{url:endpointUrl,protocolBinding:'JSONRPC'}],mcpServerSpec:{type:'TOOL_SPEC',content:toolContent}};const r=await fetchWithTimeout(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/${loc}/services?serviceId=${serviceId}`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const text=await r.text();let parsed;try{parsed=JSON.parse(text);}catch{parsed=text;}if(r.ok&&parsed.name){let op=parsed;for(let i=0;i<15&&!op.done;i++){await new Promise(res=>setTimeout(res,2000));const pr=await fetchWithTimeout(`https://agentregistry.googleapis.com/v1alpha/${op.name}`,{headers:{Authorization:`Bearer ${tok}`}});if(pr.ok)op=await pr.json();}return{status:r.status,ok:r.ok,location:loc,endpoint:endpointUrl,serviceId,tools_count:ALL_TOOLS.length,operation_done:op.done,operation_error:op.error||null,result:op.response||op};}return{status:r.status,ok:r.ok,location:loc,endpoint:endpointUrl,serviceId,response:parsed};}
  return{error:`미구현: ${n}`};
}

async function execSystem(n,a){
  if(n==='github_read_file'){if(!GITHUB_PAT)return{error:'GITHUB_PAT 미설정'};const{repo,path,branch='main'}=a;const r=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,{headers:ghH()},15000);if(!r.ok)return{error:`GitHub ${r.status}: ${await r.text()}`};const d=await r.json();return{path:d.path,sha:d.sha,size:d.size,content:Buffer.from(d.content,'base64').toString('utf8')};}
  if(n==='github_write_file'){if(!GITHUB_PAT)return{error:'GITHUB_PAT 미설정'};const{repo,path,content,message,branch='main'}=a;let sha;const ex=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,{headers:ghH()},15000);if(ex.ok)sha=(await ex.json()).sha;const r=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}`,{method:'PUT',headers:ghH(),body:JSON.stringify({message,content:Buffer.from(content).toString('base64'),branch,...(sha?{sha}:{})})},20000);if(!r.ok)return{error:`GitHub ${r.status}: ${await r.text()}`};const d=await r.json();return{success:true,commit:d.commit?.sha,note:'Cloud Build 자동배포 트리거됨'};}
  if(n==='github_list_files'){if(!GITHUB_PAT)return{error:'GITHUB_PAT 미설정'};const{repo,path='',branch='main'}=a;const r=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,{headers:ghH()},15000);if(!r.ok)return{error:`GitHub ${r.status}`};const d=await r.json();return{files:(Array.isArray(d)?d:[d]).map(f=>({name:f.name,type:f.type,size:f.size,path:f.path}))};}

  // ★ v5.8: gh_push_files — 여러 파일 한 번의 커밋
  if(n==='gh_push_files'){
    if(!GITHUB_PAT)return{error:'GITHUB_PAT 미설정'};
    const{repo,branch='main',message,files}=a;
    if(!files||!files.length)return{error:'files 배열 필요'};
    const h=ghH();
    // 1. 현재 HEAD SHA
    const refR=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/ref/heads/${branch}`,{headers:h},15000);
    if(!refR.ok)return{error:`브랜치 조회 실패 ${refR.status}`};
    const headSha=(await refR.json()).object.sha;
    // 2. 현재 트리 SHA
    const commitR=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/commits/${headSha}`,{headers:h},15000);
    if(!commitR.ok)return{error:`커밋 조회 실패 ${commitR.status}`};
    const treeSha=(await commitR.json()).tree.sha;
    // 3. 새 트리 생성
    const treeItems=files.map(f=>({path:f.path,mode:'100644',type:'blob',content:f.content}));
    const treeR=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/trees`,{method:'POST',headers:h,body:JSON.stringify({base_tree:treeSha,tree:treeItems})},20000);
    if(!treeR.ok)return{error:`트리 생성 실패 ${treeR.status}: ${await treeR.text()}`};
    const newTreeSha=(await treeR.json()).sha;
    // 4. 새 커밋 생성
    const newCommitR=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/commits`,{method:'POST',headers:h,body:JSON.stringify({message,tree:newTreeSha,parents:[headSha]})},15000);
    if(!newCommitR.ok)return{error:`커밋 생성 실패 ${newCommitR.status}`};
    const newCommitSha=(await newCommitR.json()).sha;
    // 5. 브랜치 ref 업데이트
    const updateR=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/refs/heads/${branch}`,{method:'PATCH',headers:h,body:JSON.stringify({sha:newCommitSha,force:false})},15000);
    if(!updateR.ok)return{error:`브랜치 업데이트 실패 ${updateR.status}`};
    return{success:true,commit:newCommitSha,files_count:files.length,files:files.map(f=>f.path)};
  }

  if(['sheets_read','sheets_write','append_sheet_row'].includes(n)){const tok=await getGoogleToken();if(!tok)return{error:'Google 인증 실패'};if(n==='sheets_read'){const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/${encodeURIComponent(a.range)}`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)return{error:`Sheets ${r.status}`};const d=await r.json();return{values:d.values||[],range:d.range};}if(n==='sheets_write'){const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/${encodeURIComponent(a.range)}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:a.values})});return r.ok?await r.json():{error:`Sheets ${r.status}`};}if(n==='append_sheet_row'){const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/${encodeURIComponent(a.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[a.values]})});return r.ok?await r.json():{error:`Sheets ${r.status}`;}}  }
  if(n==='http_request'){const{url,method='GET',body,headers={}}=a;const opts={method,headers:{'Content-Type':'application/json',...headers}};if(body&&method!=='GET')opts.body=JSON.stringify(body);const r=await fetchWithTimeout(url,opts,30000);try{return{status:r.status,ok:r.ok,data:await r.json()};}catch{return{status:r.status,ok:r.ok,data:await r.text()};}}
  if(n==='get_system_status'){const[mcp]=await Promise.allSettled([fetchWithTimeout(`${MCP_URL}/`).then(r=>r.json())]);return{mcp_server:mcp.status==='fulfilled'?{ok:true,server:mcp.value?.server,tools:mcp.value?.totalTools}:{ok:false},github_pat:GITHUB_PAT?'✓':'✗',google_oauth:process.env.GOOGLE_REFRESH_TOKEN?'✓':'✗',gcp_adc:(await getGCPToken())?'✓ ADC 정상':'✗',timestamp:new Date().toISOString()};}
  return{error:`미구현: ${n}`};
}

async function execWorkspace(n,a){
  const tok=await getGoogleToken();
  if(!tok)return{error:'Google OAuth 인증 실패.'};
  if(n==='read_google_doc'){const r=await fetchWithTimeout(`https://docs.googleapis.com/v1/documents/${a.document_id}`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)return{error:`Docs ${r.status}: ${await r.text()}`};const d=await r.json();return{title:d.title,content:d.body.content.flatMap(b=>b.paragraph?.elements??[]).map(el=>el.textRun?.content??'').join('')};}
  if(n==='create_google_doc'){const r=await fetchWithTimeout('https://docs.googleapis.com/v1/documents',{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({title:a.title})});if(!r.ok)return{error:`Docs ${r.status}`};const d=await r.json();if(a.content)await fetchWithTimeout(`https://docs.googleapis.com/v1/documents/${d.documentId}:batchUpdate`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{insertText:{location:{index:1},text:a.content}}]})});if(a.folder_id)await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${d.documentId}?addParents=${a.folder_id}&fields=id`,{method:'PATCH',headers:{Authorization:`Bearer ${tok}`}}).catch(()=>{});return{document_id:d.documentId,title:d.title,url:`https://docs.google.com/document/d/${d.documentId}`};}
  if(n==='create_spreadsheet'){const r=await fetchWithTimeout('https://sheets.googleapis.com/v4/spreadsheets',{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({properties:{title:a.title},sheets:[{properties:{title:a.sheet_name||'Sheet1'}}]})});if(!r.ok)return{error:`Sheets ${r.status}`};const d=await r.json();if(a.folder_id)await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${d.spreadsheetId}?addParents=${a.folder_id}&fields=id`,{method:'PATCH',headers:{Authorization:`Bearer ${tok}`}}).catch(()=>{});return{spreadsheet_id:d.spreadsheetId,url:`https://docs.google.com/spreadsheets/d/${d.spreadsheetId}`};}
  if(n==='export_doc_as_pdf'){const pr=await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${a.document_id}/export?mimeType=application/pdf`,{headers:{Authorization:`Bearer ${tok}`}},30000);if(!pr.ok)return{error:`PDF 실패 ${pr.status}`};const pb=await pr.arrayBuffer(),meta=JSON.stringify({name:a.pdf_filename,parents:[a.folder_id],mimeType:'application/pdf'}),bd='b',body=new Uint8Array([...new TextEncoder().encode(`--${bd}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${bd}\r\nContent-Type: application/pdf\r\n\r\n`),...new Uint8Array(pb),...new TextEncoder().encode(`\r\n--${bd}--`)]);const ur=await fetchWithTimeout('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':`multipart/related; boundary=${bd}`},body});if(!ur.ok)return{error:`PDF 업로드 실패 ${ur.status}`};const f=await ur.json();return{file_id:f.id,filename:f.name,url:f.webViewLink};}
  if(['delete_drive_file','delete_drive_folder'].includes(n)){const id=a.file_id||a.folder_id;const r=await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${id}`,{method:'DELETE',headers:{Authorization:`Bearer ${tok}`}});return{success:r.ok||r.status===204,status:r.status};}
  if(n==='create_drive_folder'){const b={name:a.name,mimeType:'application/vnd.google-apps.folder'};if(a.parent_folder_id)b.parents=[a.parent_folder_id];const r=await fetchWithTimeout('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify(b)});if(!r.ok)return{error:`Drive ${r.status}`};const f=await r.json();return{folder_id:f.id,name:f.name,url:f.webViewLink};}
  if(n==='list_drive_contents'){const qp=[];if(a.folder_id)qp.push(`'${a.folder_id}' in parents`);if(a.mime_type_filter)qp.push(`mimeType='${a.mime_type_filter}'`);qp.push('trashed=false');const r=await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(qp.join(' and '))}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=${a.max_results||50}`,{headers:{Authorization:`Bearer ${tok}`}});return r.ok?await r.json():{error:`Drive ${r.status}`};}
  if(n==='list_script_projects'){const r=await fetchWithTimeout(`https://script.googleapis.com/v1/projects?pageSize=${a.max_results||20}`,{headers:{Authorization:`Bearer ${tok}`}});return r.ok?await r.json():{error:`GAS ${r.status}: ${await r.text()}`};}
  if(n==='get_script_content'){const r=await fetchWithTimeout(`https://script.googleapis.com/v1/projects/${a.script_id}/content`,{headers:{Authorization:`Bearer ${tok}`}});return r.ok?await r.json():{error:`GAS ${r.status}: ${await r.text()}`};}
  if(n==='update_script_file'){const gr=await fetchWithTimeout(`https://script.googleapis.com/v1/projects/${a.script_id}/content`,{headers:{Authorization:`Bearer ${tok}`}});if(!gr.ok)return{error:`읽기 실패 ${gr.status}`};const c=await gr.json(),files=c.files||[],idx=files.findIndex(f=>f.name===a.filename),fe={name:a.filename,type:a.type||'SERVER_JS',source:a.source};if(idx>=0)files[idx]=fe;else files.push(fe);const r=await fetchWithTimeout(`https://script.googleapis.com/v1/projects/${a.script_id}/content`,{method:'PUT',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({files})});return r.ok?{success:true,filename:a.filename}:{error:`업데이트 실패 ${r.status}: ${await r.text()}`};}
  if(n==='deploy_script_webapp'){const r=await fetchWithTimeout(`https://script.googleapis.com/v1/projects/${a.script_id}/deployments`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({versionNumber:null,manifestFileName:'appsscript',description:a.description||'Deploy',access:a.access||'ANYONE_ANONYMOUS'})});return r.ok?await r.json():{error:`배포 실패 ${r.status}: ${await r.text()}`};}
  if(n==='backup_script_project'){const cr=await fetchWithTimeout(`https://script.googleapis.com/v1/projects/${a.script_id}/content`,{headers:{Authorization:`Bearer ${tok}`}});if(!cr.ok)return{error:`읽기 실패 ${cr.status}`};const c=await cr.json(),bn=`GAS_backup_${a.script_id}_${Date.now()}.json`,meta=JSON.stringify({name:bn,parents:[a.backup_folder_id||'root'],mimeType:'application/json'}),body=`--b\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--b\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(c)}\r\n--b--`;const r=await fetchWithTimeout('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'multipart/related; boundary=b'},body});return r.ok?{success:true,backup_file_id:(await r.json()).id}:{error:`백업 저장 실패 ${r.status}`};}
  if(n==='delete_artifact_image'){const gt=await getGCPToken();if(!gt)return{error:'GCP ADC 실패'};const r=await fetchWithTimeout(`https://artifactregistry.googleapis.com/v1/${a.image_path}`,{method:'DELETE',headers:{Authorization:`Bearer ${gt}`}});return{success:r.ok,status:r.status};}
  if(n==='list_run_revisions'){const gt=await getGCPToken();if(!gt)return{error:'GCP ADC 실패'};const p=a.project||GCP_PROJECT,rg=a.region||GCP_REGION,svc=a.service_name||'mcp-server';const r=await fetchWithTimeout(`https://run.googleapis.com/v2/projects/${p}/locations/${rg}/services/${svc}/revisions`,{headers:{Authorization:`Bearer ${gt}`}});if(!r.ok)return{error:`Cloud Run ${r.status}`};const d=await r.json();return{revisions:(d.revisions||[]).map(rv=>({name:rv.name?.split('/').pop(),createTime:rv.createTime}))};}
  if(n==='delete_run_revision'){const gt=await getGCPToken();if(!gt)return{error:'GCP ADC 실패'};const p=a.project||GCP_PROJECT,rg=a.region||GCP_REGION;const r=await fetchWithTimeout(`https://run.googleapis.com/v2/projects/${p}/locations/${rg}/revisions/${a.revision_name}`,{method:'DELETE',headers:{Authorization:`Bearer ${gt}`}});return{success:r.ok,status:r.status};}
  if(n==='create_btr_report_doc'){const title=`BTR_Report_${a.structure_code}_${new Date().toISOString().slice(0,10)}`;const r=await fetchWithTimeout('https://docs.googleapis.com/v1/documents',{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({title})});if(!r.ok)return{error:`Docs ${r.status}`};const d=await r.json();if(a.analysis_content)await fetchWithTimeout(`https://docs.googleapis.com/v1/documents/${d.documentId}:batchUpdate`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{insertText:{location:{index:1},text:`${a.structure_code} BTR 분석 보고서\n\n${a.analysis_content}`}}]})});if(a.folder_id)await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${d.documentId}?addParents=${a.folder_id}&fields=id`,{method:'PATCH',headers:{Authorization:`Bearer ${tok}`}}).catch(()=>{});return{document_id:d.documentId,title,url:`https://docs.google.com/document/d/${d.documentId}`};}
  return{error:`미구현: ${n}`};
}

async function execAI(n,a){
  // ★ v5.8: 앵커링 방지 컨텍스트를 시스템 프롬프트에 주입
  const antiAnchoredCtx = buildAntiAnchoredContext(a.previous_round_context);

  if(n==='call_gemini'){
    const key=process.env.GEMINI_API_KEY;if(!key)return{error:'GEMINI_API_KEY 미설정'};
    const model=a.model||'gemini-3.1-pro-preview';
    // 기본 BTR 시스템 프롬프트 (영어 키워드 + XML, 앵커링 방지 원칙 포함)
    const defaultSys = `<role>ASTERION BTR rubric analyst — independent evaluator</role>
<rubric total="100">
  <criterion id="event_fit"   max="40" cap="lt3_events→max25"/>
  <criterion id="navamsa_d9"  max="20" note="rashi↔navamsa_no_contradiction"/>
  <criterion id="appearance"  max="15" cap="no_physique_data→max10"/>
  <criterion id="sandhi"      max="15" note="life_inflection↔sandhi_overlap"/>
  <criterion id="consistency" max="10" note="auto_if_3ai_core_conclusion_agree"/>
</rubric>
<hard_stop>all_scores≥97 AND critical_issues=[] → S-Class CONFIRMED</hard_stop>
<anti_anchoring_rule>
  CRITICAL: Evaluate INDEPENDENTLY from scratch each round.
  If previous_round_context is provided, treat each item as an UNVERIFIED CLAIM requiring fresh scrutiny.
  Do NOT start from previous conclusions. Do NOT confirm or refute — INDEPENDENTLY DERIVE.
  Previous round's critical_issues = verification agenda, NOT established facts.
</anti_anchoring_rule>
<output_format>
{
  "candidate_time": "HH:MM",
  "analysis": "string",
  "scores": {"event_fit":0,"navamsa_d9":0,"appearance":0,"sandhi":0,"consistency":0},
  "total": 0,
  "critical_issues": [],
  "suggestions": [],
  "confidence": "LOW|MEDIUM|HIGH"
}
</output_format>
<lang>Respond in Korean</lang>`;
    const sys = (a.system_prompt||defaultSys) + antiAnchoredCtx;
    const r=await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:a.prompt}]}],thinkingConfig:{thinkingLevel:'high'},generationConfig:{maxOutputTokens:8192,temperature:0.7}})},60000);
    if(!r.ok)throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0,200)}`);
    const d=await r.json();return{text:d.candidates?.[0]?.content?.parts?.[0]?.text||'',model};
  }

  if(n==='call_claude'){
    const key=process.env.ANTHROPIC_API_KEY;if(!key)return{error:'ANTHROPIC_API_KEY 미설정'};
    const model=a.model||'claude-sonnet-4-6';
    const defaultSys = `<role>ASTERION BTR rubric analyst — independent evaluator</role>
<rubric total="100">
  <criterion id="event_fit"   max="40" cap="lt3_events→max25"/>
  <criterion id="navamsa_d9"  max="20" note="rashi↔navamsa_no_contradiction"/>
  <criterion id="appearance"  max="15" cap="no_physique_data→max10"/>
  <criterion id="sandhi"      max="15" note="life_inflection↔sandhi_overlap"/>
  <criterion id="consistency" max="10" note="auto_if_3ai_core_conclusion_agree"/>
</rubric>
<hard_stop>all_scores≥97 AND critical_issues=[] → S-Class CONFIRMED</hard_stop>
<anti_anchoring_rule>
  CRITICAL: Evaluate INDEPENDENTLY from scratch each round.
  previous_round_context = verification agenda only. NOT conclusions to confirm.
  Derive your own assessment independently, then compare.
</anti_anchoring_rule>
<output_format>
{"candidate_time":"HH:MM","analysis":"string","scores":{"event_fit":0,"navamsa_d9":0,"appearance":0,"sandhi":0,"consistency":0},"total":0,"critical_issues":[],"suggestions":[],"confidence":"LOW|MEDIUM|HIGH"}
</output_format>
<lang>Respond in Korean</lang>`;
    const sys = (a.system_prompt||defaultSys) + antiAnchoredCtx;
    const r=await fetchWithTimeout('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model,max_tokens:a.max_tokens||8000,system:sys,thinking:{type:'enabled',budget_tokens:5000},messages:[{role:'user',content:a.prompt}]})},60000);
    if(!r.ok)throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0,200)}`);
    const d=await r.json();return{text:d.content?.find(b=>b.type==='text')?.text||'',model};
  }

  if(n==='call_gpt'){const key=process.env.OPENAI_API_KEY;if(!key)return{error:'OPENAI_API_KEY 미설정'};const model=a.model||'gpt-4o';const r=await fetchWithTimeout('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,max_tokens:a.max_tokens||8000,messages:[{role:'system',content:a.system_prompt||'베다 점성술 BTR 전문가.'},{role:'user',content:a.prompt}]})},60000);if(!r.ok)throw new Error(`GPT ${r.status}: ${(await r.text()).slice(0,200)}`);const d=await r.json();return{text:d.choices?.[0]?.message?.content||'',model};}
  return{error:`미구현: ${n}`};
}

async function execReportOps(n,a){
  const tok=await getGoogleToken();
  if(n==='report_generate_btr_code'){if(tok)await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent('BTRRuntime!A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({majorDimension:'ROWS',values:[[new Date().toISOString(),a.structure_code,'BTR_CONFIRMED',a.confirmed_birth_time,String(a.confidence_score),a.session_id]]})}).catch(()=>{});return{structure_code:a.structure_code,btr_confirmed:a.confirmed_birth_time,status:'CONFIRMED',note:'Archive 업데이트는 btr_finalize_confirmed 도구 사용'};}
  if(n==='report_generate_summary')return{session_id:a.session_id,action:'use_get_evolution_history_and_summarize'};
  if(n==='report_add_gemstone_advice')return{structure_code:a.structure_code,status:'MANUAL_ANALYSIS_REQUIRED'};
  if(n==='ops_audit_log_exporter'){if(!tok)return{error:'Google 인증 실패'};const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)return{error:`읽기 실패 ${r.status}`};const rows=((await r.json()).values)||[];return{exported:true,session_id:a.session_id,rows_count:rows.length};}
  if(n==='ops_pattern_match_failure')return{session_id:a.session_id,suggested_questions:['출생 당일 특이 사항?','오전/오후?','병원 기록?'],next_action:'QUESTION_MODE'};
  return{error:`미구현: ${n}`};
}

async function executeTool(name, args) {
  console.log(`🔧 [${L0.has(name)?'L0':L1.has(name)?'L1':L2.has(name)?'L2':L3.has(name)?'L3':L4.has(name)?'L4':L5.has(name)?'L5':'L6'}] ${name}`);
  if(L0.has(name))return await execVedAstro(name,args);
  if(L1.has(name))return await execBTR(name,args);
  if(L2.has(name))return await execGCloud(name,args);
  if(L3.has(name))return await execSystem(name,args);
  if(L4.has(name))return await execWorkspace(name,args);
  if(L5.has(name))return await execAI(name,args);
  if(L6.has(name))return await execReportOps(name,args);
  return{error:`알 수 없는 도구: ${name}`};
}

const toolList=ALL_TOOLS.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema}));

app.get('/sse',requireMcpAuth,(req,res)=>{
  const sid=`s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  res.setHeader('Content-Type','text/event-stream');res.setHeader('Cache-Control','no-cache');res.setHeader('Connection','keep-alive');res.setHeader('X-Accel-Buffering','no');
  res.write(`event: endpoint\ndata: /message?sessionId=${sid}\n\n`);
  sessions.set(sid,res);req.on('close',()=>sessions.delete(sid));
});
app.post('/message',requireMcpAuth,async(req,res)=>{
  const sseRes=sessions.get(req.query.sessionId);if(!sseRes)return res.status(404).json({error:'세션 없음'});
  const{id,method,params}=req.body||{},send=d=>sseRes.write(`data: ${JSON.stringify(d)}\n\n`);
  try{
    if(method==='initialize')send({jsonrpc:'2.0',id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.8.0'}}});
    else if(method==='tools/list')send({jsonrpc:'2.0',id,result:{tools:toolList}});
    else if(method==='tools/call'){const r=await executeTool(params?.name,params?.arguments||{});send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(r,null,2)}]}});}
    else if(method==='ping')send({jsonrpc:'2.0',id,result:{}});
    else if(method!=='notifications/initialized')send({jsonrpc:'2.0',id,error:{code:-32601,message:`Not found: ${method}`}});
    res.status(200).end();
  }catch(e){send({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}});res.status(200).end();}
});
app.all('/mcp',requireMcpAuth,async(req,res)=>{
  if(req.method==='OPTIONS'){res.setHeader('Allow','GET, POST, DELETE, OPTIONS');return res.status(204).end();}
  if(req.method==='DELETE')return res.status(200).json({jsonrpc:'2.0'});
  const body=req.method==='GET'?null:req.body,id=body?.id??null,method=body?.method;
  const ok=r=>res.json({jsonrpc:'2.0',id,result:r}),err=(c,m)=>res.json({jsonrpc:'2.0',id,error:{code:c,message:m}});
  try{
    if(req.method==='GET')return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.8.0'}});
    if(!body)return err(-32700,'Parse error');
    if(method==='initialize')return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.8.0'}});
    if(method==='notifications/initialized')return res.status(200).json({jsonrpc:'2.0'});
    if(method==='tools/list')return ok({tools:toolList});
    if(method==='tools/call'){const r=await executeTool(params?.name||body?.params?.name,params?.arguments||body?.params?.arguments||{});return ok({content:[{type:'text',text:JSON.stringify(r,null,2)}]});}
    if(method==='ping')return ok({});
    return err(-32601,`Not found: ${method}`);
  }catch(e){return res.status(500).json({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}});}
});
app.post('/',requireMcpAuth,async(req,res)=>{
  const body=req.body,id=body?.id??null,method=body?.method;
  const ok=r=>res.json({jsonrpc:'2.0',id,result:r}),err=(c,m)=>res.json({jsonrpc:'2.0',id,error:{code:c,message:m}});
  try{
    if(method==='initialize')return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.8.0'}});
    if(method==='notifications/initialized')return res.status(200).json({jsonrpc:'2.0'});
    if(method==='tools/list')return ok({tools:toolList});
    if(method==='tools/call'){const r=await executeTool(body?.params?.name,body?.params?.arguments||{});return ok({content:[{type:'text',text:JSON.stringify(r,null,2)}]});}
    if(method==='ping')return ok({});
    return err(-32601,`Not found: ${method}`);
  }catch(e){return res.status(500).json({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}});}
});
app.get('/',(_req,res)=>res.json({
  status:'running',server:'ASTERION AI Evolution Engine v5.8',
  transports:{mcp:'POST/GET/DELETE /mcp',sse:'GET /sse'},
  layers:{L0:`VedAstro(${L0.size})`,L1:`BTR(${L1.size})`,L2:`GCloud(${L2.size})`,L3:`SystemOps(${L3.size})`,L4:`Workspace(${L4.size})`,L5:`AI(${L5.size})`,L6:`Report/Ops(${L6.size})`},
  totalTools:ALL_TOOLS.length,toolList:ALL_TOOLS.map(t=>t.name)
}));
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`\n🔱 ASTERION AI Evolution Engine v5.8 | port:${PORT} | tools:${ALL_TOOLS.length}`);
  console.log(`   v5.8: 앵커링방지+알림재설계+fetchWithTimeout+gh_push_files\n`);
});
