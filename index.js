/**
 * ASTERION AI Evolution Engine v5.14
 * v5.14: VedAstro API 6개 버그 수정 — DasaAtRange 교체(CurrentDasha/DashaTimeline/DashaSandhi), dtToVed 적용(astro_check_retrograde/astro_planetary_war_check), get_timezone URL 중복 /api 제거
 * v5.13: VedAstro API 버그 수정 — POST→GET 전환, CurrentPlanetData 제거→AllPlanetData 행성별 루프,
 *   BirthTime/TimeZone 잘못된 필드명 제거, dtToVed() 헬퍼 추가, get_planet_in_house URL 수정
 * v5.11: video_init_sheets 전면 개편 — 별도 SS 생성 + 8개 시트 + EFFECTS_CATALOG 전체 프리셋
 *   - create_new:true → SA가 새 SS 생성 후 victuar918@gmail.com에 공유
 *   - 8개 시트: VIDEO_SCRIPT(A-R 18컬럼) / CRYPTO_BIRTH_CHARTS / SOURCE_FILES / PROMO_SOURCES
 *              / EFFECTS_CATALOG(전체 효과 프리셋) / VOICE_CONFIG / SECTION_PRESETS / VIDEO_META_TEMPLATE
 *   - video_create_script: A-R 18컬럼 지원
 *   - video_read_script: A-R 18컬럼 파싱
 * v5.12: +github_patch_file +sheets_update_row +docs_patch
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
const VIDEO_OWNER_EMAIL = 'victuar918@gmail.com';

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    return r;
  } catch(e) {
    if(e.name === 'AbortError') throw new Error(`요청 타임아웃 (${timeoutMs/1000}s) — ${url}`);
    throw e;
  } finally { clearTimeout(timer); }
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

const EFFECTS_CATALOG_DATA = [
  ['Effect_ID','Category','Name_KO','Description','Parameters','Use_Case','Section_Default','Source_File'],
  ['CARD_ANIM_A','CARD_ANIM','왼쪽진입/상단퇴장','X=-w+(W*0.1+w)*t 진입, Y=H*0.2 체류, 상단퇴장','T_in:1s T_hold:auto T_out:1s','TPL-PLA 분석행, TPL-TIM 홀수','TPL-PLA','AiCardAnimationBaseView.java'],
  ['CARD_ANIM_B','CARD_ANIM','오른쪽진입/하단퇴장','X=W-(W-W*0.5)*t 진입, Y=H*0.2 체류, 하단퇴장','T_in:1s T_hold:auto T_out:1s','TPL-TIM 짝수, TPL-SYN','TPL-TIM(짝수)','AiCardAnimationBaseView.java'],
  ['CARD_ANIM_C','CARD_ANIM','상단진입/하단퇴장','Y=-h+(H*0.2+h)*t 진입, X=W*0.3 고정, 하단퇴장','T_in:1s T_hold:auto T_out:1s','TPL-INT, TPL-SUM, TITLE스타일','TPL-INT','AiCardAnimationBaseView.java'],
  ['CARD_ANIM_D','CARD_ANIM','페이드인/아웃','opacity 0.0→1.0(1s) 체류 1.0→0.0(1s)','T_in:1s T_hold:auto T_out:1s','CONCLUSION, TPL-SUM 정점','TPL-SUM(정점)','FloatKeyframeAnimation.java BaseKeyframeAnimation.java'],
  ['CARD_ANIM_E','CARD_ANIM','베지어 곡선 진입','ease-in-out: 좌하단→중앙 진입, 우상단 퇴장','T_in:1s T_hold:auto T_out:1s','TPL-INT 오프닝, 특별강조구간','TPL-SYN','PathKeyframeAnimation.java KeyFrameCurveFragment.java'],
  ['CARD_ANIM_F','CARD_ANIM','스케일 팝업','scale 0.3→1.0(ease-out 0.5s), 체류, 1.0→0.0(ease-in 0.5s)','T_in:0.5s T_hold:auto T_out:0.5s','NOTICE, 핵심수치 강조','TPL-SUM(저점)','TransformKeyframeAnimation.java'],
  ['CARD_ANIM_G','CARD_ANIM','회전+스케일 진입','rotation -15deg→0 + scale 0.5→1.0(1s), 퇴장 rotation+scale','T_in:1s T_hold:auto T_out:0.5s','TPL-PLA 행성 첫등장, 강조수치','TPL-PLA(첫행)','TransformKeyframeAnimation.java PointKeyframeAnimation.java'],
  ['BG_FADE','BG_TRANSITION','알파 디졸브','기본 투명도 전환 (기본값)','duration:1.0s','모든 구간(기본값)','ALL','VideoTransitionCollection.java'],
  ['BG_SLIDE_LEFT','BG_TRANSITION','왼쪽 밀려오기','현재 씬→다음 씬 좌→우 슬라이드','duration:1.0s','TPL-INT→TPL-PLA 구간전환','TPL-INT→TPL-PLA','TimelineTransitionDrawable2.java'],
  ['BG_SLIDE_UP','BG_TRANSITION','아래서 올라오기','다음 씬이 하단에서 상승','duration:1.0s','TPL-TIM 시간대 전환','TPL-TIM','TimelineTransitionDrawable2.java'],
  ['BG_ZOOM_IN','BG_TRANSITION','확대 전환','다음 씬이 확대되며 등장','duration:1.0s','TPL-SUM 정점구간','TPL-SUM(정점)','TimelineTransitionDrawable2.java'],
  ['BG_ZOOM_OUT','BG_TRANSITION','축소 전환','현재 씬이 축소되며 퇴장','duration:1.0s','TPL-SYN 종합구간','TPL-SYN','TimelineTransitionDrawable2.java'],
  ['BG_BLUR_FADE','BG_TRANSITION','블러+페이드','블러 적용 후 디졸브','duration:1.0s','TPL-SUM 저점구간','TPL-SUM(저점)','ISXMotionBlurEffectMTIFilter.java'],
  ['BG_WIPE_RIGHT','BG_TRANSITION','오른쪽 닦아내기','현재→다음 우측으로 와이프','duration:1.0s','구간 경계 전환','구간전환','TimelineTransitionDrawable2.java'],
  ['BG_EF_NONE','BG_EFFECT','효과없음','기본값 — 효과 미적용','-','모든 일반구간','ALL','-'],
  ['BG_EF_MOTION_BLUR','BG_EFFECT','모션 블러','역동감 연출','intensity:0.0-1.0 (권장 0.3-0.5)','역동적 행성 분석','TPL-PLA','ISXMotionBlurEffectMTIFilter.java'],
  ['BG_EF_EDGE_GLOW','BG_EFFECT','엣지 발광','신비감/영적 분위기 연출','intensity:0.0-1.0 (권장 0.3-0.5)','행성분석 신비구간','TPL-PLA','GPUEdgeFilter.java'],
  ['BG_EF_VIGNETTE','BG_EFFECT','주변부 어둡게','화면 집중 유도','intensity:0.0-1.0 (권장 0.4)','일반 분석구간','ALL','-'],
  ['CARD_DEFAULT','CARD_STYLE','반투명 블랙 박스','alpha:0.75 일반 분석 박스','alpha:0.75','일반 분석 내용','ALL','ISBlendEffectFilter.java GPUImageTwoInputFilter.java'],
  ['CARD_TITLE','CARD_STYLE','대형 중앙 타이틀 박스','alpha:0.85 중앙 대형 타이틀','alpha:0.85','TPL-INT 오프닝','TPL-INT','ISBlendEffectFilter.java'],
  ['CARD_CONCLUSION','CARD_STYLE','하단 고정 결론 바','alpha:0.90 화면 하단 고정','alpha:0.90','TPL-SUM 정점, TPL-SYN 종합','TPL-SUM TPL-SYN','ISBlendEffectFilter.java'],
  ['CARD_NOTICE','CARD_STYLE','경고/주의 박스 (테두리강조)','alpha:0.80 + 경고색 테두리','alpha:0.80','리스크/주의 구간','TPL-SUM(저점)','ISBlendEffectFilter.java'],
  ['CARD_MINIMAL','CARD_STYLE','텍스트만 (박스없음)','alpha:0.00 텍스트 레이어만','alpha:0.00','보조 레이블, 부연설명','보조','ISBlendEffectFilter.java'],
  ['CARD_NONE','CARD_STYLE','카드없음','레이어 미적용','-','TPL-BUF 버퍼 (무음)','TPL-BUF','-'],
  ['FX_HEARTBEAT','CARD_EXTRA','심박 스케일 펄스','주기적 scale 파동 — 강조감','주기:자동','핵심수치 등장, 정점 강조','TPL-SUM(정점)','GPUHeartBeatFilter.java'],
  ['FX_VIBRATE','CARD_EXTRA','진동 효과','짧은 X축 진동 — 경고감','amplitude:auto','NOTICE, 경고/주의 구간','TPL-SUM(저점)','GPUVibrateFilter.java'],
  ['FX_NONE','CARD_EXTRA','추가효과없음','기본값','-','모든 일반구간','ALL','-'],
  ['GRAD_DEFAULT','GRADIENT','블랙→딥네이비 (수직)','rgba(0,0,0,0.85)→rgba(10,5,30,0.60)','방향:top→bottom','DEFAULT 카드','DEFAULT','GradientFillContent.java'],
  ['GRAD_TITLE','GRADIENT','딥퍼플→블랙 (수직)','rgba(30,0,50,0.85)→rgba(0,0,0,0.90)','방향:top→bottom','TITLE 카드','TITLE','GradientFillContent.java'],
  ['GRAD_CONCLUSION','GRADIENT','딥네이비→블랙 (수직)','rgba(0,5,30,0.90)→rgba(0,0,0,0.90)','방향:top→bottom','CONCLUSION 카드','CONCLUSION','GradientFillContent.java'],
  ['GRAD_NOTICE','GRADIENT','딥레드→블랙 (수직)','rgba(50,5,5,0.85)→rgba(0,0,0,0.90)','방향:top→bottom','NOTICE 카드','NOTICE','GradientFillContent.java'],
  ['LOTTIE_PLANET','LOTTIE','행성 심볼 JSON','planet_symbol_{행성}.json — 행성 테마컬러 런타임 교체','size:120x120px pos:카드좌측 play:1회','TPL-PLA 행성 첫등장행','TPL-PLA(첫행)','LottieAnimationView.java LottieValueCallback.java'],
  ['LOTTIE_ENERGY','LOTTIE','에너지 흐름 오버레이','energy_flow.json','size:전체화면 play:loop','TPL-SUM 정점구간','TPL-SUM(정점)','LottieDrawable.java LottieValueAnimator.java'],
  ['LOTTIE_STARBURST','LOTTIE','별 폭발 효과','star_burst.json','size:80x80px pos:Highlight주변 play:1회','핵심수치 등장행','핵심수치행','LottieDrawable.java'],
  ['LOTTIE_MANDALA','LOTTIE','만다라 회전 (오프닝)','mandala_rotate.json','size:200x200px pos:화면중앙하단 play:loop','TPL-INT 오프닝 전체','TPL-INT','LottieValueAnimator.java LottieCompositionMoshiParser.java'],
  ['COLOR_SUN','PLANET_COLOR','태양 테마컬러','#FFB700 — 골드/오렌지','-','태양 관련 씬','TPL-PLA(태양)','LottieValueCallback.java'],
  ['COLOR_MOON','PLANET_COLOR','달 테마컬러','#C8C8FF — 연보라/은빛','-','달 관련 씬','TPL-PLA(달)','LottieValueCallback.java'],
  ['COLOR_MARS','PLANET_COLOR','화성 테마컬러','#FF4444 — 붉은색','-','화성 관련 씬','TPL-PLA(화성)','LottieValueCallback.java'],
  ['COLOR_MERCURY','PLANET_COLOR','수성 테마컬러','#44FFCC — 청록색','-','수성 관련 씬','TPL-PLA(수성)','LottieValueCallback.java'],
  ['COLOR_JUPITER','PLANET_COLOR','목성 테마컬러','#FFD700 — 금색','-','목성 관련 씬','TPL-PLA(목성)','LottieValueCallback.java'],
  ['COLOR_VENUS','PLANET_COLOR','금성 테마컬러','#FF88CC — 핑크/로즈','-','금성 관련 씬','TPL-PLA(금성)','LottieValueCallback.java'],
  ['COLOR_SATURN','PLANET_COLOR','토성 테마컬러','#AAAAAA — 회색/실버','-','토성 관련 씬','TPL-PLA(토성)','LottieValueCallback.java'],
  ['COLOR_RAHU','PLANET_COLOR','라후 테마컬러','#440088 — 딥퍼플','-','라후 관련 씬','TPL-PLA(라후)','LottieValueCallback.java'],
  ['COLOR_KETU','PLANET_COLOR','케투 테마컬러','#884400 — 딥오렌지브라운','-','케투 관련 씬','TPL-PLA(케투)','LottieValueCallback.java'],
];

const VOICE_CONFIG_DATA = [
  ['Speaker_Num','Name','Model','SID','Speed','Voice_Label','Use_Case'],
  ['1','아스터','Supertonic-TTS-2-ONNX','0','1.0','아스터 (남성)','주화자 — 분석 본문 전반'],
  ['2','리언','Supertonic-TTS-2-ONNX','1','0.95','리언 (여성)','부화자 — 강조/전환 구간'],
  ['3','나레이터','Supertonic-TTS-2-ONNX','2','1.05','나레이터','오프닝/클로징 내레이션'],
];

const SECTION_PRESETS_DATA = [
  ['Section','Card_Style','Animation','BG_Transition','Card_ExtraEffect','Lottie_File','Notes'],
  ['TPL-INT','TITLE','C','FADE','NONE','LOTTIE_MANDALA','오프닝 구간'],
  ['TPL-PLA_FIRST','DEFAULT','G','SLIDE_LEFT','NONE','LOTTIE_PLANET','행성 첫 등장 행'],
  ['TPL-PLA_REST','DEFAULT','A','FADE','NONE','NONE','행성 나머지 분석 행'],
  ['TPL-TIM_ODD','DEFAULT','A','FADE','NONE','NONE','TPL-TIM 홀수 시간대'],
  ['TPL-TIM_EVEN','DEFAULT','B','FADE','NONE','NONE','TPL-TIM 짝수 시간대'],
  ['TPL-SUM_PEAK','CONCLUSION','D','BG_ZOOM_IN','HEARTBEAT','LOTTIE_ENERGY','TPL-SUM 정점 구간'],
  ['TPL-SUM_TROUGH','NOTICE','F','BG_BLUR_FADE','VIBRATE','NONE','TPL-SUM 저점 구간'],
  ['TPL-SYN','CONCLUSION','E','BG_ZOOM_OUT','NONE','NONE','TPL-SYN 종합 구간'],
  ['TPL-BUF','NONE','NONE','FADE','NONE','NONE','TPL-BUF 버퍼 구간'],
];

const VIDEO_META_TEMPLATE_DATA = [
  ['Param','Value','Unit','Description'],
  ['BGM_Volume_Normal','0.35','ratio','TTS 없는 구간 BGM 볼륨'],
  ['BGM_Volume_Ducking','0.10','ratio','TTS 재생 중 BGM 볼륨 (덕킹)'],
  ['BGM_Fade_In','3.0','sec','영상 시작 페이드인'],
  ['BGM_Fade_Out','5.0','sec','영상 종료 페이드아웃'],
  ['BGM_Duck_Attack','0.3','sec','덕킹 시작 전환'],
  ['BGM_Duck_Release','0.5','sec','덕킹 해제 전환'],
  ['Video_Width','1920','px','출력 가로'],
  ['Video_Height','1080','px','출력 세로'],
  ['Video_FPS','30','fps','출력 프레임레이트'],
  ['TTS_SampleRate','44100','Hz','TTS 샘플레이트'],
  ['TTS_Format','PCM_Float32','-','TTS 출력 포맷'],
  ['Card_Main_FontSize','52','px','Card_Main 크기'],
  ['Card_Sub_FontSize','38','px','Card_Sub 크기'],
  ['Card_Desc_FontSize','32','px','Card_Desc 크기'],
  ['Watermark_FontSize','34','px','워터마크 크기'],
  ['Card_Main_MaxChars','12','char','Card_Main 최대 글자수'],
  ['Card_Sub_MaxChars','18','char','Card_Sub 최대 글자수'],
  ['Card_Desc_MaxChars','24','char','Card_Desc 최대 글자수'],
  ['Subtitle_Font','NotoSansKR-Bold','-','자막 폰트'],
  ['Color_Highlight_Rise','#FFDB4D','-','긍정 하이라이트'],
  ['Color_Highlight_Fall','#FFAA00','-','주의 하이라이트'],
  ['Color_Highlight_Planet','#00FFD7','-','행성명 하이라이트'],
];

const ALL_TOOLS = [
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
  {name:'create_btr_session',description:'BTR 분석 세션 초기화.',inputSchema:{type:'object',properties:{structure_code:{type:'string'},birth_data:{type:'string'},parent_folder_id:{type:'string'}},required:['structure_code','birth_data']}},
  {name:'save_runtime_snapshot',description:'BTR 라운드 상태 저장.',inputSchema:{type:'object',properties:{session_id:{type:'string'},round:{type:'number'},candidate_slots:{type:'array',items:{type:'string'}},agreement_score:{type:'number'},entropy_score:{type:'number'},conflict_axis:{type:'string'},next_action:{type:'string',enum:['L0_physics','rubric_continue','question_generation','full_reset','sclass_validation','report_generation']},status:{type:'string',enum:['ACTIVE','QUESTION_MODE','RESET','SCLASS_REACHED','HELD']},gem_score:{type:'number'},cl_score:{type:'number'},gpt_score:{type:'number'},critical_issues:{type:'array',items:{type:'string'}},suggestions:{type:'array',items:{type:'string'}},analysis_summary:{type:'string'}},required:['session_id','round','candidate_slots','agreement_score','entropy_score','next_action']}},
  {name:'get_runtime_snapshot',description:'BTRRuntime 세션 조회.',inputSchema:{type:'object',properties:{session_id:{type:'string'}},required:['session_id']}},
  {name:'purge_runtime_state',description:'BTRRuntime 세션 삭제.',inputSchema:{type:'object',properties:{session_id:{type:'string'}},required:['session_id']}},
  {name:'save_evolution_log',description:'BTR 진화 로그 Drive 저장.',inputSchema:{type:'object',properties:{session_id:{type:'string'},evolution_folder_id:{type:'string'},round:{type:'number'},log_data:{type:'object'}},required:['session_id','evolution_folder_id','round','log_data']}},
  {name:'get_evolution_history',description:'BTR 로그 파일 목록.',inputSchema:{type:'object',properties:{evolution_folder_id:{type:'string'}},required:['evolution_folder_id']}},
  {name:'validate_sclass_gate',description:'S-Class 조건 확인.',inputSchema:{type:'object',properties:{session_id:{type:'string'},gem_score:{type:'number'},cl_score:{type:'number'},gpt_score:{type:'number'},critical_issues:{type:'array',items:{type:'string'}}},required:['session_id','gem_score','cl_score','gpt_score','critical_issues']}},
  {name:'btr_init_candidate_slots',description:'BTR 초기 후보 생시 슬롯.',inputSchema:{type:'object',properties:{birth_time_estimate:{type:'string'},range_minutes:{type:'number'},interval_minutes:{type:'number'}},required:['birth_time_estimate']}},
  {name:'btr_consensus_analyzer',description:'세 AI 루브릭 점수 종합.',inputSchema:{type:'object',properties:{gem_analysis:{type:'string'},cl_analysis:{type:'string'},gpt_analysis:{type:'string'},gem_score:{type:'number'},cl_score:{type:'number'},gpt_score:{type:'number'}},required:['gem_analysis','cl_analysis','gpt_analysis','gem_score','cl_score','gpt_score']}},
  {name:'btr_conflict_axis_finder',description:'세 AI 갈등 축 식별.',inputSchema:{type:'object',properties:{analyses:{type:'array',items:{type:'string'}},scores:{type:'array',items:{type:'number'}}},required:['analyses','scores']}},
  {name:'btr_re_eval_pivots',description:'후보 슬롯 재평가.',inputSchema:{type:'object',properties:{candidate_slots:{type:'array',items:{type:'string'}},conflict_axis:{type:'string'},pivot_criteria:{type:'string'}},required:['candidate_slots','conflict_axis']}},
  {name:'btr_weight_adjuster',description:'루브릭 가중치 조정.',inputSchema:{type:'object',properties:{event_count:{type:'number'},has_appearance_data:{type:'boolean'},has_career_data:{type:'boolean'},session_id:{type:'string'}},required:['event_count','has_appearance_data','has_career_data','session_id']}},
  {name:'btr_prediction_tester',description:'미래 예측 테스트.',inputSchema:{type:'object',properties:{candidate_time:{type:'string'},birth_date:{type:'string'},latitude:{type:'string'},longitude:{type:'string'},timezone:{type:'string'},test_period_years:{type:'number'}},required:['candidate_time','birth_date','latitude','longitude','timezone']}},
  {name:'btr_write_notification',description:'BTRNotifications 시트에 관리자 개입 알림 작성.',inputSchema:{type:'object',properties:{session_id:{type:'string'},type:{type:'string',enum:['info_request','phase_confirm']},title:{type:'string'},content:{type:'string'}},required:['session_id','type','title','content']}},
  {name:'btr_finalize_confirmed',description:'★ S-Class Hard Stop 완료 처리.',inputSchema:{type:'object',properties:{session_id:{type:'string'},structure_code:{type:'string'},confirmed_birth_time:{type:'string'},final_score:{type:'number'},analysis_doc_url:{type:'string'},gem_score:{type:'number'},cl_score:{type:'number'},gpt_score:{type:'number'}},required:['session_id','structure_code','confirmed_birth_time','final_score']}},
  {name:'btr_finalize_held',description:'★ Held 상태 완료 처리.',inputSchema:{type:'object',properties:{session_id:{type:'string'},structure_code:{type:'string'},failure_summary:{type:'string'},highest_score:{type:'number'},best_candidate_time:{type:'string'}},required:['session_id','structure_code','failure_summary']}},
  {name:'init_btr_sheets',description:'★ Archive SS에 BTRRuntime·BTRNotifications 시트 생성 및 헤더 작성.',inputSchema:{type:'object',properties:{spreadsheet_id:{type:'string'},force_recreate:{type:'boolean'}},required:[]}},
  {name:'video_init_sheets',description:'★ 영상 자동화 전용 SS 생성+초기화. create_new:true 시 SA가 새 SS 생성→victuar918@gmail.com 편집권한 공유. 8개 시트: VIDEO_SCRIPT(A-R)/CRYPTO_BIRTH_CHARTS/SOURCE_FILES/PROMO_SOURCES/EFFECTS_CATALOG/VOICE_CONFIG/SECTION_PRESETS/VIDEO_META_TEMPLATE',inputSchema:{type:'object',properties:{create_new:{type:'boolean'},title:{type:'string'},owner_email:{type:'string'},spreadsheet_id:{type:'string'}},required:[]}},
  {name:'video_create_script',description:'★ 영상 1편 대본 시트 생성 (VS_{coin}_{date}). Video_Meta + Script_Data A-R 18컬럼.',inputSchema:{type:'object',properties:{coin:{type:'string'},date:{type:'string'},video_meta:{type:'object'},script_rows:{type:'array',items:{type:'object'}},spreadsheet_id:{type:'string'}},required:['coin','script_rows']}},
  {name:'video_read_script',description:'영상 대본 시트 읽기. video_meta + script_rows(A-R) JSON 반환.',inputSchema:{type:'object',properties:{sheet_name:{type:'string'},spreadsheet_id:{type:'string'}},required:['sheet_name']}},
  {name:'video_update_row_status',description:'Script_Data 행 Status(K열) 업데이트.',inputSchema:{type:'object',properties:{sheet_name:{type:'string'},row_index:{type:'number'},status:{type:'string',enum:['READY','DONE','ERROR']},spreadsheet_id:{type:'string'}},required:['sheet_name','row_index','status']}},
  {name:'video_delete_script',description:'★ YouTube 업로드 완료 후 대본 시트 삭제.',inputSchema:{type:'object',properties:{sheet_name:{type:'string'},spreadsheet_id:{type:'string'}},required:['sheet_name']}},
  {name:'gcloud_submit',description:'Cloud Build로 gcloud 실행.',inputSchema:{type:'object',properties:{commands:{type:'array',items:{type:'string'}},project:{type:'string'}},required:['commands']}},
  {name:'cloudbuild_status',description:'Cloud Build 빌드 상태.',inputSchema:{type:'object',properties:{buildId:{type:'string'},project:{type:'string'}},required:['buildId']}},
  {name:'cloudrun_services',description:'Cloud Run 서비스 목록.',inputSchema:{type:'object',properties:{project:{type:'string'},region:{type:'string'}},required:[]}},
  {name:'artifact_list',description:'Artifact Registry 이미지 목록.',inputSchema:{type:'object',properties:{repository:{type:'string'},project:{type:'string'},location:{type:'string'}},required:[]}},
  {name:'cloudrun_set_env',description:'Cloud Run 환경변수 설정.',inputSchema:{type:'object',properties:{service:{type:'string'},envVars:{type:'object'},project:{type:'string'},region:{type:'string'}},required:['service','envVars']}},
  {name:'agent_registry_list',description:'★ Agent Registry 서비스 목록 직접 조회.',inputSchema:{type:'object',properties:{location:{type:'string'},project:{type:'string'}},required:[]}},
  {name:'agent_registry_register',description:'★ Agent Registry에 MCP 서버 직접 등록.',inputSchema:{type:'object',properties:{display_name:{type:'string'},endpoint_url:{type:'string'},location:{type:'string'},service_id:{type:'string'},project:{type:'string'}},required:[]}},
  {name:'github_read_file',description:'GitHub 파일 읽기.',inputSchema:{type:'object',properties:{repo:{type:'string'},path:{type:'string'},branch:{type:'string'}},required:['repo','path']}},
  {name:'github_write_file',description:'★ GitHub 파일 쓰기 → 자동배포.',inputSchema:{type:'object',properties:{repo:{type:'string'},path:{type:'string'},content:{type:'string'},message:{type:'string'},branch:{type:'string'}},required:['repo','path','content','message']}},
  {name:'github_list_files',description:'GitHub 파일 목록.',inputSchema:{type:'object',properties:{repo:{type:'string'},path:{type:'string'},branch:{type:'string'}},required:['repo']}},
  {name:'gh_push_files',description:'★ 여러 파일을 한 번의 커밋으로 GitHub에 push.',inputSchema:{type:'object',properties:{repo:{type:'string'},branch:{type:'string'},message:{type:'string'},files:{type:'array',items:{type:'object',properties:{path:{type:'string'},content:{type:'string'}},required:['path','content']}}},required:['repo','message','files']}},
  {name:'sheets_read',description:'Google Sheets 읽기.',inputSchema:{type:'object',properties:{spreadsheetId:{type:'string'},range:{type:'string'}},required:['spreadsheetId','range']}},
  {name:'sheets_write',description:'Google Sheets 쓰기.',inputSchema:{type:'object',properties:{spreadsheetId:{type:'string'},range:{type:'string'},values:{type:'array',items:{type:'array',items:{type:'string'}}}},required:['spreadsheetId','range','values']}},
  {name:'http_request',description:'임의 HTTP 요청.',inputSchema:{type:'object',properties:{url:{type:'string'},method:{type:'string',enum:['GET','POST','PUT','PATCH','DELETE']},body:{type:'object'},headers:{type:'object'}},required:['url']}},
  {name:'get_system_status',description:'ASTERION 전체 시스템 상태.',inputSchema:{type:'object',properties:{},required:[]}},
  {name:'append_sheet_row',description:'Google Sheets 행 추가.',inputSchema:{type:'object',properties:{spreadsheetId:{type:'string'},range:{type:'string'},values:{type:'array',items:{type:'string'}}},required:['spreadsheetId','range','values']}},
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
  {name:'call_gemini',description:'Gemini AI 직접 호출. BTR 루브릭 평가 전용.',inputSchema:{type:'object',properties:{prompt:{type:'string'},system_prompt:{type:'string'},model:{type:'string'},previous_round_context:{type:'object'}},required:['prompt']}},
  {name:'call_claude',description:'Claude AI 직접 호출.',inputSchema:{type:'object',properties:{prompt:{type:'string'},system_prompt:{type:'string'},model:{type:'string'},max_tokens:{type:'number'},previous_round_context:{type:'object'}},required:['prompt']}},
  {name:'call_gpt',description:'GPT AI 직접 호출.',inputSchema:{type:'object',properties:{prompt:{type:'string'},system_prompt:{type:'string'},model:{type:'string'},max_tokens:{type:'number'}},required:['prompt']}},
  {name:'report_generate_btr_code',description:'BTR 확정 코드 생성.',inputSchema:{type:'object',properties:{session_id:{type:'string'},structure_code:{type:'string'},confirmed_birth_time:{type:'string'},confidence_score:{type:'number'}},required:['session_id','structure_code','confirmed_birth_time','confidence_score']}},
  {name:'report_generate_summary',description:'BTR 결과 요약.',inputSchema:{type:'object',properties:{session_id:{type:'string'},evolution_folder_id:{type:'string'}},required:['session_id','evolution_folder_id']}},
  {name:'report_add_gemstone_advice',description:'원석 배치 조언.',inputSchema:{type:'object',properties:{structure_code:{type:'string'},birth_data:{type:'string'},gemstone_preferences:{type:'string'}},required:['structure_code','birth_data']}},
  {name:'ops_audit_log_exporter',description:'BTR 감사 로그 내보내기.',inputSchema:{type:'object',properties:{session_id:{type:'string'},export_format:{type:'string',enum:['sheets','drive_json']},target_id:{type:'string'}},required:['session_id','export_format']}},
  {name:'ops_pattern_match_failure',description:'BTR 5라운드 실패 패턴 분석.',inputSchema:{type:'object',properties:{session_id:{type:'string'},failed_analyses:{type:'array',items:{type:'string'}},birth_data:{type:'string'}},required:['session_id','failed_analyses','birth_data']}},
  // ★ v5.12: 부분 업데이트 툴
  {name:'github_patch_file',description:'★ GitHub 파일 부분 업데이트 — find/replace 패치 배열. 파일 전체 재작성 없이 변경 부분만 지정. 토큰 절약.',inputSchema:{type:'object',properties:{repo:{type:'string'},path:{type:'string'},patches:{type:'array',items:{type:'object',properties:{find:{type:'string'},replace:{type:'string'}},required:['find','replace']}},message:{type:'string'},branch:{type:'string'}},required:['repo','path','patches','message']}},
  {name:'sheets_update_row',description:'★ Sheets 붐정 행 부분 업데이트 — 키 컬럼으로 행 찾아 지정 컬럼만 수정.',inputSchema:{type:'object',properties:{spreadsheetId:{type:'string'},range:{type:'string'},key_column:{type:'string'},key_value:{type:'string'},updates:{type:'object'}},required:['spreadsheetId','range','key_column','key_value','updates']}},
  {name:'docs_patch',description:'★ Google Docs 부분 업데이트 — replaceAllText API로 특정 텍스트만 교체.',inputSchema:{type:'object',properties:{document_id:{type:'string'},patches:{type:'array',items:{type:'object',properties:{find:{type:'string'},replace:{type:'string'}},required:['find','replace']}}},required:['document_id','patches']}},
];

const L0=new Set(['geocode_location','get_timezone','get_planet_positions','get_house_positions','get_navamsa_chart','get_ascendant','get_planet_in_house','get_planet_in_sign','get_current_dasha','get_dasha_timeline','get_dasha_sandhi','get_birth_nakshatra','get_planet_yogas','get_transit_planets','get_full_chart_analysis','get_horoscope_predictions','get_match_report','get_numerology_prediction','get_ashtakvarga_data','astro_check_retrograde','astro_planetary_war_check']);
const L1=new Set(['create_btr_session','save_runtime_snapshot','get_runtime_snapshot','purge_runtime_state','save_evolution_log','get_evolution_history','validate_sclass_gate','btr_init_candidate_slots','btr_consensus_analyzer','btr_conflict_axis_finder','btr_re_eval_pivots','btr_weight_adjuster','btr_prediction_tester','btr_write_notification','btr_finalize_confirmed','btr_finalize_held','init_btr_sheets','video_init_sheets','video_create_script','video_read_script','video_update_row_status','video_delete_script']);
const L2=new Set(['gcloud_submit','cloudbuild_status','cloudrun_services','artifact_list','cloudrun_set_env','agent_registry_list','agent_registry_register']);
const L3=new Set(['github_read_file','github_write_file','github_list_files','gh_push_files','github_patch_file','sheets_read','sheets_write','sheets_update_row','http_request','get_system_status','append_sheet_row']);
const L4=new Set(['read_google_doc','create_google_doc','docs_patch','create_spreadsheet','export_doc_as_pdf','delete_drive_file','create_drive_folder','delete_drive_folder','list_drive_contents','list_script_projects','get_script_content','update_script_file','deploy_script_webapp','backup_script_project','delete_artifact_image','list_run_revisions','delete_run_revision','create_btr_report_doc']);
const L5=new Set(['call_gemini','call_claude','call_gpt']);
const L6=new Set(['report_generate_btr_code','report_generate_summary','report_add_gemstone_advice','ops_audit_log_exporter','ops_pattern_match_failure']);

function buildAntiAnchoredContext(p){if(!p)return'';const{round,critical_issues,suggestions,analysis_summary}=p;const lines=[`\n\n<prev_round_verification_agenda round="${round||'?'}">`];lines.push(`<!-- ANTI-ANCHORING: Items below are UNVERIFIED CLAIMS. Evaluate independently. -->`);if(analysis_summary)lines.push(`  <round_summary>Prev memo (ref only): ${analysis_summary}</round_summary>`);if(critical_issues?.length){lines.push(`  <items_requiring_independent_verification>`);critical_issues.forEach(i=>lines.push(`    <item>Verify independently: ${i}</item>`));lines.push(`  </items_requiring_independent_verification>`);}if(suggestions?.length){lines.push(`  <methodological_suggestions>`);suggestions.forEach(s=>lines.push(`    <suggestion>${s}</suggestion>`));lines.push(`  </methodological_suggestions>`);}lines.push(`</prev_round_verification_agenda>`);return lines.join('\n');}

async function execVedAstro(n,a){
  try{
    const la=String(a.latitude||a.lat||''),lo=String(a.longitude||a.lng||''),tz=a.timezone||'+09:00',dt=a.dateTime||a.birthDateTime||a.targetDate||'';
    const bd=a.birth_date||'',bt=a.birth_time||'',btz=a.timezone||'+09:00';
    if(n==='geocode_location'){const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/Location/Name/${encodeURIComponent(a.location)}/0/0`);return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_timezone'){const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/TimeZone/Location/${la}/${lo}/Time/${encodeURIComponent(dt)}`);return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_horoscope_predictions')return await vedFetch(`${VEDASTRO_BASE}/Calculate/HoroscopePredictions${vedPath(la,lo,bt,bd,btz)}`);
    if(n==='get_numerology_prediction'){const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/NumerologyPrediction/${encodeURIComponent(a.name)}/${a.birth_date}`);return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_match_report'){const p1=vedPath(a.person1_lat,a.person1_lng,a.person1_time,a.person1_date,a.person1_tz),p2=vedPath(a.person2_lat,a.person2_lng,a.person2_time,a.person2_date,a.person2_tz);const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/CompatibilityReport${p1}${p2}`);return r.ok?await r.json():{error:`HTTP ${r.status}`};}
    if(n==='get_ashtakvarga_data'){const tp=vedPath(la,lo,bt,bd,btz);const[s,b]=await Promise.all([vedFetch(`${VEDASTRO_BASE}/Calculate/SarvashtakavargaChart${tp}`),vedFetch(`${VEDASTRO_BASE}/Calculate/BhinnashtakavargaChart${tp}`)]);return{SarvashtakavargaChart:s,BhinnashtakavargaChart:b};}
    if(n==='astro_check_retrograde'){const{d:_retd}=dtToVed(dt);return await vedFetch(`${VEDASTRO_BASE}/Calculate/IsPlanetRetrograde/${a.planet}${vedPath(la,lo,'00:00',_retd,tz)}`);}
    if(n==='astro_planetary_war_check'){const{d:_ward}=dtToVed(dt);return await vedFetch(`${VEDASTRO_BASE}/Calculate/PlanetaryWar${vedPath(la,lo,'00:00',_ward,tz)}`);}
    // v5.13 Fix: ISO dateTime → vedPath 분해 헬퍼 (HH:MM / DD-MM-YYYY)
    function dtToVed(s){const[dp,tp='12:00']=(s||'2000-01-01').split('T');const[yr,mo,dy]=(dp||'2000-01-01').split('-');return{t:(tp||'12:00').slice(0,5),d:`${(dy||'01').padStart(2,'0')}-${(mo||'01').padStart(2,'0')}-${yr||'2000'}`};}
    const PLANETS=['Sun','Moon','Mars','Mercury','Jupiter','Venus','Saturn','Rahu','Ketu'];
    // 단순 GET 매핑 (행성명 불필요한 엔드포인트)
    const simpleGET={get_house_positions:'AllHouseData',get_navamsa_chart:'NavamsaChart',get_ascendant:'AscendantSign',get_planet_yogas:'AllYogas',get_birth_nakshatra:'BirthNakshatra',get_full_chart_analysis:'AllPlanetData'};
    if(simpleGET[n]){const{t,d}=dtToVed(dt);return await vedFetch(`${VEDASTRO_BASE}/Calculate/${simpleGET[n]}${vedPath(la,lo,t,d,tz)}`);}
    // get_planet_positions: 9행성 AllPlanetData 병렬 GET
    if(n==='get_planet_positions'){const{t,d}=dtToVed(dt);const res=await Promise.all(PLANETS.map(p=>vedFetch(`${VEDASTRO_BASE}/Calculate/AllPlanetData/PlanetName/${p}${vedPath(la,lo,t,d,tz)}`).catch(e=>({error:e.message}))));return Object.fromEntries(PLANETS.map((p,i)=>[p,res[i]]));}
    // get_transit_planets: CurrentPlanetData(미존재) 제거 → 현재시각 기준 AllPlanetData 루프
    if(n==='get_transit_planets'){const tdt=a.targetDate||new Date().toISOString();const{t,d}=dtToVed(tdt);const res=await Promise.all(PLANETS.map(p=>vedFetch(`${VEDASTRO_BASE}/Calculate/AllPlanetData/PlanetName/${p}${vedPath(la,lo,t,d,tz)}`).catch(e=>({error:e.message}))));return{transit_date:tdt,planets:Object.fromEntries(PLANETS.map((p,i)=>[p,res[i]]))};}
    if(n==='get_planet_in_house'||n==='get_planet_in_sign'){const ep=n==='get_planet_in_house'?'PlanetHouseNumber':'PlanetRasiSign';const{t,d}=dtToVed(dt);return await vedFetch(`${VEDASTRO_BASE}/Calculate/${ep}/PlanetName/${a.planet}${vedPath(la,lo,t,d,tz)}`);}
    if(n==='get_current_dasha'){const _bdt=a.birthDateTime||dt;const{t:_cbt,d:_cbd}=dtToVed(_bdt);const _tdt=a.targetDate||new Date().toISOString();const{t:_ctgt,d:_ctgd}=dtToVed(_tdt);const _cloc={Name:'Birth',Latitude:parseFloat(la),Longitude:parseFloat(lo)};const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/DasaAtRange`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({birthTime:{StdTime:`${_cbt} ${_cbd.replace(/-/g,'/')} ${tz}`,Location:_cloc},startTime:{StdTime:`${_ctgt} ${_ctgd.replace(/-/g,'/')} ${tz}`,Location:_cloc},endTime:{StdTime:`23:59 ${_ctgd.replace(/-/g,'/')} ${tz}`,Location:_cloc},levels:2,precisionHours:1})},30000);if(!r.ok)return{error:`DasaAtRange ${r.status}`};const j=await r.json();if(j.Status!=='Pass')return{error:`VedAstro: ${JSON.stringify(j.Payload)}`};return j.Payload;}
    if(n==='get_dasha_timeline'){const{t:_tlt,d:_tld}=dtToVed(dt);const _tlsy=a.startYear||new Date().getFullYear()-1;const _tley=a.endYear||new Date().getFullYear()+3;const _tlloc={Name:'Birth',Latitude:parseFloat(la),Longitude:parseFloat(lo)};const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/DasaAtRange`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({birthTime:{StdTime:`${_tlt} ${_tld.replace(/-/g,'/')} ${tz}`,Location:_tlloc},startTime:{StdTime:`00:00 01/01/${_tlsy} ${tz}`,Location:_tlloc},endTime:{StdTime:`23:59 31/12/${_tley} ${tz}`,Location:_tlloc},levels:3,precisionHours:100})},30000);if(!r.ok)return{error:`DasaAtRange ${r.status}`};const j=await r.json();if(j.Status!=='Pass')return{error:`VedAstro: ${JSON.stringify(j.Payload)}`};return j.Payload;}if(n==='get_dasha_sandhi'){const{t:_sht,d:_shd}=dtToVed(dt);const _shsy=new Date().getFullYear()-1;const _shey=new Date().getFullYear()+1;const _shloc={Name:'Birth',Latitude:parseFloat(la),Longitude:parseFloat(lo)};const r=await fetchWithTimeout(`${VEDASTRO_BASE}/Calculate/DasaAtRange`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({birthTime:{StdTime:`${_sht} ${_shd.replace(/-/g,'/')} ${tz}`,Location:_shloc},startTime:{StdTime:`00:00 01/01/${_shsy} ${tz}`,Location:_shloc},endTime:{StdTime:`23:59 31/12/${_shey} ${tz}`,Location:_shloc},levels:2,precisionHours:24})},30000);if(!r.ok)return{error:`DasaAtRange ${r.status}`};const j=await r.json();if(j.Status!=='Pass')return{error:`VedAstro: ${JSON.stringify(j.Payload)}`};const _ds=j.Payload?.DasaAtRange;if(!_ds)return{error:'DasaAtRange payload empty'};const _si=[];Object.entries(_ds).forEach(([_l,_d])=>{_si.push({lord:_l,type:'Dasa',start:_d.Start,end:_d.End,duration:_d.DurationText,nature:_d.Nature});if(_d.SubDasas)Object.entries(_d.SubDasas).forEach(([_sl,_s])=>{_si.push({lord:_sl,parentLord:_l,type:'Bhukti',start:_s.Start,end:_s.End,duration:_s.DurationText,nature:_s.Nature});});});return{DashaSandhi:_si};}
    return{error:`미구현: ${n}`};
  }catch(e){return{error:`${n}: ${e.message}`};}
}

async function execBTR(n,a){
  const tok=await getGoogleToken();
  if(!tok&&!['btr_init_candidate_slots','btr_consensus_analyzer','btr_conflict_axis_finder','validate_sclass_gate','video_init_sheets','video_create_script','video_read_script','video_update_row_status','video_delete_script'].includes(n))return{error:'Google 인증 실패'};

  if(n==='video_init_sheets'){
    const gTok=await getGCPToken();
    if(!gTok)return{error:'GCP ADC 인증 실패'};
    let ssId=a.spreadsheet_id||ARCHIVE_SS_ID;
    const result={created:[],headers_written:{},spreadsheet_id:ssId};
    if(a.create_new){
      const title=a.title||'ASTERION Video Automation';
      const createR=await fetchWithTimeout('https://sheets.googleapis.com/v4/spreadsheets',{method:'POST',headers:{Authorization:`Bearer ${gTok}`,'Content-Type':'application/json'},body:JSON.stringify({properties:{title}})},15000);
      if(!createR.ok)return{error:`SS 생성 실패 ${createR.status}: ${await createR.text()}`};
      const newSS=await createR.json();
      ssId=newSS.spreadsheetId;result.spreadsheet_id=ssId;result.is_new_spreadsheet=true;result.title=title;
      const ownerEmail=a.owner_email||VIDEO_OWNER_EMAIL;
      const shareR=await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files/${ssId}/permissions`,{method:'POST',headers:{Authorization:`Bearer ${gTok}`,'Content-Type':'application/json'},body:JSON.stringify({type:'user',role:'writer',emailAddress:ownerEmail})},10000).catch(e=>({ok:false,message:e.message}));
      result.shared_with=ownerEmail;result.share_ok=!!(shareR?.ok);
    }
    const ssInfo=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}?fields=sheets.properties.title`,{headers:{Authorization:`Bearer ${gTok}`}},10000);
    if(!ssInfo.ok)return{error:`SS 접근 실패 ${ssInfo.status}`};
    const existing=((await ssInfo.json()).sheets||[]).map(s=>s.properties.title);
    result.existing_sheets=existing;
    const ALL_VIDEO_SHEETS=['VIDEO_SCRIPT','CRYPTO_BIRTH_CHARTS','SOURCE_FILES','PROMO_SOURCES','EFFECTS_CATALOG','VOICE_CONFIG','SECTION_PRESETS','VIDEO_META_TEMPLATE'];
    const toCreate=ALL_VIDEO_SHEETS.filter(s=>!existing.includes(s)).map(title=>({addSheet:{properties:{title}}}));
    if(toCreate.length>0){
      const cr=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}:batchUpdate`,{method:'POST',headers:{Authorization:`Bearer ${gTok}`,'Content-Type':'application/json'},body:JSON.stringify({requests:toCreate})},15000);
      if(!cr.ok)return{error:`시트 생성 실패 ${cr.status}: ${await cr.text()}`};
      result.created=toCreate.map(r=>r.addSheet.properties.title);
    }
    const WRITES=[
      {sheet:'VIDEO_SCRIPT',rows:[['Section','Speaker','Card_Main','Card_Sub','Card_Desc','Highlight_Word','Script','BG_File','Animation','Card_Style','Status','Note','BG_Effect','BG_Transition','Card_ExtraEffect','Lottie_File','Sticker_File','Gradient_Preset']]},
      {sheet:'CRYPTO_BIRTH_CHARTS',rows:[['Symbol','Name','Network_Start','Location','Lagna','Sun','Moon','Mars','Mercury','Jupiter','Venus','Saturn','Rahu','Ketu','Current_Dasha','Dasha_End','Notes']]},
      {sheet:'SOURCE_FILES',rows:[['Type','Filename','Duration_Sec','Category','Tags','Notes','Last_Sync']]},
      {sheet:'PROMO_SOURCES',rows:[['Type','Filename','Duration_Sec','Category','Tags','Notes','Last_Sync']]},
      {sheet:'EFFECTS_CATALOG',rows:EFFECTS_CATALOG_DATA},
      {sheet:'VOICE_CONFIG',rows:VOICE_CONFIG_DATA},
      {sheet:'SECTION_PRESETS',rows:SECTION_PRESETS_DATA},
      {sheet:'VIDEO_META_TEMPLATE',rows:VIDEO_META_TEMPLATE_DATA},
    ];
    for(const w of WRITES){
      const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent(w.sheet+'!A1')}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:`Bearer ${gTok}`,'Content-Type':'application/json'},body:JSON.stringify({values:w.rows})},20000);
      result.headers_written[w.sheet]=r.ok?`✅ ${w.rows.length}행`:`❌ ${r.status}`;
    }
    result.success=Object.values(result.headers_written).every(v=>v.startsWith('✅'));
    result.url=`https://docs.google.com/spreadsheets/d/${ssId}`;
    result.total_sheets=ALL_VIDEO_SHEETS.length;
    result.effects_catalog_rows=EFFECTS_CATALOG_DATA.length-1;
    return result;
  }

  if(n==='video_create_script'){
    const gTok=await getGCPToken();if(!gTok)return{error:'GCP ADC 인증 실패'};
    const ssId=a.spreadsheet_id||ARCHIVE_SS_ID;
    const today=new Date().toISOString().slice(0,10).replace(/-/g,'');
    const sheetName=`VS_${a.coin}_${a.date||today}`;
    const cr=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}:batchUpdate`,{method:'POST',headers:{Authorization:`Bearer ${gTok}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{addSheet:{properties:{title:sheetName}}}]})},15000);
    if(!cr.ok){const et=await cr.text();if(!et.includes('already exists')&&!et.includes('A sheet with the name'))return{error:`시트 생성 실패 ${cr.status}`};}
    const metaRows=[
      ['[VIDEO_META]','YouTube_Title',a.video_meta?.youtube_title||''],
      ['','Top_Watermark',a.video_meta?.top_watermark||''],
      ['','Thumbnail_Text',a.video_meta?.thumbnail_text||''],
      ['','Main_BGM',a.video_meta?.main_bgm||''],
      [''],
      ['Section','Speaker','Card_Main','Card_Sub','Card_Desc','Highlight_Word','Script','BG_File','Animation','Card_Style','Status','Note','BG_Effect','BG_Transition','Card_ExtraEffect','Lottie_File','Sticker_File','Gradient_Preset'],
      ...(a.script_rows||[]).map(r=>[r.Section||'',String(r.Speaker||'1'),r.Card_Main||'',r.Card_Sub||'',r.Card_Desc||'',r.Highlight_Word||'',r.Script||'',r.BG_File||'',r.Animation||'A',r.Card_Style||'DEFAULT','READY',r.Note||'',r.BG_Effect||'NONE',r.BG_Transition||'FADE',r.Card_ExtraEffect||'NONE',r.Lottie_File||'NONE',r.Sticker_File||'NONE',r.Gradient_Preset||'DEFAULT'])
    ];
    const wr=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent(sheetName+'!A1')}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:`Bearer ${gTok}`,'Content-Type':'application/json'},body:JSON.stringify({values:metaRows})},15000);
    return{success:wr.ok,sheet_name:sheetName,total_rows:metaRows.length,script_rows:a.script_rows?.length||0,columns:'A-R (18컬럼)',url:`https://docs.google.com/spreadsheets/d/${ssId}`};
  }

  if(n==='video_read_script'){
    const gTok=await getGCPToken();if(!gTok)return{error:'GCP ADC 인증 실패'};
    const ssId=a.spreadsheet_id||ARCHIVE_SS_ID;
    const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent(a.sheet_name)}`,{headers:{Authorization:`Bearer ${gTok}`}},10000);
    if(!r.ok)return{error:`읽기 실패 ${r.status}`};
    const rows=((await r.json()).values)||[];
    const meta={};let scriptStart=-1;
    for(let i=0;i<rows.length;i++){if(rows[i][0]==='Section'){scriptStart=i+1;break;}if(rows[i][1]&&rows[i][0]!=='[VIDEO_META]')meta[rows[i][1]]=rows[i][2]||'';}
    const hdr=['Section','Speaker','Card_Main','Card_Sub','Card_Desc','Highlight_Word','Script','BG_File','Animation','Card_Style','Status','Note','BG_Effect','BG_Transition','Card_ExtraEffect','Lottie_File','Sticker_File','Gradient_Preset'];
    const scriptRows=scriptStart>=0?rows.slice(scriptStart).map(r=>Object.fromEntries(hdr.map((k,i)=>[k,r[i]||'']))).filter(r=>r.Section):[];
    return{sheet_name:a.sheet_name,video_meta:meta,script_rows:scriptRows,total_script_rows:scriptRows.length};
  }

  if(n==='video_update_row_status'){
    const gTok=await getGCPToken();if(!gTok)return{error:'GCP ADC 인증 실패'};
    const ssId=a.spreadsheet_id||ARCHIVE_SS_ID;
    const sheetRow=a.row_index+7;
    const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent(a.sheet_name+'!K'+sheetRow)}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:`Bearer ${gTok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[[a.status||'DONE']]})},10000);
    return{success:r.ok,sheet_name:a.sheet_name,row_index:a.row_index,sheet_row:sheetRow,status:a.status};
  }

  if(n==='video_delete_script'){
    const gTok=await getGCPToken();if(!gTok)return{error:'GCP ADC 인증 실패'};
    const ssId=a.spreadsheet_id||ARCHIVE_SS_ID;
    const si=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}?fields=sheets.properties`,{headers:{Authorization:`Bearer ${gTok}`}},10000);
    if(!si.ok)return{error:`SS 조회 실패 ${si.status}`};
    const sh=((await si.json()).sheets||[]).find(s=>s.properties.title===a.sheet_name);
    if(!sh)return{error:`시트 없음: ${a.sheet_name}`};
    const dr=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}:batchUpdate`,{method:'POST',headers:{Authorization:`Bearer ${gTok}`,'Content-Type':'application/json'},body:JSON.stringify({requests:[{deleteSheet:{sheetId:sh.properties.sheetId}}]})},10000);
    return{success:dr.ok,deleted:a.sheet_name};
  }

  if(n==='init_btr_sheets'){
    const ssId=a.spreadsheet_id||ARCHIVE_SS_ID;
    const result={spreadsheet_id:ssId,timestamp:new Date().toISOString()};
    if(tok){try{const ui=await fetchWithTimeout('https://www.googleapis.com/oauth2/v2/userinfo',{headers:{Authorization:`Bearer ${tok}`}},8000);if(ui.ok){const ud=await ui.json();result.oauth_email=ud.email;result.oauth_name=ud.name;}}catch(e){result.oauth_email_error=e.message;}try{const ti=await fetchWithTimeout(`https://www.googleapis.com/oauth2/v1/tokeninfo?access_token=${tok}`,{},5000);if(ti.ok){const td=await ti.json();result.oauth_scopes=td.scope?.split(' ')||[];result.has_spreadsheets_scope=result.oauth_scopes.some(s=>s.includes('spreadsheets'));}}catch(e){result.scope_check_error=e.message;}}
    if(result.has_spreadsheets_scope===false){const cid=process.env.GOOGLE_CLIENT_ID||'';const scopes=encodeURIComponent(['https://www.googleapis.com/auth/drive','https://www.googleapis.com/auth/spreadsheets','https://www.googleapis.com/auth/documents','https://www.googleapis.com/auth/script.projects','https://www.googleapis.com/auth/cloud-platform'].join(' '));result.diagnosis='MISSING_SPREADSHEETS_SCOPE';result.action='GOOGLE_REFRESH_TOKEN 재발급 필요';if(cid)result.regenerate_oauth_url=`https://accounts.google.com/o/oauth2/v2/auth?client_id=${cid}&redirect_uri=http://localhost:3000&response_type=code&scope=${scopes}&access_type=offline&prompt=consent`;return result;}
    const ssInfo=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}?fields=sheets.properties.title`,{headers:{Authorization:`Bearer ${tok}`}},10000);
    if(!ssInfo.ok){result.ss_access_status=ssInfo.status;result.diagnosis=ssInfo.status===403?'SS_PERMISSION_DENIED':'SS_ACCESS_ERROR';result.action=`Archive SS를 ${result.oauth_email||'oauth 계정'}에게 편집자로 공유하세요`;return result;}
    const ssData=await ssInfo.json();const existingSheets=(ssData.sheets||[]).map(s=>s.properties.title);result.existing_sheets=existingSheets;
    const toCreate=[];if(!existingSheets.includes('BTRRuntime'))toCreate.push({addSheet:{properties:{title:'BTRRuntime'}}});if(!existingSheets.includes('BTRNotifications'))toCreate.push({addSheet:{properties:{title:'BTRNotifications'}}});
    if(toCreate.length>0){const cr=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}:batchUpdate`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({requests:toCreate})},15000);if(!cr.ok){result.create_sheets_status=cr.status;result.diagnosis='CREATE_SHEETS_FAILED';return result;}result.sheets_created=toCreate.map(r=>r.addSheet.properties.title);}else{result.sheets_existed=['BTRRuntime','BTRNotifications'];}
    const rh=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent('BTRRuntime!A1')}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[['session_id','structure_code','round','sclass_passed','candidate_slots','agreement_score','entropy_score','conflict_axis','next_action','status','created_at','updated_at','evolution_folder_id','heartbeat_time','heartbeat_step','gem_score','cl_score','gpt_score','critical_issues','suggestions','analysis_summary']]})},10000);
    result.btrruntime_header=rh.ok?'✅ 21컬럼':`❌ ${rh.status}`;
    const nh=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ssId}/values/${encodeURIComponent('BTRNotifications!A1')}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[['id','session_id','type','title','content','status','created_at']]})},10000);
    result.btrnotifications_header=nh.ok?'✅ 7컬럼':`❌ ${nh.status}`;
    result.success=rh.ok&&nh.ok;result.diagnosis=result.success?'ALL_OK':'PARTIAL';return result;
  }

  if(n==='btr_init_candidate_slots'){const[h,m]=a.birth_time_estimate.split(':').map(Number);const rng=a.range_minutes||120,iv=a.interval_minutes||15,sl=[];for(let o=-rng;o<=rng;o+=iv){const t=h*60+m+o;sl.push(`${Math.floor(((t%1440)+1440)%1440/60).toString().padStart(2,'0')}:${(((t%1440)+1440)%60).toString().padStart(2,'0')}`)}return{candidate_slots:[...new Set(sl)],count:new Set(sl).size};}
  if(n==='btr_consensus_analyzer'){const s=[a.gem_score,a.cl_score,a.gpt_score],avg=s.reduce((x,y)=>x+y,0)/3,v=s.reduce((x,y)=>x+Math.pow(y-avg,2),0)/3;return{agreement_score:+(avg/100).toFixed(3),entropy_score:+(v/1000).toFixed(3),avg_score:+avg.toFixed(1),consensus:avg>=97?'S_CLASS_CANDIDATE':'CONTINUE'};}
  if(n==='btr_conflict_axis_finder'){const mn=Math.min(...a.scores),mx=Math.max(...a.scores);return{score_range:mx-mn,conflict_detected:mx-mn>15,conflict_axis:mx-mn>15?'score_divergence_critical':'minor_variation'};}
  if(n==='validate_sclass_gate'){const s=[a.gem_score,a.cl_score,a.gpt_score],ap=s.every(x=>x>=97),nc=!a.critical_issues||a.critical_issues.length===0,p=ap&&nc;return{session_id:a.session_id,sclass_passed:p,all_above_97:ap,no_critical_issues:nc,action:p?'CONFIRM_BTR':'CONTINUE_RUBRIC'};}
  if(n==='create_btr_session'){const ts=new Date().toISOString(),sid=`BTR-${a.structure_code}-${Date.now()}`,fb={name:sid,mimeType:'application/vnd.google-apps.folder'};if(a.parent_folder_id)fb.parents=[a.parent_folder_id];const fr=await fetchWithTimeout('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink',{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify(fb)});if(!fr.ok)return{error:`폴더 생성 실패 ${fr.status}`};const f=await fr.json();await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({majorDimension:'ROWS',values:[[sid,a.structure_code,'0','false','[]','0','1.0','','L0_physics','ACTIVE',ts,ts,f.id,ts,'INIT','','','','','','']]})});return{success:true,session_id:sid,evolution_folder_id:f.id,evolution_folder_url:f.webViewLink};}
  if(n==='save_runtime_snapshot'){const ts=new Date().toISOString();const rr=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${tok}`}});if(!rr.ok)return{error:`읽기 실패 ${rr.status}`};const rows=((await rr.json()).values)||[],hdr=rows[0]||[],ri=rows.findIndex((r,i)=>i>0&&r[0]===a.session_id);if(ri<0)return{error:`세션 없음: ${a.session_id}`};const idx=k=>hdr.indexOf(k),row=[...rows[ri]];['round','candidate_slots','agreement_score','entropy_score','conflict_axis','next_action','status','gem_score','cl_score','gpt_score'].forEach(k=>{const i=idx(k);if(i>=0&&a[k]!=null)row[i]=typeof a[k]==='object'?JSON.stringify(a[k]):String(a[k]);});['critical_issues','suggestions'].forEach(k=>{const i=idx(k);if(i>=0&&a[k]!=null)row[i]=Array.isArray(a[k])?JSON.stringify(a[k]):String(a[k]);});const aiIdx=idx('analysis_summary');if(aiIdx>=0&&a.analysis_summary!=null)row[aiIdx]=String(a.analysis_summary);if(idx('updated_at')>=0)row[idx('updated_at')]=ts;await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A'+(ri+1))}?valueInputOption=RAW`,{method:'PUT',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});return{success:true,session_id:a.session_id};}
  if(n==='get_runtime_snapshot'){const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)return{error:`읽기 실패 ${r.status}`};const rows=((await r.json()).values)||[],hdr=rows[0]||[],row=rows.find((r,i)=>i>0&&r[0]===a.session_id);if(!row)return{error:'세션 없음'};const snap=Object.fromEntries(hdr.map((k,i)=>[k,row[i]||'']));try{if(snap.critical_issues)snap.critical_issues=JSON.parse(snap.critical_issues);}catch{}try{if(snap.suggestions)snap.suggestions=JSON.parse(snap.suggestions);}catch{}return snap;}
  if(n==='save_evolution_log'){const c=JSON.stringify({session_id:a.session_id,round:a.round,...a.log_data,timestamp:new Date().toISOString()},null,2),fn=`R${String(a.round).padStart(2,'0')}_${Date.now()}.json`,meta=JSON.stringify({name:fn,parents:[a.evolution_folder_id],mimeType:'application/json'}),body=`--b\r\nContent-Type: application/json\r\n\r\n${meta}\r\n--b\r\nContent-Type: application/json\r\n\r\n${c}\r\n--b--`;const r=await fetchWithTimeout('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'multipart/related; boundary=b'},body});if(!r.ok)return{error:`저장 실패 ${r.status}`};return{success:true,file_id:(await r.json()).id};}
  if(n==='get_evolution_history'){const r=await fetchWithTimeout(`https://www.googleapis.com/drive/v3/files?q='${a.evolution_folder_id}'+in+parents&orderBy=name&fields=files(id,name,modifiedTime,size)`,{headers:{Authorization:`Bearer ${tok}`}});return r.ok?await r.json():{error:`폴더 조회 실패 ${r.status}`};}
  if(n==='btr_re_eval_pivots')return{evaluated_slots:a.candidate_slots,conflict_axis:a.conflict_axis};
  if(n==='btr_weight_adjuster')return{session_id:a.session_id,adjusted_weights:{event_bukhti_fit:a.event_count>=3?40:25,d9_alignment:20,appearance_temperament:a.has_appearance_data?15:8,sandhi_transition:15,logic_consistency_bonus:10}};
  if(n==='btr_prediction_tester')return{candidate_time:a.candidate_time,status:'MANUAL_VERIFICATION_RECOMMENDED'};
  if(n==='purge_runtime_state'){const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET)}`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)return{error:'읽기 실패'};const rows=((await r.json()).values)||[],idx=rows.findIndex((r,i)=>i>0&&r[0]===a.session_id);if(idx<0)return{error:'세션 없음'};await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent(RUNTIME_SHEET+'!A'+(idx+1))}?valueInputOption=RAW`,{method:'PUT',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[Array(rows[0]?.length||21).fill('')]})});return{success:true};}
  if(n==='btr_write_notification'){const notifId=await writeNotification(tok,a.session_id,a.type,a.title,a.content);return{success:true,notification_id:notifId,type:a.type};}
  if(n==='btr_finalize_confirmed'){const updates={BTRStatus:'Confirmed',AnalysisScore:String(a.final_score),...(a.analysis_doc_url?{AnalysisDocs:a.analysis_doc_url}:{}),...(a.confirmed_birth_time?{BTR:a.confirmed_birth_time}:{})};const result=await updateArchiveRow(tok,a.structure_code,updates);if(result.error)return{error:'Archive 업데이트 실패: '+result.error};return{success:true,structure_code:a.structure_code,btr_status:'Confirmed'};}
  if(n==='btr_finalize_held'){const noteContent=[a.failure_summary,a.highest_score?`최고점수: ${a.highest_score}점`:null,a.best_candidate_time?`유력후보: ${a.best_candidate_time}`:null].filter(Boolean).join(' | ');await updateArchiveRow(tok,a.structure_code,{BTRStatus:'Held',...(noteContent?{BTRStageNote:noteContent}:{})}).catch(()=>{});return{success:true,structure_code:a.structure_code,btr_status:'Held'};}
  return{error:`미구현: ${n}`};
}

async function execGCloud(n,a){
  const proj=a.project||GCP_PROJECT,reg=a.region||GCP_REGION;
  const tok=await getGCPToken();if(!tok)return{error:'GCP ADC 인증 실패'};
  if(n==='gcloud_submit'){const steps=a.commands.map(cmd=>({name:'gcr.io/google.com/cloudsdktool/cloud-sdk',entrypoint:'bash',args:['-c',cmd]}));const r=await fetchWithTimeout(`https://cloudbuild.googleapis.com/v1/projects/${proj}/builds`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({steps,options:{logging:'CLOUD_LOGGING_ONLY'}})},30000);if(!r.ok)return{error:`Cloud Build ${r.status}: ${await r.text()}`};const d=await r.json();return{buildId:d.metadata?.build?.id||d.name?.split('/').pop(),status:'QUEUED'};}
  if(n==='cloudbuild_status'){const r=await fetchWithTimeout(`https://cloudbuild.googleapis.com/v1/projects/${proj}/builds/${a.buildId}`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)return{error:`CloudBuild ${r.status}`};const d=await r.json();return{status:d.status,id:d.id,steps:(d.steps||[]).map(s=>({name:s.name,status:s.status,timing:s.timing})),logUrl:d.logUrl};}
  if(n==='cloudrun_services'){const r=await fetchWithTimeout(`https://run.googleapis.com/v2/projects/${proj}/locations/${reg}/services`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)return{error:`Cloud Run ${r.status}`};const d=await r.json();return{services:(d.services||[]).map(s=>({name:s.name?.split('/').pop(),url:s.uri,revision:s.latestReadyRevision?.split('/').pop(),updated:s.updateTime}))};}
  if(n==='artifact_list'){const loc=a.location||GCP_REGION,url=a.repository?`https://artifactregistry.googleapis.com/v1/projects/${proj}/locations/${loc}/repositories/${a.repository}/dockerImages`:`https://artifactregistry.googleapis.com/v1/projects/${proj}/locations/${loc}/repositories`;const r=await fetchWithTimeout(url,{headers:{Authorization:`Bearer ${tok}`}});return r.ok?await r.json():{error:`Artifact ${r.status}`};}
  if(n==='cloudrun_set_env'){const{service,envVars}=a,gr=await fetchWithTimeout(`https://run.googleapis.com/v2/projects/${proj}/locations/${reg}/services/${service}`,{headers:{Authorization:`Bearer ${tok}`}});if(!gr.ok)return{error:`Cloud Run GET ${gr.status}`};const svc=await gr.json(),em={};(svc.template?.containers?.[0]?.env||[]).forEach(e=>{em[e.name]=e.value;});Object.assign(em,envVars);const pr=await fetchWithTimeout(`https://run.googleapis.com/v2/projects/${proj}/locations/${reg}/services/${service}`,{method:'PATCH',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({template:{containers:[{...svc.template?.containers?.[0],env:Object.entries(em).map(([k,v])=>({name:k,value:v}))}]}})});if(!pr.ok)return{error:`Cloud Run PATCH ${pr.status}: ${await pr.text()}`};return{success:true,service,updatedVars:Object.keys(envVars)};}
  if(n==='agent_registry_list'){const loc=a.location||GCP_REGION,res={};const r1=await fetchWithTimeout(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/${loc}/services`,{headers:{Authorization:`Bearer ${tok}`}});const t1=await r1.text();res[loc]={status:r1.status,ok:r1.ok,data:r1.ok?(()=>{try{return JSON.parse(t1);}catch{return t1;}})():t1};if(loc!=='global'){const r2=await fetchWithTimeout(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/global/services`,{headers:{Authorization:`Bearer ${tok}`}});const t2=await r2.text();res['global']={status:r2.status,ok:r2.ok,data:r2.ok?(()=>{try{return JSON.parse(t2);}catch{return t2;}})():t2};}return res;}
  if(n==='agent_registry_register'){const loc=a.location||GCP_REGION,endpointUrl=a.endpoint_url||`${MCP_URL}/mcp`,displayName=a.display_name||'ASTERION AI Evolution Engine',serviceId=a.service_id||'asterion-mcp';const delR=await fetchWithTimeout(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/${loc}/services/${serviceId}`,{method:'DELETE',headers:{Authorization:`Bearer ${tok}`}});const toolContent={tools:ALL_TOOLS.map(t=>({name:t.name,description:t.description,inputSchema:{type:'object'}}))};const body={displayName,interfaces:[{url:endpointUrl,protocolBinding:'JSONRPC'}],mcpServerSpec:{type:'TOOL_SPEC',content:toolContent}};const r=await fetchWithTimeout(`https://agentregistry.googleapis.com/v1alpha/projects/${proj}/locations/${loc}/services?serviceId=${serviceId}`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify(body)});const text=await r.text();let parsed;try{parsed=JSON.parse(text);}catch{parsed=text;}if(r.ok&&parsed.name){let op=parsed;for(let i=0;i<15&&!op.done;i++){await new Promise(res=>setTimeout(res,2000));const pr=await fetchWithTimeout(`https://agentregistry.googleapis.com/v1alpha/${op.name}`,{headers:{Authorization:`Bearer ${tok}`}});if(pr.ok)op=await pr.json();}return{status:r.status,ok:r.ok,location:loc,endpoint:endpointUrl,serviceId,tools_count:ALL_TOOLS.length,operation_done:op.done,result:op.response||op};}return{status:r.status,ok:r.ok,location:loc,endpoint:endpointUrl,serviceId,response:parsed};}
  return{error:`미구현: ${n}`};
}

async function execSystem(n,a){
  if(n==='github_read_file'){if(!GITHUB_PAT)return{error:'GITHUB_PAT 미설정'};const{repo,path,branch='main'}=a;const r=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,{headers:ghH()},15000);if(!r.ok)return{error:`GitHub ${r.status}: ${await r.text()}`};const d=await r.json();return{path:d.path,sha:d.sha,size:d.size,content:Buffer.from(d.content,'base64').toString('utf8')};}
  if(n==='github_write_file'){if(!GITHUB_PAT)return{error:'GITHUB_PAT 미설정'};const{repo,path,content,message,branch='main'}=a;let sha;const ex=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,{headers:ghH()},15000);if(ex.ok)sha=(await ex.json()).sha;const r=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}`,{method:'PUT',headers:ghH(),body:JSON.stringify({message,content:Buffer.from(content).toString('base64'),branch,...(sha?{sha}:{})})},20000);if(!r.ok)return{error:`GitHub ${r.status}: ${await r.text()}`};const d=await r.json();return{success:true,commit:d.commit?.sha,note:'Cloud Build 자동배포 트리거됨'};}
  if(n==='github_list_files'){if(!GITHUB_PAT)return{error:'GITHUB_PAT 미설정'};const{repo,path='',branch='main'}=a;const r=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,{headers:ghH()},15000);if(!r.ok)return{error:`GitHub ${r.status}`};const d=await r.json();return{files:(Array.isArray(d)?d:[d]).map(f=>({name:f.name,type:f.type,size:f.size,path:f.path}))};}
  if(n==='gh_push_files'){if(!GITHUB_PAT)return{error:'GITHUB_PAT 미설정'};const{repo,branch='main',message,files}=a;if(!files?.length)return{error:'files 배열 필요'};const h=ghH();const refR=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/ref/heads/${branch}`,{headers:h},15000);if(!refR.ok)return{error:`브랜치 조회 실패 ${refR.status}`};const headSha=(await refR.json()).object.sha;const commitR=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/commits/${headSha}`,{headers:h},15000);if(!commitR.ok)return{error:`커밋 조회 실패 ${commitR.status}`};const treeSha=(await commitR.json()).tree.sha;const treeItems=files.map(f=>({path:f.path,mode:'100644',type:'blob',content:f.content}));const treeR=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/trees`,{method:'POST',headers:h,body:JSON.stringify({base_tree:treeSha,tree:treeItems})},20000);if(!treeR.ok)return{error:`트리 생성 실패 ${treeR.status}`};const newTreeSha=(await treeR.json()).sha;const newCommitR=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/commits`,{method:'POST',headers:h,body:JSON.stringify({message,tree:newTreeSha,parents:[headSha]})},15000);if(!newCommitR.ok)return{error:`커밋 생성 실패 ${newCommitR.status}`};const newCommitSha=(await newCommitR.json()).sha;const updateR=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/git/refs/heads/${branch}`,{method:'PATCH',headers:h,body:JSON.stringify({sha:newCommitSha,force:false})},15000);if(!updateR.ok)return{error:`브랜치 업데이트 실패 ${updateR.status}`};return{success:true,commit:newCommitSha,files_count:files.length,files:files.map(f=>f.path)};}
  // ★ FIX: 세미콜론 제거됨
  if(['sheets_read','sheets_write','append_sheet_row'].includes(n)){
    const tok=await getGoogleToken();if(!tok)return{error:'Google 인증 실패'};
    if(n==='sheets_read'){const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/${encodeURIComponent(a.range)}`,{headers:{Authorization:`Bearer ${tok}`}});if(!r.ok)return{error:`Sheets ${r.status}`};const d=await r.json();return{values:d.values||[],range:d.range};}
    if(n==='sheets_write'){const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/${encodeURIComponent(a.range)}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:a.values})});return r.ok?await r.json():{error:`Sheets ${r.status}`};}
    if(n==='append_sheet_row'){const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${a.spreadsheetId}/values/${encodeURIComponent(a.range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[a.values]})});return r.ok?await r.json():{error:`Sheets ${r.status}`};}
  }
  if(n==='http_request'){const{url,method='GET',body,headers={}}=a;const opts={method,headers:{'Content-Type':'application/json',...headers}};if(body&&method!=='GET')opts.body=JSON.stringify(body);const r=await fetchWithTimeout(url,opts,30000);try{return{status:r.status,ok:r.ok,data:await r.json()};}catch{return{status:r.status,ok:r.ok,data:await r.text()};}}
  if(n==='github_patch_file'){
    if(!GITHUB_PAT)return{error:'GITHUB_PAT 미설정'};
    const{repo,path,patches,message,branch='main'}=a;
    if(!patches?.length)return{error:'patches 배열 필요'};
    const ex=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}?ref=${branch}`,{headers:ghH()},15000);
    if(!ex.ok)return{error:`파일 없음: GitHub ${ex.status}`};
    const fd=await ex.json();
    let fc=Buffer.from(fd.content,'base64').toString('utf8');
    const fsha=fd.sha;
    const res=[];
    for(const p of patches){
      if(!fc.includes(p.find)){res.push({find:p.find.slice(0,60),status:'NOT_FOUND'});continue;}
      const escaped=p.find.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const cnt=(fc.match(new RegExp(escaped,'g'))||[]).length;
      if(cnt>1){res.push({find:p.find.slice(0,60),status:'AMBIGUOUS',count:cnt});continue;}
      fc=fc.replace(p.find,p.replace);
      res.push({find:p.find.slice(0,60),status:'APPLIED'});
    }
    const applied=res.filter(r=>r.status==='APPLIED').length;
    if(!applied)return{error:'적용된 패치 없음',results:res};
    const wr=await fetchWithTimeout(`https://api.github.com/repos/${GITHUB_OWNER}/${repo}/contents/${path}`,{method:'PUT',headers:ghH(),body:JSON.stringify({message,content:Buffer.from(fc).toString('base64'),branch,sha:fsha})},20000);
    if(!wr.ok)return{error:`GitHub write ${wr.status}: ${(await wr.text()).slice(0,200)}`};
    const rd=await wr.json();
    return{success:true,commit:rd.commit?.sha,patches_applied:applied,total:patches.length,results:res,note:'자동배포 트리거됨'};
  }
  if(n==='sheets_update_row'){
    const tok=await getGoogleToken();if(!tok)return{error:'Google 인증 실패'};
    const{spreadsheetId,range,key_column,key_value,updates}=a;
    const r=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,{headers:{Authorization:`Bearer ${tok}`}});
    if(!r.ok)return{error:`Sheets 읽기 ${r.status}`};
    const rows=((await r.json()).values)||[];
    const hdr=rows[0]||[];
    const ki=hdr.indexOf(key_column);
    if(ki<0)return{error:`키 컬럼 없음: ${key_column}. 헤더: [${hdr.join(',')}]`};
    const ri=rows.findIndex((row,i)=>i>0&&row[ki]===String(key_value));
    if(ri<0)return{error:`키 값 없음: ${key_value}`};
    const row=[...rows[ri]];while(row.length<hdr.length)row.push('');
    const upd=[];
    Object.entries(updates).forEach(([k,v])=>{const ci=hdr.indexOf(k);if(ci>=0){row[ci]=v==null?'':String(v);upd.push(k);}});
    if(!upd.length)return{error:'업데이트할 컬럼 없음. 헤더: ['+hdr.join(',')+']'};
    const sn=range.split('!')[0];
    const wr=await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(`${sn}!A${ri+1}`)}?valueInputOption=USER_ENTERED`,{method:'PUT',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({values:[row]})});
    if(!wr.ok)return{error:`Sheets 쓰기 ${wr.status}`};
    return{success:true,row_index:ri,sheet_row:ri+1,key:`${key_column}=${key_value}`,updated_columns:upd};
  }
  if(n==='get_system_status'){const[mcp]=await Promise.allSettled([fetchWithTimeout(`${MCP_URL}/`).then(r=>r.json())]);return{mcp_server:mcp.status==='fulfilled'?{ok:true,server:mcp.value?.server,tools:mcp.value?.totalTools}:{ok:false},github_pat:GITHUB_PAT?'✓':'✗',google_oauth:process.env.GOOGLE_REFRESH_TOKEN?'✓':'✗',gcp_adc:(await getGCPToken())?'✓ ADC 정상':'✗',timestamp:new Date().toISOString()};}
  return{error:`미구현: ${n}`};
}

async function execWorkspace(n,a){
  const tok=await getGoogleToken();if(!tok)return{error:'Google OAuth 인증 실패.'};
  if(n==='docs_patch'){
    const{document_id,patches}=a;
    if(!patches?.length)return{error:'patches 배열 필요'};
    const requests=patches.map(p=>({replaceAllText:{containsText:{text:p.find,matchCase:true},replaceText:p.replace}}));
    const r=await fetchWithTimeout(`https://docs.googleapis.com/v1/documents/${document_id}:batchUpdate`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({requests})});
    if(!r.ok)return{error:`Docs ${r.status}: ${(await r.text()).slice(0,200)}`};
    const result=await r.json();
    const summary=(result.replies||[]).map((rep,i)=>({find:patches[i]?.find?.slice(0,60),occurrences:rep.replaceAllText?.occurrencesChanged||0}));
    return{success:true,total_changed:summary.reduce((s,x)=>s+x.occurrences,0),patches:summary};
  }
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
  const antiAnchoredCtx=buildAntiAnchoredContext(a.previous_round_context);
  if(n==='call_gemini'){const key=process.env.GEMINI_API_KEY;if(!key)return{error:'GEMINI_API_KEY 미설정'};const model=a.model||'gemini-3.1-pro-preview';const defaultSys=`<role>ASTERION BTR rubric analyst</role>\n<rubric total="100"><criterion id="event_fit" max="40"/><criterion id="navamsa_d9" max="20"/><criterion id="appearance" max="15"/><criterion id="sandhi" max="15"/><criterion id="consistency" max="10"/></rubric>\n<hard_stop>all_scores≥97 AND critical_issues=[] → S-Class CONFIRMED</hard_stop>\n<anti_anchoring_rule>Evaluate INDEPENDENTLY.</anti_anchoring_rule>\n<output_format>{"candidate_time":"HH:MM","analysis":"string","scores":{"event_fit":0,"navamsa_d9":0,"appearance":0,"sandhi":0,"consistency":0},"total":0,"critical_issues":[],"suggestions":[],"confidence":"LOW|MEDIUM|HIGH"}</output_format>\n<lang>Respond in Korean</lang>`;const sys=(a.system_prompt||defaultSys)+antiAnchoredCtx;const r=await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({systemInstruction:{parts:[{text:sys}]},contents:[{role:'user',parts:[{text:a.prompt}]}],thinkingConfig:{thinkingLevel:'high'},generationConfig:{maxOutputTokens:8192,temperature:0.7}})},60000);if(!r.ok)throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0,200)}`);const d=await r.json();return{text:d.candidates?.[0]?.content?.parts?.[0]?.text||'',model};}
  if(n==='call_claude'){const key=process.env.ANTHROPIC_API_KEY;if(!key)return{error:'ANTHROPIC_API_KEY 미설정'};const model=a.model||'claude-sonnet-4-6';const defaultSys=`<role>ASTERION BTR rubric analyst</role>\n<anti_anchoring_rule>Evaluate INDEPENDENTLY.</anti_anchoring_rule>\n<output_format>{"candidate_time":"HH:MM","analysis":"string","scores":{"event_fit":0,"navamsa_d9":0,"appearance":0,"sandhi":0,"consistency":0},"total":0,"critical_issues":[],"suggestions":[]}</output_format>\n<lang>Respond in Korean</lang>`;const sys=(a.system_prompt||defaultSys)+antiAnchoredCtx;const r=await fetchWithTimeout('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model,max_tokens:a.max_tokens||8000,system:sys,thinking:{type:'enabled',budget_tokens:5000},messages:[{role:'user',content:a.prompt}]})},60000);if(!r.ok)throw new Error(`Claude ${r.status}: ${(await r.text()).slice(0,200)}`);const d=await r.json();return{text:d.content?.find(b=>b.type==='text')?.text||'',model};}
  if(n==='call_gpt'){const key=process.env.OPENAI_API_KEY;if(!key)return{error:'OPENAI_API_KEY 미설정'};const model=a.model||'gpt-4o';const r=await fetchWithTimeout('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,max_tokens:a.max_tokens||8000,messages:[{role:'system',content:a.system_prompt||'베다 점성술 BTR 전문가.'},{role:'user',content:a.prompt}]})},60000);if(!r.ok)throw new Error(`GPT ${r.status}: ${(await r.text()).slice(0,200)}`);const d=await r.json();return{text:d.choices?.[0]?.message?.content||'',model};}
  return{error:`미구현: ${n}`};
}

async function execReportOps(n,a){
  const tok=await getGoogleToken();
  if(n==='report_generate_btr_code'){if(tok)await fetchWithTimeout(`https://sheets.googleapis.com/v4/spreadsheets/${ARCHIVE_SS_ID}/values/${encodeURIComponent('BTRRuntime!A1')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,{method:'POST',headers:{Authorization:`Bearer ${tok}`,'Content-Type':'application/json'},body:JSON.stringify({majorDimension:'ROWS',values:[[new Date().toISOString(),a.structure_code,'BTR_CONFIRMED',a.confirmed_birth_time,String(a.confidence_score),a.session_id]]})}).catch(()=>{});return{structure_code:a.structure_code,btr_confirmed:a.confirmed_birth_time,status:'CONFIRMED'};}
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
    if(method==='initialize')send({jsonrpc:'2.0',id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.11.1'}}});
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
  const params=body?.params;
  const ok=r=>res.json({jsonrpc:'2.0',id,result:r}),err=(c,m)=>res.json({jsonrpc:'2.0',id,error:{code:c,message:m}});
  try{
    if(req.method==='GET')return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.11.1'}});
    if(!body)return err(-32700,'Parse error');
    if(method==='initialize')return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.11.1'}});
    if(method==='notifications/initialized')return res.status(200).json({jsonrpc:'2.0'});
    if(method==='tools/list')return ok({tools:toolList});
    if(method==='tools/call'){const r=await executeTool(params?.name,params?.arguments||{});return ok({content:[{type:'text',text:JSON.stringify(r,null,2)}]});}
    if(method==='ping')return ok({});
    return err(-32601,`Not found: ${method}`);
  }catch(e){return res.status(500).json({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}});}
});
app.post('/',requireMcpAuth,async(req,res)=>{
  const body=req.body,id=body?.id??null,method=body?.method;
  const ok=r=>res.json({jsonrpc:'2.0',id,result:r}),err=(c,m)=>res.json({jsonrpc:'2.0',id,error:{code:c,message:m}});
  try{
    if(method==='initialize')return ok({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'ASTERION AI Evolution Engine',version:'5.11.1'}});
    if(method==='notifications/initialized')return res.status(200).json({jsonrpc:'2.0'});
    if(method==='tools/list')return ok({tools:toolList});
    if(method==='tools/call'){const r=await executeTool(body?.params?.name,body?.params?.arguments||{});return ok({content:[{type:'text',text:JSON.stringify(r,null,2)}]});}
    if(method==='ping')return ok({});
    return err(-32601,`Not found: ${method}`);
  }catch(e){return res.status(500).json({jsonrpc:'2.0',id,error:{code:-32603,message:e.message}});}
});
app.get('/',(_req,res)=>res.json({
  status:'running',server:'ASTERION AI Evolution Engine v5.12',
  transports:{mcp:'POST/GET/DELETE /mcp',sse:'GET /sse'},
  layers:{L0:`VedAstro(${L0.size})`,L1:`BTR+Video(${L1.size})`,L2:`GCloud(${L2.size})`,L3:`SystemOps(${L3.size})`,L4:`Workspace(${L4.size})`,L5:`AI(${L5.size})`,L6:`Report/Ops(${L6.size})`},
  totalTools:ALL_TOOLS.length,toolList:ALL_TOOLS.map(t=>t.name)
}));
app.listen(PORT,'0.0.0.0',()=>{
  console.log(`\n🔱 ASTERION AI Evolution Engine v5.11.1 | port:${PORT} | tools:${ALL_TOOLS.length}`);
  console.log(`   v5.12: +github_patch_file, +sheets_update_row, +docs_patch\n`);
});
