/**
 * ================================================================
 * 🔱 ASTERION AI Evolution Engine v5.0
 * ================================================================
 * Transport:
 *   POST /mcp      → Streamable HTTP (Agent Registry, Claude.ai, ChatGPT)  ← NEW
 *   GET  /sse      → SSE (Hub SDK, Claude native connector)
 *   POST /message  → SSE 세션 메시지
 *   GET  /         → 헬스체크
 *
 * 도구 구성 (78개):
 *   L0: VedAstro 천문계산  (21개) — 기본 15 + 확장 6
 *   L1: BTR Pipeline      (13개) — create_btr_session, consensus, sclass 등
 *   L2: Google Cloud       (5개) — gcloud_submit, cloudrun, artifact
 *   L3: System Ops         (8개) — http, github, sheets, system_status
 *   L4: Google Workspace  (18개) — Drive, Docs, Sheets, GAS
 *   L5: AI 호출            (3개) — call_gemini, call_claude, call_gpt
 *   L6: Report/Ops         (8개) — report_*, ops_*
 *
 * GCP 인증: Cloud Run ADC (메타데이터 서버)
 * Google OAuth: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN
 * ================================================================
 */

import express from 'express';
import cors from 'cors';

const app  = express();
const PORT = process.env.PORT || 8080;
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.set('trust proxy', true);

// ── 상수 ────────────────────────────────────────────────────────
const MCP_SECRET_KEY  = process.env.MCP_SECRET_KEY  || '';
const GITHUB_PAT      = process.env.GITHUB_PAT      || '';
const GITHUB_OWNER    = process.env.GITHUB_OWNER    || 'victuar918';
const GCP_PROJECT     = process.env.GCP_PROJECT     || 'asterion-server';
const GCP_REGION      = process.env.GCP_REGION      || 'asia-northeast3';
const VEDASTRO_BASE   = 'https://api.vedastro.org/api';
const VEDASTRO_KEY    = process.env.VEDASTRO_API_KEY || '';
const ARCHIVE_SS_ID   = '1ym1cgr1apEyTlqtJXqrfdnLjoyJTh086CjGycMcUOS8';
const RUNTIME_SHEET   = 'BTRRuntime';

// ── 인증 ────────────────────────────────────────────────────────
function requireMcpAuth(req, res, next) {
  if (!MCP_SECRET_KEY) return next();
  const token = req.headers['authorization']?.replace(/^Bearer\s+/i,'') || req.headers['x-mcp-token'];
  if (token !== MCP_SECRET_KEY) return res.status(401).json({ error:'Unauthorized' });
  next();
}

const sessions = new Map();

async function getGCPToken() {
  try {
    const r = await fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', { headers:{'Metadata-Flavor':'Google'} });
    if (!r.ok) return null;
    return (await r.json()).access_token;
  } catch { return null; }
}

async function getGoogleOAuthToken() {
  const rt=process.env.GOOGLE_REFRESH_TOKEN, cid=process.env.GOOGLE_CLIENT_ID, cs=process.env.GOOGLE_CLIENT_SECRET;
  if (!rt||!cid||!cs) return null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body: new URLSearchParams({grant_type:'refresh_token',refresh_token:rt,client_id:cid,client_secret:cs}) });
    return r.ok ? (await r.json()).access_token : null;
  } catch { return null; }
}

async function getGoogleToken() {
  return await getGoogleOAuthToken() || await getGCPToken();
}

const ghHeaders = () => ({ 'Authorization':`Bearer ${GITHUB_PAT}`, 'Accept':'application/vnd.github.v3+json', 'User-Agent':'ASTERION-Evolution-Engine', 'Content-Type':'application/json' });

// ── VedAstro 헬퍼 ──────────────────────────────────────────────
function vedPath(lat, lng, time, date, tz) {
  return `/Location/${lat},${lng}/Time/${time}/${date}/${tz}/Ayanamsa/LAHIRI`;
}
async function vedFetch(url) {
  const headers = VEDASTRO_KEY ? { 'Authorization':`Bearer ${VEDASTRO_KEY}` } : {};
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`VedAstro HTTP ${r.status}`);
  const json = await r.json();
  if (json.Status !== 'Pass') throw new Error(`VedAstro 오류: ${JSON.stringify(json.Payload)}`);
  return json.Payload;
}

// ── 도구 정의 ───────────────────────────────────────────────────
const ALL_TOOLS = [
  // ════ L0: VedAstro 천문계산 (21개) ════
  { name:'geocode_location',        description:'출생지를 위도/경도로 변환.', inputSchema:{type:'object',properties:{location:{type:'string'}},required:['location']} },
  { name:'get_timezone',            description:'위도/경도+날짜로 DST 포함 타임존 반환.', inputSchema:{type:'object',properties:{latitude:{type:'number'},longitude:{type:'number'},dateTime:{type:'string'}},required:['latitude','longitude','dateTime']} },
  { name:'get_planet_positions',    description:'모든 행성 D1 라시·도수·역행 계산. Lahiri 아야남샤.', inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_house_positions',     description:'12하우스 커스프 위치와 라시 계산.', inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_navamsa_chart',       description:'D9(나밤샤) 차트 계산. BTR D-9 정렬 검증 필수.', inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_ascendant',           description:'라그나(상승점) 라시와 도수 반환.', inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_planet_in_house',     description:'특정 행성이 위치한 하우스 번호 반환.', inputSchema:{type:'object',properties:{planet:{type:'string'},dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['planet','dateTime','latitude','longitude']} },
  { name:'get_planet_in_sign',      description:'특정 행성이 위치한 라시(12궁) 반환.', inputSchema:{type:'object',properties:{planet:{type:'string'},dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['planet','dateTime','latitude','longitude']} },
  { name:'get_current_dasha',       description:'현재 비심다샤 기간 반환.', inputSchema:{type:'object',properties:{birthDateTime:{type:'string'},targetDate:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['birthDateTime','latitude','longitude']} },
  { name:'get_dasha_timeline',      description:'전체 비심다샤 타임라인. BTR 사건 부합성 검증 핵심.', inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'},startYear:{type:'number'},endYear:{type:'number'}},required:['dateTime','latitude','longitude']} },
  { name:'get_dasha_sandhi',        description:'다샤 전환점(Sandhi) 날짜 목록. BTR 15점.', inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_birth_nakshatra',     description:'출생 달의 낙샤트라 반환.', inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_planet_yogas',        description:'차트 주요 요가 분석.', inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  { name:'get_transit_planets',     description:'특정 날짜의 행성 위치(트랜짓) 반환.', inputSchema:{type:'object',properties:{targetDate:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['targetDate','latitude','longitude']} },
  { name:'get_full_chart_analysis', description:'전체 베딕 차트 종합 계산 (행성/하우스/다샤/D9/요가).', inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },
  // VedAstro 확장
  { name:'get_horoscope_predictions', description:'베다 점성술 종합 예측 200+. 성격·직업·건강·재물·결혼. Lahiri.', inputSchema:{type:'object',properties:{birth_date:{type:'string',description:'DD/MM/YYYY'},birth_time:{type:'string',description:'HH:MM'},latitude:{type:'string'},longitude:{type:'string'},timezone:{type:'string',description:'+09:00'}},required:['birth_date','birth_time','latitude','longitude','timezone']} },
  { name:'get_match_report',        description:'두 차트 궁합 분석 (아슈타 코오타, 그라하 미트람).', inputSchema:{type:'object',properties:{person1_date:{type:'string'},person1_time:{type:'string'},person1_lat:{type:'string'},person1_lng:{type:'string'},person1_tz:{type:'string'},person2_date:{type:'string'},person2_time:{type:'string'},person2_lat:{type:'string'},person2_lng:{type:'string'},person2_tz:{type:'string'}},required:['person1_date','person1_time','person1_lat','person1_lng','person1_tz','person2_date','person2_time','person2_lat','person2_lng','person2_tz']} },
  { name:'get_numerology_prediction', description:'수비학 예측. 표현수, 생명경로수, 영혼충동수.', inputSchema:{type:'object',properties:{name:{type:'string',description:'분석할 이름'},birth_date:{type:'string',description:'DD/MM/YYYY'}},required:['name','birth_date']} },
  { name:'get_ashtakvarga_data',    description:'아슈타크바르가 차트. 사르바(전체) + 빈나(개별). 트랜짓 분석용.', inputSchema:{type:'object',properties:{birth_date:{type:'string'},birth_time:{type:'string'},latitude:{type:'string'},longitude:{type:'string'},timezone:{type:'string'}},required:['birth_date','birth_time','latitude','longitude','timezone']} },
  { name:'astro_check_retrograde',  description:'특정 행성 역행 여부 확인. BTR 정밀 분석용.', inputSchema:{type:'object',properties:{planet:{type:'string',description:'Sun/Moon/Mars/Mercury/Jupiter/Venus/Saturn/Rahu/Ketu'},dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['planet','dateTime','latitude','longitude']} },
  { name:'astro_planetary_war_check', description:'그라하 유다(행성 전쟁) 감지. BTR 루브릭 정밀 보정용.', inputSchema:{type:'object',properties:{dateTime:{type:'string'},latitude:{type:'number'},longitude:{type:'number'},timezone:{type:'string'}},required:['dateTime','latitude','longitude']} },

  // ════ L1: BTR Pipeline (13개) ════
  { name:'create_btr_session', description:'BTR 분석 세션 초기화. Drive 폴더(Ledger B) + Archive BTRRuntime 시트 행 생성. session_id와 evolution_folder_id 반환 — 이후 모든 BTR 도구에 전달.', inputSchema:{type:'object',properties:{structure_code:{type:'string',description:'StructureCode e.g. S-00001AA-260410'},birth_data:{type:'string',description:'{"date":"07/11/1979","time":"05:25","lat":"37.5665","lng":"126.9780","timezone":"+09:00"}'},parent_folder_id:{type:'string'}},required:['structure_code','birth_data']} },
  { name:'save_runtime_snapshot', description:'BTR 라운드 진행 상태를 BTRRuntime 시트에 저장.', inputSchema:{type:'object',properties:{session_id:{type:'string'},round:{type:'number'},candidate_slots:{type:'array',items:{type:'string'}},agreement_score:{type:'number'},entropy_score:{type:'number'},conflict_axis:{type:'string'},next_action:{type:'string',enum:['L0_physics','rubric_continue','question_generation','full_reset','sclass_validation','report_generation']},status:{type:'string',enum:['ACTIVE','QUESTION_MODE','RESET','SCLASS_REACHED','HELD']},gem_score:{type:'number'},cl_score:{type:'number'},gpt_score:{type:'number'}},required:['session_id','round','candidate_slots','agreement_score','entropy_score','next_action']} },
  { name:'get_runtime_snapshot', description:'BTRRuntime 시트에서 현재 세션 상태 조회.', inputSchema:{type:'object',properties:{session_id:{type:'string'}},required:['session_id']} },
  { name:'purge_runtime_state', description:'BTRRuntime 시트에서 세션 행 삭제 (완료/실패 후 정리).', inputSchema:{type:'object',properties:{session_id:{type:'string'}},required:['session_id']} },
  { name:'save_evolution_log', description:'BTR 진화 로그를 Drive Ledger B 폴더에 JSON 파일로 저장.', inputSchema:{type:'object',properties:{session_id:{type:'string'},evolution_folder_id:{type:'string'},round:{type:'number'},log_data:{type:'object',description:'저장할 로그 데이터'}},required:['session_id','evolution_folder_id','round','log_data']} },
  { name:'get_evolution_history', description:'Drive Ledger B 폴더에서 BTR 진화 로그 파일 목록 조회.', inputSchema:{type:'object',properties:{evolution_folder_id:{type:'string'}},required:['evolution_folder_id']} },
  { name:'validate_sclass_gate', description:'S-Class 조건 확인: 세 AI 모두 97점↑ AND critical_issues 없음. 통과 시 BTR 확정.', inputSchema:{type:'object',properties:{session_id:{type:'string'},gem_score:{type:'number'},cl_score:{type:'number'},gpt_score:{type:'number'},critical_issues:{type:'array',items:{type:'string'}}},required:['session_id','gem_score','cl_score','gpt_score','critical_issues']} },
  { name:'btr_init_candidate_slots', description:'BTR 초기 후보 생시 슬롯 생성. 출생 시각 ±2시간 범위 내 10~15분 간격.', inputSchema:{type:'object',properties:{birth_time_estimate:{type:'string',description:'예상 출생 시각 HH:MM'},range_minutes:{type:'number',description:'탐색 범위 분 (기본 120)'},interval_minutes:{type:'number',description:'슬롯 간격 분 (기본 15)'}},required:['birth_time_estimate']} },
  { name:'btr_consensus_analyzer', description:'세 AI 루브릭 점수 및 분석 결과 종합. 합의 점수와 갈등 축 계산.', inputSchema:{type:'object',properties:{gem_analysis:{type:'string'},cl_analysis:{type:'string'},gpt_analysis:{type:'string'},gem_score:{type:'number'},cl_score:{type:'number'},gpt_score:{type:'number'}},required:['gem_analysis','cl_analysis','gpt_analysis','gem_score','cl_score','gpt_score']} },
  { name:'btr_conflict_axis_finder', description:'세 AI 분석 간 주요 갈등 축 식별. 사건 해석 불일치 구간 추출.', inputSchema:{type:'object',properties:{analyses:{type:'array',items:{type:'string'},description:'세 AI 분석 텍스트 배열'},scores:{type:'array',items:{type:'number'},description:'세 AI 점수 배열'}},required:['analyses','scores']} },
  { name:'btr_re_eval_pivots', description:'갈등 축 기준 후보 슬롯 재평가. 점수 상위 슬롯만 유지.', inputSchema:{type:'object',properties:{candidate_slots:{type:'array',items:{type:'string'}},conflict_axis:{type:'string'},pivot_criteria:{type:'string',description:'재평가 기준 (예: career_event_alignment)'}},required:['candidate_slots','conflict_axis']} },
  { name:'btr_weight_adjuster', description:'루브릭 항목별 가중치 동적 조정. 고객 제공 정보 품질 기반.', inputSchema:{type:'object',properties:{event_count:{type:'number'},has_appearance_data:{type:'boolean'},has_career_data:{type:'boolean'},session_id:{type:'string'}},required:['event_count','has_appearance_data','has_career_data','session_id']} },
  { name:'btr_prediction_tester', description:'최종 후보 슬롯으로 미래 사건 예측 테스트. 검증용.', inputSchema:{type:'object',properties:{candidate_time:{type:'string'},birth_date:{type:'string'},latitude:{type:'string'},longitude:{type:'string'},timezone:{type:'string'},test_period_years:{type:'number',description:'미래 검증 기간 (기본 2년)'}},required:['candidate_time','birth_date','latitude','longitude','timezone']} },

  // ════ L2: Google Cloud 제어 (5개) ════
  { name:'gcloud_submit', description:'★ Cloud Build로 gcloud 명령어 실행. Agent Registry 등록, 배포 등. 빌드 ID 반환.', inputSchema:{type:'object',properties:{commands:{type:'array',items:{type:'string'}},project:{type:'string'}},required:['commands']} },
  { name:'cloudbuild_status', description:'Cloud Build 빌드 상태/결과 조회.', inputSchema:{type:'object',properties:{buildId:{type:'string'},project:{type:'string'}},required:['buildId']} },
  { name:'cloudrun_services', description:'Cloud Run 서비스 목록과 상태 조회.', inputSchema:{type:'object',properties:{project:{type:'string'},region:{type:'string'}},required:[]} },
  { name:'artifact_list', description:'Artifact Registry Docker 이미지 목록.', inputSchema:{type:'object',properties:{repository:{type:'string'},project:{type:'string'},location:{type:'string'}},required:[]} },
  { name:'cloudrun_set_env', description:'Cloud Run 서비스 환경변수 설정.', inputSchema:{type:'object',properties:{service:{type:'string'},envVars:{type:'object'},project:{type:'string'},region:{type:'string'}},required:['service','envVars']} },

  // ════ L3: System Ops (8개) ════
  { name:'github_read_file', description:'GitHub 리포지토리 파일 읽기.', inputSchema:{type:'object',properties:{repo:{type:'string'},path:{type:'string'},branch:{type:'string'}},required:['repo','path']} },
  { name:'github_write_file', description:'★ GitHub 파일 쓰기/커밋 → Cloud Build 자동배포 트리거.', inputSchema:{type:'object',properties:{repo:{type:'string'},path:{type:'string'},content:{type:'string'},message:{type:'string'},branch:{type:'string'}},required:['repo','path','content','message']} },
  { name:'github_list_files', description:'GitHub 리포지토리 파일 목록.', inputSchema:{type:'object',properties:{repo:{type:'string'},path:{type:'string'},branch:{type:'string'}},required:['repo']} },
  { name:'sheets_read', description:'Google Sheets 데이터 읽기.', inputSchema:{type:'object',properties:{spreadsheetId:{type:'string'},range:{type:'string'}},required:['spreadsheetId','range']} },
  { name:'sheets_write', description:'Google Sheets 데이터 쓰기.', inputSchema:{type:'object',properties:{spreadsheetId:{type:'string'},range:{type:'string'},values:{type:'array'}},required:['spreadsheetId','range','values']} },
  { name:'http_request', description:'임의 HTTP 요청. BTR 서버 호출, 상태확인 등.', inputSchema:{type:'object',properties:{url:{type:'string'},method:{type:'string',enum:['GET','POST','PUT','PATCH','DELETE']},body:{type:'object'},headers:{type:'object'}},required:['url']} },
  { name:'get_system_status', description:'ASTERION 전체 시스템 상태 확인.', inputSchema:{type:'object',properties:{},required:[]} },
  { name:'append_sheet_row', description:'Google Sheets 시트에 행 추가.', inputSchema:{type:'object',properties:{spreadsheetId:{type:'string'},range:{type:'string',description:'예: Archive!A:Z'},values:{type:'array',description:'1차원 배열 (한 행)'}},required:['spreadsheetId','range','values']} },

  // ════ L4: Google Workspace (17개) ════
  { name:'read_google_doc', description:'Google Docs 문서를 텍스트로 추출. BTR 분석 보고서 읽기.', inputSchema:{type:'object',properties:{document_id:{type:'string'}},required:['document_id']} },
  { name:'create_google_doc', description:'Google Docs 문서 생성. BTR 보고서, 분석 문서 작성.', inputSchema:{type:'object',properties:{title:{type:'string'},content:{type:'string',description:'문서 초기 텍스트'},folder_id:{type:'string',description:'저장할 Drive 폴더 ID'}},required:['title']} },
  { name:'create_spreadsheet', description:'Google Sheets 스프레드시트 생성.', inputSchema:{type:'object',properties:{title:{type:'string'},sheet_name:{type:'string',description:'첫 번째 시트명 (기본: Sheet1)'},folder_id:{type:'string'}},required:['title']} },
  { name:'export_doc_as_pdf', description:'Google Docs/Sheets 문서를 PDF로 내보내기. Drive 폴더에 저장.', inputSchema:{type:'object',properties:{document_id:{type:'string',description:'Docs 또는 Sheets 파일 ID'},pdf_filename:{type:'string',description:'저장할 PDF 파일명'},folder_id:{type:'string',description:'저장할 Drive 폴더 ID'}},required:['document_id','pdf_filename','folder_id']} },
  { name:'delete_drive_file', description:'Google Drive 파일 삭제.', inputSchema:{type:'object',properties:{file_id:{type:'string'}},required:['file_id']} },
  { name:'create_drive_folder', description:'Google Drive 폴더 생성.', inputSchema:{type:'object',properties:{name:{type:'string'},parent_folder_id:{type:'string'}},required:['name']} },
  { name:'delete_drive_folder', description:'Google Drive 폴더 삭제 (폴더 내 파일 포함).', inputSchema:{type:'object',properties:{folder_id:{type:'string'}},required:['folder_id']} },
  { name:'list_drive_contents', description:'Google Drive 폴더 내 파일/폴더 목록 조회.', inputSchema:{type:'object',properties:{folder_id:{type:'string',description:'폴더 ID. 비어있으면 루트.'},mime_type_filter:{type:'string',description:'예: application/vnd.google-apps.document'},max_results:{type:'number',description:'기본 50'}},required:[]} },
  { name:'list_script_projects', description:'Google Apps Script 프로젝트 목록 조회.', inputSchema:{type:'object',properties:{max_results:{type:'number'}},required:[]} },
  { name:'get_script_content', description:'Google Apps Script 프로젝트 소스코드 조회.', inputSchema:{type:'object',properties:{script_id:{type:'string',description:'Apps Script 프로젝트 ID'}},required:['script_id']} },
  { name:'update_script_file', description:'★ Google Apps Script 파일 업데이트. GAS 웹앱 코드 수정.', inputSchema:{type:'object',properties:{script_id:{type:'string'},filename:{type:'string',description:'파일명 (확장자 제외, 예: Code)'},source:{type:'string',description:'전체 소스코드'},type:{type:'string',enum:['SERVER_JS','HTML','JSON'],description:'기본: SERVER_JS'}},required:['script_id','filename','source']} },
  { name:'deploy_script_webapp', description:'Google Apps Script 웹앱 배포. Archive GAS 업데이트 후 재배포.', inputSchema:{type:'object',properties:{script_id:{type:'string'},description:{type:'string',description:'배포 설명'},access:{type:'string',enum:['MYSELF','DOMAIN','ANYONE','ANYONE_ANONYMOUS'],description:'기본: ANYONE_ANONYMOUS'}},required:['script_id']} },
  { name:'backup_script_project', description:'GAS 프로젝트 전체 소스코드를 Drive JSON 파일로 백업.', inputSchema:{type:'object',properties:{script_id:{type:'string'},backup_folder_id:{type:'string',description:'백업 저장 폴더 ID'}},required:['script_id']} },
  { name:'delete_artifact_image', description:'Artifact Registry 이미지 삭제.', inputSchema:{type:'object',properties:{image_path:{type:'string',description:'전체 이미지 경로 (예: asia-northeast3-docker.pkg.dev/project/repo/image@sha256:...)'}},required:['image_path']} },
  { name:'list_run_revisions', description:'Cloud Run 서비스 리비전 목록 조회.', inputSchema:{type:'object',properties:{service_name:{type:'string',description:'서비스명 (기본: mcp-server)'},project:{type:'string'},region:{type:'string'}},required:[]} },
  { name:'delete_run_revision', description:'Cloud Run 특정 리비전 삭제.', inputSchema:{type:'object',properties:{revision_name:{type:'string',description:'삭제할 리비전 이름'},project:{type:'string'},region:{type:'string'}},required:['revision_name']} },
  { name:'create_btr_report_doc', description:'BTR 최종 분석 보고서 Google Docs 문서 생성. StructureCode + 분석 결과 포함.', inputSchema:{type:'object',properties:{structure_code:{type:'string'},analysis_content:{type:'string'},folder_id:{type:'string',description:'보고서 저장 폴더 ID'}},required:['structure_code','analysis_content','folder_id']} },

  // ════ L5: AI 호출 (3개) ════
  { name:'call_gemini', description:'Gemini AI 직접 호출. BTR 교대 루프에서 분석가 또는 검증관으로 동작.', inputSchema:{type:'object',properties:{prompt:{type:'string'},role:{type:'string',enum:['analyzer','verifier'],description:'analyzer: 선공 분석. verifier: 교차 검증.'},system_prompt:{type:'string'},model:{type:'string',description:'기본: gemini-3.1-pro-preview'}},required:['prompt']} },
  { name:'call_claude', description:'Claude AI 직접 호출. BTR 루브릭 검증관.', inputSchema:{type:'object',properties:{prompt:{type:'string'},system_prompt:{type:'string'},model:{type:'string',description:'기본: claude-sonnet-4-6'},max_tokens:{type:'number',description:'기본 8000'}},required:['prompt']} },
  { name:'call_gpt', description:'GPT AI 직접 호출. BTR 3차 검증관.', inputSchema:{type:'object',properties:{prompt:{type:'string'},system_prompt:{type:'string'},model:{type:'string',description:'기본: gpt-4o'},max_tokens:{type:'number'}},required:['prompt']} },

  // ════ L6: Report & Ops (6개) ════
  { name:'report_generate_btr_code', description:'BTR 확정 후 StructureCode 기반 분석 코드 생성. Archive 시트 업데이트.', inputSchema:{type:'object',properties:{session_id:{type:'string'},structure_code:{type:'string'},confirmed_birth_time:{type:'string',description:'최종 확정 생시 HH:MM'},confidence_score:{type:'number',description:'세 AI 평균 점수'}},required:['session_id','structure_code','confirmed_birth_time','confidence_score']} },
  { name:'report_generate_summary', description:'BTR 세션 결과 요약 보고서 생성. 라운드별 점수 변화, 최종 결론.', inputSchema:{type:'object',properties:{session_id:{type:'string'},evolution_folder_id:{type:'string'}},required:['session_id','evolution_folder_id']} },
  { name:'report_add_gemstone_advice', description:'BTR 확정 차트 기반 원석 배치 조언 추가.', inputSchema:{type:'object',properties:{structure_code:{type:'string'},birth_data:{type:'string'},gemstone_preferences:{type:'string',description:'고객 선호/금기 원석 정보'}},required:['structure_code','birth_data']} },
  { name:'ops_audit_log_exporter', description:'BTR 세션 감사 로그를 Sheets 또는 Drive에 내보내기.', inputSchema:{type:'object',properties:{session_id:{type:'string'},export_format:{type:'string',enum:['sheets','drive_json'],description:'기본: sheets'},target_id:{type:'string',description:'Sheets ID 또는 Drive 폴더 ID'}},required:['session_id','export_format']} },
  { name:'ops_pattern_match_failure', description:'BTR 5라운드 실패 시 패턴 분석. 추가 질문 생성.', inputSchema:{type:'object',properties:{session_id:{type:'string'},failed_analyses:{type:'array',items:{type:'string'}},birth_data:{type:'string'}},required:['session_id','failed_analyses','birth_data']} },
  { name:'validate_sclass_gate', description:'S-Class 조건 최종 확인. 세 AI 97점↑ AND critical_issues 없음. Hard Stop.', inputSchema:{type:'object',properties:{session_id:{type:'string'},gem_score:{type:'number'},cl_score:{type:'number'},gpt_score:{type:'number'},critical_issues:{type:'array',items:{type:'string'}}},required:['session_id','gem_score','cl_score','gpt_score','critical_issues']} },
];

// 이름 → 카테고리 빠른 조회
const L0 = new Set(['geocode_location','get_timezone','get_planet_positions','get_house_positions','get_navamsa_chart','get_ascendant','get_planet_in_house','get_planet_in_sign','get_current_dasha','get_dasha_timeline','get_dasha_sandhi','get_birth_nakshatra','get_planet_yogas','get_transit_planets','get_full_chart_analysis','get_horoscope_predictions','get_match_report','get_numerology_prediction','get_ashtakvarga_data','astro_check_retrograde','astro_planetary_war_check']);
const L1 = new Set(['create_btr_session','save_runtime_snapshot','get_runtime_snapshot','purge_runtime_state','save_evolution_log','get_evolution_history','validate_sclass_gate','btr_init_candidate_slots','btr_consensus_analyzer','btr_conflict_axis_finder','btr_re_eval_pivots','btr_weight_adjuster','btr_prediction_tester']);
const L2 = new Set(['gcloud_submit','cloudbuild_status','cloudrun_services','artifact_list','cloudrun_set_env']);
const L3 = new Set(['github_read_file','github_write_file','github_list_files','sheets_read','sheets_write','http_request','get_system_status','append_sheet_row']);
const L4 = new Set(['read_google_doc','create_google_doc','create_spreadsheet','export_doc_as_pdf','delete_drive_file','create_drive_folder','delete_drive_folder','list_drive_contents','list_script_projects','get_script_content','update_script_file','deploy_script_webapp','backup_script_project','delete_artifact_image','list_run_revisions','delete_run_revision','create_btr_report_doc']);
const L5 = new Set(['call_gemini','call_claude','call_gpt']);
const L6 = new Set(['report_generate_btr_code','report_generate_summary','report_add_gemstone_advice','ops_audit_log_exporter','ops_pattern_match_failure']);

// ── L0: VedAstro 실행 ──────────────────────────────────────────
async function execVedAstro(name, args) {
  try {
    const lat=String(args.latitude||args.lat||''), lng=String(args.longitude||args.lng||'');
    const tz=args.timezone||'+09:00', dt=args.dateTime||args.birthDateTime||args.targetDate||'';
    // 신형 인터페이스 (birth_date/birth_time 형식)
    const bDate=args.birth_date||'', bTime=args.birth_time||'', bLat=String(args.latitude||args.lat||''), bLng=String(args.longitude||args.lng||''), bTz=args.timezone||'+09:00';

    if (name==='geocode_location') {
      const r=await fetch(`${VEDASTRO_BASE}/Calculate/Location/Name/${encodeURIComponent(args.location)}/0/0`);
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_timezone') {
      const r=await fetch(`${VEDASTRO_BASE}/api/Calculate/TimeZone/Location/${lat}/${lng}/Time/${encodeURIComponent(dt)}`);
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_horoscope_predictions') {
      return await vedFetch(`${VEDASTRO_BASE}/Calculate/HoroscopePredictions${vedPath(bLat,bLng,bTime,bDate,bTz)}`);
    }
    if (name==='get_numerology_prediction') {
      const r=await fetch(`${VEDASTRO_BASE}/Calculate/NumerologyPrediction/${encodeURIComponent(args.name)}/${args.birth_date}`);
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_match_report') {
      const p1=vedPath(args.person1_lat,args.person1_lng,args.person1_time,args.person1_date,args.person1_tz);
      const p2=vedPath(args.person2_lat,args.person2_lng,args.person2_time,args.person2_date,args.person2_tz);
      const r=await fetch(`${VEDASTRO_BASE}/Calculate/CompatibilityReport${p1}${p2}`);
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_ashtakvarga_data') {
      const tlPath=vedPath(bLat,bLng,bTime,bDate,bTz);
      const [sarva,bhinna]=await Promise.all([vedFetch(`${VEDASTRO_BASE}/Calculate/SarvashtakavargaChart${tlPath}`),vedFetch(`${VEDASTRO_BASE}/Calculate/BhinnashtakavargaChart${tlPath}`)]);
      return {SarvashtakavargaChart:sarva,BhinnashtakavargaChart:bhinna};
    }
    if (name==='astro_check_retrograde') {
      const planet=args.planet; const tlPath=vedPath(lat,lng,'00:00',dt.split('T')[0]||dt,tz);
      return await vedFetch(`${VEDASTRO_BASE}/Calculate/IsPlanetRetrograde/${planet}${tlPath}`);
    }
    if (name==='astro_planetary_war_check') {
      return await vedFetch(`${VEDASTRO_BASE}/Calculate/PlanetaryWar${vedPath(lat,lng,'00:00',dt,tz)}`);
    }
    const map={get_planet_positions:'AllPlanetData',get_house_positions:'AllHouseData',get_navamsa_chart:'NavamsaChart',get_ascendant:'AscendantSign',get_planet_yogas:'AllYogas',get_dasha_sandhi:'DashaSandhi',get_birth_nakshatra:'BirthNakshatra',get_transit_planets:'CurrentPlanetData',get_full_chart_analysis:'AllPlanetData'};
    if (map[name]) {
      const r=await fetch(`${VEDASTRO_BASE}/Calculate/${map[name]}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({BirthTime:dt,Location:{Latitude:parseFloat(lat),Longitude:parseFloat(lng)},TimeZone:tz})});
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_planet_in_house'||name==='get_planet_in_sign') {
      const ep=name==='get_planet_in_house'?'PlanetHouseNumber':'PlanetRasiSign';
      const r=await fetch(`${VEDASTRO_BASE}/Calculate/${ep}/${args.planet}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({BirthTime:dt,Location:{Latitude:parseFloat(lat),Longitude:parseFloat(lng)},TimeZone:tz})});
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_current_dasha') {
      const r=await fetch(`${VEDASTRO_BASE}/Calculate/CurrentDasha`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({BirthTime:dt,TargetTime:args.targetDate||new Date().toISOString(),Location:{Latitude:parseFloat(lat),Longitude:parseFloat(lng)},TimeZone:tz})});
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    if (name==='get_dasha_timeline') {
      const r=await fetch(`${VEDASTRO_BASE}/Calculate/DashaTimeline`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({BirthTime:dt,Location:{Latitude:parseFloat(lat),Longitude:parseFloat(lng)},TimeZone:tz,StartYear:args.startYear,EndYear:args.endYear})});
      return r.ok?await r.json():{error:`HTTP ${r.status}`};
    }
    return {error:`미구현: ${name}`};
  } catch(e) { return {error:`${name}: ${e.message}`}; }
}

// ── L1: BTR 실행 ───────────────────────────────────────────────
async function execBTR(name, args) {
  const token = await getGoogleToken();
  if (!token && !['btr_init_candidate_slots','btr_consensus_analyzer','btr_conflict_axis_finder','validate_sclass_gate'].includes(name))
    return { error:'Google 인증 실패. GOOGLE_REFRESH_TOKEN 환경변수 확인.' };

  if (name==='btr_init_candidate_slots') {
    const [h,m]=args.birth_time_estimate.split(':').map(Number);
    const range=args.range_minutes||120, interval=args.interval_minutes||15;
    const slots=[];
    for(let offset=-range;offset<=range;offset+=interval){
      const total=h*60+m+offset;
      const sh=Math.floor(((total%1440)+1440)%1440/60).toString().padStart(2,'0');
      const sm=(((total%1440)+1440)%60).toString().padStart(2,'0');
      slots.push(`${sh}:${sm}`);
    }
    return {candidate_slots:[...new Set(slots)],count:new Set(slots).size,base_time:args.birth_time_estimate};
  }

  if (name==='btr_consensus_analyzer') {
    const scores=[args.gem_score,args.cl_score,args.gpt_score];
    const avg=scores.reduce((a,b)=>a+b,0)/3;
    const variance=scores.reduce((a,b)=>a+Math.pow(b-avg,2),0)/3;
    return {agreement_score:+(avg/100).toFixed(3),entropy_score:+(variance/1000).toFixed(3),avg_score:+avg.toFixed(1),scores:{gemini:args.gem_score,claude:args.cl_score,gpt:args.gpt_score},consensus:avg>=97?'S_CLASS_CANDIDATE':'CONTINUE'};
  }

  if (name==='btr_conflict_axis_finder') {
    const minScore=Math.min(...args.scores), maxScore=Math.max(...args.scores);
    return {score_range:maxScore-minScore,conflict_detected:maxScore-minScore>15,min_score:minScore,max_score:maxScore,conflict_axis:maxScore-minScore>15?'score_divergence_critical':'minor_variation'};
  }

  if (name==='validate_sclass_gate') {
    const scores=[args.gem_score,args.cl_score,args.gpt_score];
    const allPass=scores.every(s=>s>=97);
    const noCritical=!args.critical_issues||args.critical_issues.length===0;
    const passed=allPass&&noCritical;
    if (token) {
      const timestamp=new Date().toISOString();
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({majorDimension:'ROWS',values:[[args.session_id,'sclass_gate_check',String(passed),args.gem_score,args.cl_score,args.gpt_score,(args.critical_issues||[]).join(','),timestamp]]})}).catch(()=>{});
    }
    return {session_id:args.session_id,sclass_passed:passed,scores:{gemini:args.gem_score,claude:args.cl_score,gpt:args.gpt_score},all_above_97:allPass,no_critical_issues:noCritical,action:passed?'CONFIRM_BTR':'CONTINUE_RUBRIC'};
  }

  if (name==='create_btr_session') {
    const timestamp=new Date().toISOString();
    const session_id=`BTR-${args.structure_code}-${Date.now()}`;
    const folderBody={name:session_id,mimeType:'application/vnd.google-apps.folder'};
    if (args.parent_folder_id) folderBody.parents=[args.parent_folder_id];
    const folderR=await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(folderBody)});
    if (!folderR.ok) return {error:`폴더 생성 실패 ${folderR.status}: ${await folderR.text()}`};
    const folder=await folderR.json();
    const dataRow=[session_id,args.structure_code,'0','false','[]','0','1.0','','L0_physics','ACTIVE',timestamp,timestamp,folder.id,timestamp,'INIT','','',''];
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({majorDimension:'ROWS',values:[dataRow]})});
    return {success:true,session_id,structure_code:args.structure_code,evolution_folder_id:folder.id,evolution_folder_url:folder.webViewLink,sclass_gate:'LOCKED'};
  }

  if (name==='save_runtime_snapshot') {
    const timestamp=new Date().toISOString();
    const readR=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${token}`}});
    if (!readR.ok) return {error:`BTRRuntime 읽기 실패 ${readR.status}`};
    const rows=((await readR.json()).values)||[];
    const hdr=rows[0]||[];
    const rowIdx=rows.findIndex((r,i)=>i>0&&r[0]===args.session_id);
    if (rowIdx<0) return {error:`세션 없음: ${args.session_id}`};
    const idx=n=>hdr.indexOf(n);
    const row=[...rows[rowIdx]];
    if (idx('round')>=0) row[idx('round')]=String(args.round);
    if (idx('candidate_slots')>=0) row[idx('candidate_slots')]=JSON.stringify(args.candidate_slots);
    if (idx('agreement_score')>=0) row[idx('agreement_score')]=String(args.agreement_score);
    if (idx('entropy_score')>=0) row[idx('entropy_score')]=String(args.entropy_score);
    if (idx('conflict_axis')>=0&&args.conflict_axis) row[idx('conflict_axis')]=args.conflict_axis;
    if (idx('next_action')>=0) row[idx('next_action')]=args.next_action;
    if (idx('status')>=0&&args.status) row[idx('status')]=args.status;
    if (idx('updated_at')>=0) row[idx('updated_at')]=timestamp;
    if (idx('gem_score')>=0&&args.gem_score!=null) row[idx('gem_score')]=String(args.gem_score);
    if (idx('cl_score')>=0&&args.cl_score!=null) row[idx('cl_score')]=String(args.cl_score);
    if (idx('gpt_score')>=0&&args.gpt_score!=null) row[idx('gpt_score')]=String(args.gpt_score);
    const r=`${RUNTIME_SHEET}!A${rowIdx+1}`;
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(r)}?valueInputOption=RAW`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
    return {success:true,session_id:args.session_id,round:args.round,updated_at:timestamp};
  }

  if (name==='get_runtime_snapshot') {
    const r=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${token}`}});
    if (!r.ok) return {error:`BTRRuntime 읽기 실패 ${r.status}`};
    const rows=((await r.json()).values)||[];
    const hdr=rows[0]||[];
    const row=rows.find((r,i)=>i>0&&r[0]===args.session_id);
    if (!row) return {error:`세션 없음: ${args.session_id}`};
    return Object.fromEntries(hdr.map((k,i)=>[k,row[i]||'']));
  }

  if (name==='save_evolution_log') {
    const content=JSON.stringify({session_id:args.session_id,round:args.round,...args.log_data,timestamp:new Date().toISOString()},null,2);
    const filename=`R${String(args.round).padStart(2,'0')}_${Date.now()}.json`;
    const meta=JSON.stringify({name:filename,parents:[args.evolution_folder_id],mimeType:'application/json'});
    const body=`--boundary\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--boundary\r\nContent-Type: application/json\r\n\r\n${content}\r\n--boundary--`;
    const r=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'multipart/related; boundary=boundary'},body});
    if (!r.ok) return {error:`로그 저장 실패 ${r.status}`};
    const f=await r.json();
    return {success:true,file_id:f.id,filename,folder_id:args.evolution_folder_id};
  }

  if (name==='get_evolution_history') {
    const r=await fetch(`https://www.googleapis.com/drive/v3/files?q='${args.evolution_folder_id}'+in+parents&orderBy=name&fields=files(id,name,modifiedTime,size)`,{headers:{Authorization:`Bearer ${token}`}});
    if (!r.ok) return {error:`폴더 조회 실패 ${r.status}`};
    return await r.json();
  }

  if (name==='btr_re_eval_pivots') {
    return {evaluated_slots:args.candidate_slots,conflict_axis:args.conflict_axis,pivot_criteria:args.pivot_criteria,recommendation:'Re-evaluate with additional birth data if available'};
  }

  if (name==='btr_weight_adjuster') {
    const weights={event_bukhti_fit:args.event_count>=3?40:25,d9_alignment:20,appearance_temperament:args.has_appearance_data?15:8,sandhi_transition:15,logic_consistency_bonus:10};
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({majorDimension:'ROWS',values:[[args.session_id,'weight_adjustment',JSON.stringify(weights),new Date().toISOString()]]})}).catch(()=>{});
    return {session_id:args.session_id,adjusted_weights:weights,note:'가중치 BTRRuntime에 기록됨'};
  }

  if (name==='btr_prediction_tester') {
    return {candidate_time:args.candidate_time,test_period_years:args.test_period_years||2,note:'미래 예측 검증 — VedAstro get_transit_planets + get_dasha_timeline으로 수동 검증 권장',status:'MANUAL_VERIFICATION_RECOMMENDED'};
  }

  if (name==='purge_runtime_state') {
    const r=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${token}`}});
    if (!r.ok) return {error:`읽기 실패 ${r.status}`};
    const rows=((await r.json()).values)||[];
    const idx=rows.findIndex((r,i)=>i>0&&r[0]===args.session_id);
    if (idx<0) return {error:`세션 없음: ${args.session_id}`};
    // 행을 빈 값으로 덮어씀 (실제 삭제는 Sheets API 제한으로 어려움)
    const empty=Array(rows[0]?.length||18).fill('');
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A'+(idx+1))}?valueInputOption=RAW`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[empty]})});
    return {success:true,session_id:args.session_id,note:'세션 행 초기화 완료'};
  }

  return {error:`미구현 BTR 도구: ${name}`};
}

// ── L2: Google Cloud 실행 ──────────────────────────────────────
async function execGCloud(name, args) {
  const project=args.project||GCP_PROJECT, region=args.region||GCP_REGION;
  const token=await getGCPToken();
  if (!token) return {error:'GCP ADC 인증 실패'};

  if (name==='gcloud_submit') {
    const steps=args.commands.map(cmd=>({name:'gcr.io/google.com/cloudsdktool/cloud-sdk',entrypoint:'bash',args:['-c',cmd]}));
    const r=await fetch(`https://cloudbuild.googleapis.com/v1/projects/${project}/builds`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({steps,options:{logging:'CLOUD_LOGGING_ONLY'}})});
    if (!r.ok) return {error:`Cloud Build ${r.status}: ${await r.text()}`};
    const d=await r.json();
    return {buildId:d.metadata?.build?.id||d.name?.split('/').pop(),status:'QUEUED',commands:args.commands};
  }
  if (name==='cloudbuild_status') {
    const r=await fetch(`https://cloudbuild.googleapis.com/v1/projects/${project}/builds/${args.buildId}`,{headers:{Authorization:`Bearer ${token}`}});
    if (!r.ok) return {error:`CloudBuild ${r.status}`};
    const d=await r.json();
    return {status:d.status,id:d.id,steps:(d.steps||[]).map(s=>({name:s.name,status:s.status,timing:s.timing})),logUrl:d.logUrl};
  }
  if (name==='cloudrun_services') {
    const r=await fetch(`https://run.googleapis.com/v2/projects/${project}/locations/${region}/services`,{headers:{Authorization:`Bearer ${token}`}});
    if (!r.ok) return {error:`Cloud Run ${r.status}`};
    const d=await r.json();
    return {services:(d.services||[]).map(s=>({name:s.name?.split('/').pop(),url:s.uri,traffic:s.traffic,revision:s.latestReadyRevision?.split('/').pop(),updated:s.updateTime}))};
  }
  if (name==='artifact_list') {
    const loc=args.location||GCP_REGION;
    const url=args.repository?`https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${loc}/repositories/${args.repository}/dockerImages`:`https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${loc}/repositories`;
    const r=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});
    return r.ok?await r.json():{error:`Artifact Registry ${r.status}: ${await r.text()}`};
  }
  if (name==='cloudrun_set_env') {
    const {service,envVars}=args;
    const getR=await fetch(`https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${service}`,{headers:{Authorization:`Bearer ${token}`}});
    if (!getR.ok) return {error:`Cloud Run GET ${getR.status}`};
    const svc=await getR.json();
    const existingEnv=svc.template?.containers?.[0]?.env||[];
    const envMap={};
    existingEnv.forEach(e=>{envMap[e.name]=e.value;});
    Object.assign(envMap,envVars);
    const newEnv=Object.entries(envMap).map(([n,v])=>({name:n,value:v}));
    const patchR=await fetch(`https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${service}`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({template:{containers:[{...svc.template?.containers?.[0],env:newEnv}]}})});
    if (!patchR.ok) return {error:`Cloud Run PATCH ${patchR.status}: ${await patchR.text()}`};
    return {success:true,service,updatedVars:Object.keys(envVars)};
  }
  return {error:`미구현: ${name}`};
}

// ── L3: System Ops 실행 ────────────────────────────────────────
async function execSystem(name, args) {
  if (name==='github_read_file') {
    if (!GITHUB_PAT) return {error:'GITHUB_PAT 미설정'};
    const {repo,path,branch='main'}=args;
    const r=await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,{headers:ghHeaders()});
    if (!r.ok) return {error:`GitHub ${r.status}: ${await r.text()}`};
    const d=await r.json();
    return {path:d.path,sha:d.sha,size:d.size,content:Buffer.from(d.content,'base64').toString('utf8')};
  }
  if (name==='github_write_file') {
    if (!GITHUB_PAT) return {error:'GITHUB_PAT 미설정'};
    const {repo,path,content,message,branch='main'}=args;
    let sha; const ex=await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,{headers:ghHeaders()});
    if (ex.ok) sha=(await ex.json()).sha;
    const r=await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}`,{method:'PUT',headers:ghHeaders(),body:JSON.stringify({message,content:Buffer.from(content).toString('base64'),branch,...(sha?{sha}:{})})});
    if (!r.ok) return {error:`GitHub ${r.status}: ${await r.text()}`};
    const d=await r.json();
    return {success:true,commit:d.commit?.sha,url:d.content?.html_url,note:'Cloud Build 자동배포 트리거됨'};
  }
  if (name==='github_list_files') {
    if (!GITHUB_PAT) return {error:'GITHUB_PAT 미설정'};
    const {repo,path='',branch='main'}=args;
    const r=await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,{headers:ghHeaders()});
    if (!r.ok) return {error:`GitHub ${r.status}`};
    const d=await r.json();
    return {files:(Array.isArray(d)?d:[d]).map(f=>({name:f.name,type:f.type,size:f.size,path:f.path}))};
  }
  if (name==='sheets_read'||name==='sheets_write'||name==='append_sheet_row') {
    const token=await getGoogleToken();
    if (!token) return {error:'Google 인증 실패'};
    if (name==='sheets_read') {
      const r=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(args.range)}`,{headers:{Authorization:`Bearer ${token}`}});
      if (!r.ok) return {error:`Sheets ${r.status}: ${await r.text()}`};
      const d=await r.json(); return {values:d.values||[],range:d.range};
    }
    if (name==='sheets_write') {
      const r=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(args.range)}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:args.values})});
      return r.ok?await r.json():{error:`Sheets ${r.status}: ${await r.text()}`};
    }
    if (name==='append_sheet_row') {
      const r=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(args.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({values:[args.values]})});
      return r.ok?await r.json():{error:`Sheets ${r.status}: ${await r.text()}`};
    }
  }
  if (name==='http_request') {
    const {url,method='GET',body,headers={}}=args;
    const opts={method,headers:{'Content-Type':'application/json',...headers}};
    if (body&&method!=='GET') opts.body=JSON.stringify(body);
    const r=await fetch(url,opts);
    try{return{status:r.status,ok:r.ok,data:await r.json()};}catch{return{status:r.status,ok:r.ok,data:await r.text()};}
  }
  if (name==='get_system_status') {
    const [mcp]=await Promise.allSettled([fetch('https://mcp-server-611151539232.asia-northeast3.run.app/').then(r=>r.json())]);
    return {mcp_server:mcp.status==='fulfilled'?{ok:true,server:mcp.value?.server,tools:mcp.value?.totalTools}:{ok:false},github_pat:GITHUB_PAT?'✓':'✗ 미설정',google_oauth:process.env.GOOGLE_REFRESH_TOKEN?'✓':'✗ 미설정',gcp_adc:(await getGCPToken())?'✓ ADC 정상':'✗ ADC 실패',timestamp:new Date().toISOString()};
  }
  return {error:`미구현: ${name}`};
}

// ── L4: Google Workspace 실행 ──────────────────────────────────
async function execWorkspace(name, args) {
  const token=await getGoogleToken();
  if (!token) return {error:'Google OAuth 인증 실패. GOOGLE_REFRESH_TOKEN 환경변수 확인.'};

  if (name==='read_google_doc') {
    const r=await fetch(`https://docs.googleapis.com/v1/documents/${args.document_id}`,{headers:{Authorization:`Bearer ${token}`}});
    if (!r.ok) return {error:`Docs API ${r.status}: ${await r.text()}`};
    const doc=await r.json();
    const text=doc.body.content.flatMap(b=>b.paragraph?.elements??[]).map(el=>el.textRun?.content??'').join('');
    return {title:doc.title,content:text};
  }
  if (name==='create_google_doc') {
    const body={title:args.title};
    const r=await fetch('https://docs.googleapis.com/v1/documents',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if (!r.ok) return {error:`Docs ${r.status}: ${await r.text()}`};
    const doc=await r.json();
    if (args.content) {
      await fetch(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{insertText:{location:{index:1},text:args.content}}]})});
    }
    if (args.folder_id) {
      const f=await fetch(`https://www.googleapis.com/drive/v3/files/${doc.documentId}?addParents=${args.folder_id}&fields=id`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`}});
      await f.json().catch(()=>{});
    }
    return {document_id:doc.documentId,title:doc.title,url:`https://docs.google.com/document/d/${doc.documentId}`};
  }
  if (name==='create_spreadsheet') {
    const r=await fetch('https://sheets.googleapis.com/v4/spreadsheets',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({properties:{title:args.title},sheets:[{properties:{title:args.sheet_name||'Sheet1'}}]})});
    if (!r.ok) return {error:`Sheets ${r.status}: ${await r.text()}`};
    const ss=await r.json();
    if (args.folder_id) { await fetch(`https://www.googleapis.com/drive/v3/files/${ss.spreadsheetId}?addParents=${args.folder_id}&fields=id`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`}}).catch(()=>{}); }
    return {spreadsheet_id:ss.spreadsheetId,title:args.title,url:`https://docs.google.com/spreadsheets/d/${ss.spreadsheetId}`};
  }
  if (name==='export_doc_as_pdf') {
    const pdfR=await fetch(`https://www.googleapis.com/drive/v3/files/${args.document_id}/export?mimeType=application/pdf`,{headers:{Authorization:`Bearer ${token}`}});
    if (!pdfR.ok) return {error:`PDF 내보내기 실패 ${pdfR.status}`};
    const pdfBytes=await pdfR.arrayBuffer();
    const meta=JSON.stringify({name:args.pdf_filename,parents:[args.folder_id],mimeType:'application/pdf'});
    const boundary='boundary';
    const body=new Uint8Array([...new TextEncoder().encode(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),...new Uint8Array(pdfBytes),...new TextEncoder().encode(`\r\n--${boundary}--`)]);
    const uploadR=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':`multipart/related; boundary=${boundary}`},body});
    if (!uploadR.ok) return {error:`PDF 업로드 실패 ${uploadR.status}: ${await uploadR.text()}`};
    const f=await uploadR.json();
    return {file_id:f.id,filename:f.name,url:f.webViewLink};
  }
  if (name==='delete_drive_file'||name==='delete_drive_folder') {
    const id=args.file_id||args.folder_id;
    const r=await fetch(`https://www.googleapis.com/drive/v3/files/${id}`,{method:'DELETE',headers:{Authorization:`Bearer ${token}`}});
    return {success:r.ok||r.status===204,status:r.status};
  }
  if (name==='create_drive_folder') {
    const body={name:args.name,mimeType:'application/vnd.google-apps.folder'};
    if (args.parent_folder_id) body.parents=[args.parent_folder_id];
    const r=await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if (!r.ok) return {error:`Drive ${r.status}: ${await r.text()}`};
    const f=await r.json(); return {folder_id:f.id,name:f.name,url:f.webViewLink};
  }
  if (name==='list_drive_contents') {
    const qParts=[];
    if (args.folder_id) qParts.push(`'${args.folder_id}' in parents`);
    if (args.mime_type_filter) qParts.push(`mimeType='${args.mime_type_filter}'`);
    qParts.push('trashed=false');
    const q=encodeURIComponent(qParts.join(' and '));
    const r=await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=${args.max_results||50}`,{headers:{Authorization:`Bearer ${token}`}});
    return r.ok?await r.json():{error:`Drive ${r.status}`};
  }
  if (name==='list_script_projects') {
    const r=await fetch(`https://script.googleapis.com/v1/projects?pageSize=${args.max_results||20}`,{headers:{Authorization:`Bearer ${token}`}});
    return r.ok?await r.json():{error:`Apps Script ${r.status}: ${await r.text()}`};
  }
  if (name==='get_script_content') {
    const r=await fetch(`https://script.googleapis.com/v1/projects/${args.script_id}/content`,{headers:{Authorization:`Bearer ${token}`}});
    return r.ok?await r.json():{error:`Apps Script ${r.status}: ${await r.text()}`};
  }
  if (name==='update_script_file') {
    const getR=await fetch(`https://script.googleapis.com/v1/projects/${args.script_id}/content`,{headers:{Authorization:`Bearer ${token}`}});
    if (!getR.ok) return {error:`읽기 실패 ${getR.status}`};
    const content=await getR.json();
    const files=content.files||[];
    const idx=files.findIndex(f=>f.name===args.filename);
    const fileEntry={name:args.filename,type:args.type||'SERVER_JS',source:args.source};
    if (idx>=0) files[idx]=fileEntry; else files.push(fileEntry);
    const r=await fetch(`https://script.googleapis.com/v1/projects/${args.script_id}/content`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({files})});
    return r.ok?{success:true,filename:args.filename,files_count:files.length}:{error:`업데이트 실패 ${r.status}: ${await r.text()}`};
  }
  if (name==='deploy_script_webapp') {
    const r=await fetch(`https://script.googleapis.com/v1/projects/${args.script_id}/deployments`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({versionNumber:null,manifestFileName:'appsscript',description:args.description||'Deploy',access:args.access||'ANYONE_ANONYMOUS'})});
    return r.ok?await r.json():{error:`배포 실패 ${r.status}: ${await r.text()}`};
  }
  if (name==='backup_script_project') {
    const contentR=await fetch(`https://script.googleapis.com/v1/projects/${args.script_id}/content`,{headers:{Authorization:`Bearer ${token}`}});
    if (!contentR.ok) return {error:`백업 읽기 실패 ${contentR.status}`};
    const content=await contentR.json();
    const backupName=`GAS_backup_${args.script_id}_${Date.now()}.json`;
    const meta=JSON.stringify({name:backupName,parents:[args.backup_folder_id||'root'],mimeType:'application/json'});
    const body=`--boundary\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--boundary\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(content)}\r\n--boundary--`;
    const r=await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'multipart/related; boundary=boundary'},body});
    return r.ok?{success:true,backup_file_id:(await r.json()).id,backup_name:backupName}:{error:`백업 저장 실패 ${r.status}`};
  }
  if (name==='delete_artifact_image') {
    const gcpToken=await getGCPToken();
    if (!gcpToken) return {error:'GCP ADC 실패'};
    const r=await fetch(`https://artifactregistry.googleapis.com/v1/${args.image_path}`,{method:'DELETE',headers:{Authorization:`Bearer ${gcpToken}`}});
    return {success:r.ok,status:r.status};
  }
  if (name==='list_run_revisions') {
    const gcpToken=await getGCPToken();
    if (!gcpToken) return {error:'GCP ADC 실패'};
    const project=args.project||GCP_PROJECT, region=args.region||GCP_REGION;
    const service=args.service_name||'mcp-server';
    const r=await fetch(`https://run.googleapis.com/v2/projects/${project}/locations/${region}/services/${service}/revisions`,{headers:{Authorization:`Bearer ${gcpToken}`}});
    if (!r.ok) return {error:`Cloud Run ${r.status}`};
    const d=await r.json();
    return {revisions:(d.revisions||[]).map(rv=>({name:rv.name?.split('/').pop(),uid:rv.uid,createTime:rv.createTime}))};
  }
  if (name==='delete_run_revision') {
    const gcpToken=await getGCPToken();
    if (!gcpToken) return {error:'GCP ADC 실패'};
    const project=args.project||GCP_PROJECT, region=args.region||GCP_REGION;
    const r=await fetch(`https://run.googleapis.com/v2/projects/${project}/locations/${region}/revisions/${args.revision_name}`,{method:'DELETE',headers:{Authorization:`Bearer ${gcpToken}`}});
    return {success:r.ok,status:r.status};
  }
  if (name==='create_btr_report_doc') {
    const title=`BTR_Report_${args.structure_code}_${new Date().toISOString().slice(0,10)}`;
    const body={title};
    const r=await fetch('https://docs.googleapis.com/v1/documents',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
    if (!r.ok) return {error:`Docs ${r.status}`};
    const doc=await r.json();
    if (args.analysis_content) {
      await fetch(`https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{insertText:{location:{index:1},text:`${args.structure_code} BTR 분석 보고서\n\n${args.analysis_content}`}}]})});
    }
    if (args.folder_id) { await fetch(`https://www.googleapis.com/drive/v3/files/${doc.documentId}?addParents=${args.folder_id}&fields=id`,{method:'PATCH',headers:{Authorization:`Bearer ${token}`}}).catch(()=>{}); }
    return {document_id:doc.documentId,title,url:`https://docs.google.com/document/d/${doc.documentId}`};
  }
  return {error:`미구현 Workspace 도구: ${name}`};
}

// ── L5: AI 호출 실행 ───────────────────────────────────────────
async function execAI(name, args) {
  if (name==='call_gemini') {
    const key=process.env.GEMINI_API_KEY;
    if (!key) return {error:'GEMINI_API_KEY 미설정'};
    const model=args.model||'gemini-3.1-pro-preview';
    const url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const analyzerSys='당신은 베다 점성술(조티쉬) BTR 분석 전문가입니다. Lahiri Ayanamsa 기준. 분석 근거와 루브릭 채점(0-100점)을 JSON으로 반환합니다.';
    const verifierSys='당신은 BTR 교차 검증 전문가입니다. 상대 AI 분석의 논리 오류를 지적하고 독자 점수를 채점합니다.';
    const sys=args.system_prompt||(args.role==='verifier'?verifierSys:analyzerSys);
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:args.prompt}]}],generationConfig:{maxOutputTokens:8192,temperature:0.7}})});
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0,200)}`);
    const d=await r.json();
    return {text:d.candidates?.[0]?.content?.parts?.[0]?.text||'',model,role:args.role||'analyzer'};
  }
  if (name==='call_claude') {
    const key=process.env.ANTHROPIC_API_KEY;
    if (!key) return {error:'ANTHROPIC_API_KEY 미설정'};
    const model=args.model||'claude-sonnet-4-6';
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model,max_tokens:args.max_tokens||8000,system:args.system_prompt||'당신은 베다 점성술 BTR 전문가입니다. 분석 근거와 루브릭 점수를 JSON으로 반환합니다.',messages:[{role:'user',content:args.prompt}]})});
    if (!r.ok) throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0,200)}`);
    const d=await r.json();
    return {text:d.content?.find(b=>b.type==='text')?.text||'',model};
  }
  if (name==='call_gpt') {
    const key=process.env.OPENAI_API_KEY;
    if (!key) return {error:'OPENAI_API_KEY 미설정'};
    const model=args.model||'gpt-4o';
    const r=await fetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,max_tokens:args.max_tokens||8000,messages:[{role:'system',content:args.system_prompt||'당신은 베다 점성술 BTR 전문가입니다.'},{role:'user',content:args.prompt}]})});
    if (!r.ok) throw new Error(`GPT ${r.status}: ${(await r.text()).slice(0,200)}`);
    const d=await r.json();
    return {text:d.choices?.[0]?.message?.content||'',model};
  }
  return {error:`미구현: ${name}`};
}

// ── L6: Report & Ops 실행 ──────────────────────────────────────
async function execReportOps(name, args) {
  const token=await getGoogleToken();

  if (name==='report_generate_btr_code') {
    if (token) {
      await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent('Archive!A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({majorDimension:'ROWS',values:[[new Date().toISOString(),args.structure_code,'BTR_CONFIRMED',args.confirmed_birth_time,String(args.confidence_score),args.session_id]]})}).catch(()=>{});
    }
    return {structure_code:args.structure_code,btr_confirmed:args.confirmed_birth_time,confidence:args.confidence_score,status:'CONFIRMED',note:'Archive 시트에 기록됨'};
  }
  if (name==='report_generate_summary') {
    return {session_id:args.session_id,summary_status:'GENERATED',note:'get_evolution_history로 로그 파일 읽고 요약 생성 권장',action:'use_get_evolution_history_and_summarize'};
  }
  if (name==='report_add_gemstone_advice') {
    return {structure_code:args.structure_code,note:'get_full_chart_analysis로 차트 계산 후 원석 배치 분석 권장',status:'MANUAL_ANALYSIS_REQUIRED'};
  }
  if (name==='ops_audit_log_exporter') {
    if (!token) return {error:'Google 인증 실패'};
    const r=await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${token}`}});
    if (!r.ok) return {error:`BTRRuntime 읽기 실패 ${r.status}`};
    const rows=((await r.json()).values)||[];
    const session_rows=rows.filter((r,i)=>i===0||r[0]?.startsWith('BTR-'+(args.session_id?.replace('BTR-','').split('-')[0]||'')));
    if (args.export_format==='drive_json'&&args.target_id) {
      const content=JSON.stringify({session_id:args.session_id,exported_at:new Date().toISOString(),rows:session_rows});
      const meta=JSON.stringify({name:`audit_${args.session_id}_${Date.now()}.json`,parents:[args.target_id]});
      const body=`--b\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--b\r\nContent-Type: application/json\r\n\r\n${content}\r\n--b--`;
      await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'multipart/related; boundary=b'},body});
    }
    return {exported:true,session_id:args.session_id,rows_count:session_rows.length,format:args.export_format};
  }
  if (name==='ops_pattern_match_failure') {
    return {session_id:args.session_id,failure_analysis:{total_failed_rounds:args.failed_analyses.length,common_issues:'시간 범위 재설정 권장'},suggested_questions:['출생 당일 날씨 또는 특이 사항이 있었나요?','부모님이 기억하는 출생 시각이 오전/오후 중 어느 쪽인가요?','출생 병원 기록이나 출생신고서가 있나요?'],next_action:'QUESTION_MODE'};
  }
  return {error:`미구현: ${name}`};
}

// ── 통합 라우터 ────────────────────────────────────────────────
async function executeTool(name, args) {
  console.log(`🔧 [${L0.has(name)?'L0':L1.has(name)?'L1':L2.has(name)?'L2':L3.has(name)?'L3':L4.has(name)?'L4':L5.has(name)?'L5':'L6'}] ${name}`);
  if (L0.has(name)) return await execVedAstro(name, args);
  if (L1.has(name)) return await execBTR(name, args);
  if (L2.has(name)) return await execGCloud(name, args);
  if (L3.has(name)) return await execSystem(name, args);
  if (L4.has(name)) return await execWorkspace(name, args);
  if (L5.has(name)) return await execAI(name, args);
  if (L6.has(name)) return await execReportOps(name, args);
  return {error:`알 수 없는 도구: ${name}`};
}

const toolList = ALL_TOOLS.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema}));

// ── SSE Transport (/sse) ────────────────────────────────────────
app.get('/sse', requireMcpAuth, (req, res) => {
  const sid=`s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no');
  res.write(`event: endpoint\ndata: /message?sessionId=${sid}\n\n`);
  sessions.set(sid, res);
  req.on('close', ()=>sessions.delete(sid));
  console.log(`[SSE] ${sid}`);
});

app.post('/message', requireMcpAuth, async (req, res) => {
  const sseRes=sessions.get(req.query.sessionId);
  if (!sseRes) return res.status(404).json({error:'세션 없음'});
  const {id,method,params}=req.body||{};
  const send=d=>sseRes.write(`data: ${JSON.stringify(d)}\n\n`);
  try {
    if (method==='initialize') send({jsonrpc:'2.0',id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.0.0'}}});
    else if (method==='tools/list') send({jsonrpc:'2.0',id,result:{tools:toolList}});
    else if (method==='tools/call') { const r=await executeTool(params?.name,params?.arguments||{}); send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(r,null,2)}]}}); }
    else if (method==='ping') send({jsonrpc:'2.0',id,result:{}});
    else if (method!=='notifications/initialized') send({jsonrpc:'2.0',id,error:{code:-32601,message:`Method not found: ${method}`}});
    res.status(200).end();
  } catch(e) { send({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}}); res.status(200).end(); }
});

// ── Streamable HTTP (/mcp) ← Agent Registry, Claude.ai, ChatGPT ──
app.all('/mcp', requireMcpAuth, async (req, res) => {
  // OPTIONS preflight
  if (req.method==='OPTIONS') { res.setHeader('Allow','GET, POST, DELETE, OPTIONS'); return res.status(204).end(); }
  // DELETE: 세션 종료 (stateless 모드에서는 no-op)
  if (req.method==='DELETE') return res.status(200).json({jsonrpc:'2.0'});

  const body=req.method==='GET'?null:req.body;
  const id=body?.id??null;
  const method=body?.method;
  const ok=r=>res.json({jsonrpc:'2.0',id,result:r});
  const err=(c,m)=>res.json({jsonrpc:'2.0',id,error:{code:c,message:m}});

  console.log(`[MCP] ${req.method} ${method||'(no-method)'}`);
  try {
    if (req.method==='GET') return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.0.0'}});
    if (!body) return err(-32700,'Parse error');
    if (method==='initialize')                return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.0.0'}});
    if (method==='notifications/initialized') return res.status(200).json({jsonrpc:'2.0'});
    if (method==='tools/list')                return ok({tools:toolList});
    if (method==='tools/call') {
      const r=await executeTool(params?.name||body?.params?.name, params?.arguments||body?.params?.arguments||{});
      return ok({content:[{type:'text',text:JSON.stringify(r,null,2)}]});
    }
    if (method==='ping') return ok({});
    return err(-32601,`Method not found: ${method}`);
  } catch(e) { return res.status(500).json({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}}); }
});

// 이전 호환: POST / → /mcp로 프록시 (기존 연결된 클라이언트 지원)
app.post('/', requireMcpAuth, async (req, res) => {
  const body=req.body, id=body?.id??null, method=body?.method;
  const ok=r=>res.json({jsonrpc:'2.0',id,result:r});
  const err=(c,m)=>res.json({jsonrpc:'2.0',id,error:{code:c,message:m}});
  try {
    if (method==='initialize')                return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.0.0'}});
    if (method==='notifications/initialized') return res.status(200).json({jsonrpc:'2.0'});
    if (method==='tools/list')                return ok({tools:toolList});
    if (method==='tools/call') { const r=await executeTool(body?.params?.name,body?.params?.arguments||{}); return ok({content:[{type:'text',text:JSON.stringify(r,null,2)}]}); }
    if (method==='ping') return ok({});
    return err(-32601,`Method not found: ${method}`);
  } catch(e) { return res.status(500).json({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}}); }
});

// 헬스체크
app.get('/', (_req, res) => res.json({
  status:'running', server:'ASTERION AI Evolution Engine v5.0',
  transports:{mcp:'POST/GET/DELETE /mcp (Agent Registry, Claude.ai, ChatGPT)',sse:'GET /sse (Hub SDK, legacy)'},
  layers:{L0:`VedAstro(${L0.size})`,L1:`BTR(${L1.size})`,L2:`GCloud(${L2.size})`,L3:`SystemOps(${L3.size})`,L4:`Workspace(${L4.size})`,L5:`AI(${L5.size})`,L6:`Report/Ops(${L6.size})`},
  totalTools:ALL_TOOLS.length,
  toolList:ALL_TOOLS.map(t=>t.name),
  auth:MCP_SECRET_KEY?'✓ Bearer 활성':'없음',
}));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔱 ASTERION AI Evolution Engine v5.0 | port:${PORT}`);
  console.log(`   MCP Streamable HTTP: POST/GET/DELETE /mcp  ← Agent Registry, Claude.ai, ChatGPT`);
  console.log(`   SSE:                 GET /sse              ← Hub SDK, Claude connector`);
  console.log(`   도구: ${ALL_TOOLS.length}개 (L0:${L0.size} L1:${L1.size} L2:${L2.size} L3:${L3.size} L4:${L4.size} L5:${L5.size} L6:${L6.size})`);
  console.log(`   Google OAuth: ${process.env.GOOGLE_REFRESH_TOKEN?'✓':'✗'} | GCP ADC: 자동\n`);
});
