/**
 * dasha_overlay.js — v1.2 (2026-07)
 * 목적: VedAstro DasaAtRange 의존 제거. index.js는 한 바이트도 수정하지 않는다.
 * 방식: globalThis.fetch 를 감싸 '/Calculate/DasaAtRange' POST 만 가로채고,
 *       출생 달의 LAHIRI 항성 경도(AllPlanetData — get_planet_positions 와 동일 경로)로
 *       비심다샤를 서버에서 직접 계산해 기존 DasaAtRange 스키마 그대로 반환한다.
 * 배경: DasaAtRange 는 아야남사 미지정/시각 처리 불일치로 Swati 달(라후 시작)인 차트에
 *       Mars/Rahu 마하다샤를 반환하는 오류가 확인됨. 정답(두 후보 출생 모두)은 Jupiter.
 * 롤백: package.json 의 start 를 "node index.js" 로 되돌리면 오버레이 없이 원상복구.
 * 실패 정책: fail-loud — 내부 오류 시 Status:'Fail' + overlay_error 를 반환해
 *       조용히 구버전 동작으로 폴백하지 않는다(무음 오답 방지).
 * v1.1: 나크샤트라 철자 변형 접기(Swathi/Swati, Poorva/Purva 등) — crosscheck 거짓 경고 제거.
 * v1.2: VedAstro +00:00 falsy 버그 교정 — VedAstro는 0이 아닌 오프셋은 정확히 반영하지만
 *       +00:00/-00:00 은 무시하고 좌표 기반 현지시간으로 폴백한다(4점 실측: 187.4978/192.4544/196.1883/197.4358
 *       전부 스위스 천체력 예측과 소수 3~4자리 일치). (a) 오버레이의 달 fetch 는 항상 등가 +01:00 벽시계로 전송,
 *       (b) 그 외 모든 VedAstro GET 의 ±00:00 구간을 등가 +01:00 순간으로 자동 재작성 — natal 파이프라인까지 교정.
 */

const VEDASTRO_BASE = 'https://api.vedastro.org/api';
const VEDASTRO_KEY  = process.env.VEDASTRO_API_KEY || '';

const VIM_LORDS = ['Ketu','Venus','Sun','Moon','Mars','Rahu','Jupiter','Saturn','Mercury'];
const VIM_YRS   = {Ketu:7,Venus:20,Sun:6,Moon:10,Mars:7,Rahu:18,Jupiter:16,Saturn:19,Mercury:17};
const VIM_NAT   = {Jupiter:'Benefic',Venus:'Benefic',Moon:'Benefic',Mercury:'Benefic',
                   Sun:'Malefic',Mars:'Malefic',Saturn:'Malefic',Rahu:'Malefic',Ketu:'Malefic'};
const VIM_NAKS  = ['Ashwini','Bharani','Krittika','Rohini','Mrigashira','Ardra','Punarvasu','Pushya','Ashlesha',
                   'Magha','Purva Phalguni','Uttara Phalguni','Hasta','Chitra','Swati','Vishakha','Anuradha','Jyeshtha',
                   'Mula','Purva Ashadha','Uttara Ashadha','Shravana','Dhanishta','Shatabhisha',
                   'Purva Bhadrapada','Uttara Bhadrapada','Revati'];
const VIM_SIGNS = {Aries:0,Taurus:1,Gemini:2,Cancer:3,Leo:4,Virgo:5,Libra:6,Scorpio:7,
                   Sagittarius:8,Capricorn:9,Aquarius:10,Pisces:11};
const YEAR_MS   = 365.25 * 86400000; // 비심다샤 연 단위 (표준 소프트웨어 관례)
const NAK_DEG   = 360 / 27;

// ── 'HH:MM DD/MM/YYYY +HH:MM' (index.js 가 만드는 StdTime) → 파트+epoch(ms)
function parseStdTime(std) {
  const p = String(std || '').trim().split(/\s+/);
  if (p.length < 3) throw new Error('StdTime parse failed: ' + std);
  const [t, d, tz] = p;
  const [dd, mm, yyyy] = d.split('/');
  const ms = Date.parse(`${yyyy}-${mm}-${dd}T${t}:00${tz}`);
  if (!isFinite(ms)) throw new Error('StdTime epoch failed: ' + std);
  return { ms, t, dd, mm, yyyy, tz };
}

// ── 달 경도 견고 추출 (1차: PlanetNirayanaDegrees / 2차: RasiD1Sign / 3차: 딥스캔)
function deepFind(o, key, depth) {
  if (depth <= 0 || o == null || typeof o !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(o, key)) return o[key];
  for (const v of Object.values(o)) {
    const r = deepFind(v, key, depth - 1);
    if (r !== undefined) return r;
  }
  return undefined;
}
function extractMoonLongitude(payload) {
  let o = payload && payload.AllPlanetData;
  if (Array.isArray(o)) { const hit = o.find(x => x && x.Moon); o = hit ? hit.Moon : null; }
  else if (o && o.Moon) o = o.Moon;
  else if (payload && payload.Moon) o = payload.Moon;
  if (!o) o = payload; // 마지막 시도: 딥스캔이 아래에서 커버
  let lon = null;
  let nir = o && o.PlanetNirayanaDegrees;
  if (nir === undefined) nir = deepFind(payload, 'PlanetNirayanaDegrees', 6);
  if (nir != null) {
    const v = (typeof nir === 'object') ? (nir.TotalDegrees ?? nir.DegreeText ?? null) : nir;
    const f = parseFloat(v); if (isFinite(f)) lon = f;
  }
  if (lon == null) {
    let rs = o && o.PlanetRasiD1Sign;
    if (rs === undefined || rs === null) rs = deepFind(payload, 'PlanetRasiD1Sign', 6);
    if (rs) {
      const sn = rs.Name;
      const di = rs.DegreesIn;
      const dv = (di && typeof di === 'object') ? di.TotalDegrees : di;
      const f = parseFloat(dv);
      if (sn in VIM_SIGNS && isFinite(f)) lon = VIM_SIGNS[sn] * 30 + f;
    }
  }
  if (lon == null) {
    const keys = o && typeof o === 'object' ? Object.keys(o).slice(0, 30) : String(o);
    throw new Error('moon_longitude_unparsable; moon_keys=' + JSON.stringify(keys));
  }
  lon = ((lon % 360) + 360) % 360;
  let constel = o && o.PlanetConstellation;
  if (constel === undefined) constel = deepFind(payload, 'PlanetConstellation', 6);
  constel = constel == null ? '' : String(constel);
  const nk = Math.floor(lon / NAK_DEG);
  // 철자 변형 접기(Swathi/Swati, Poorva/Purva, -shtha/-shta 등) — 경고는 진짜 다른 나크샤트라일 때만
  const az = s => s.toLowerCase().replace(/[^a-z]/g, '').replace(/th/g, 't').replace(/sh/g, 's').replace(/oo/g, 'u').replace(/aa/g, 'a');
  const fc = az(constel), fn = az(VIM_NAKS[nk]);
  const xok = !constel || fc.indexOf(fn) === 0 || fn.indexOf(fc) === 0;
  return { lon, constel, xok };
}

// ── 출생 순간의 달 경도 fetch (get_planet_positions 와 동일 URL 규격 → 동일 LAHIRI)
async function fetchMoonLongitude(origFetch, loc, bt) {
  const la = loc && loc.Latitude, lo = loc && loc.Longitude;
  if (!isFinite(la) || !isFinite(lo)) throw new Error('birth Location lat/lon invalid');
  // VedAstro 는 +00:00 을 falsy 로 무시하고 좌표 현지시간으로 폴백한다(실측 확인).
  // 이미 정확히 파싱한 UT epoch(bt.ms)를 항상 0이 아닌 +01:00 등가 벽시계로 변환해 전송한다.
  const d1 = new Date(bt.ms + 3600000); const p2 = n => String(n).padStart(2, '0');
  const url = `${VEDASTRO_BASE}/Calculate/AllPlanetData/PlanetName/Moon/Location/${la},${lo}` +
              `/Time/${p2(d1.getUTCHours())}:${p2(d1.getUTCMinutes())}/${p2(d1.getUTCDate())}/${p2(d1.getUTCMonth()+1)}/${d1.getUTCFullYear()}/+01:00/Ayanamsa/LAHIRI`;
  const h = VEDASTRO_KEY ? { Authorization: `Bearer ${VEDASTRO_KEY}` } : {};
  const r = await origFetch(url, { headers: h, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`Moon fetch HTTP ${r.status}`);
  const j = await r.json();
  if (j.Status !== 'Pass') throw new Error('Moon fetch VedAstro: ' + JSON.stringify(j.Payload).slice(0, 200));
  return extractMoonLongitude(j.Payload);
}

// ── 비심다샤 타임라인 (마하 27개 = 3사이클, 첫 마하는 개념적 시작으로 역산)
function vimTimeline(moonLon, birthMs) {
  const nk = Math.floor(moonLon / NAK_DEG);
  const lord0 = VIM_LORDS[nk % 9];
  const frac = (moonLon - nk * NAK_DEG) / NAK_DEG;
  const start0 = birthMs - frac * VIM_YRS[lord0] * YEAR_MS;
  const mahas = []; let cur = start0; let idx = VIM_LORDS.indexOf(lord0);
  for (let k = 0; k < 27; k++) {
    const lord = VIM_LORDS[idx % 9];
    const e = cur + VIM_YRS[lord] * YEAR_MS;
    mahas.push({ lord, s: cur, e }); cur = e; idx++;
  }
  return { lord0, frac, nak: nk, pada: Math.floor(frac * 4) + 1,
           balance: (1 - frac) * VIM_YRS[lord0], mahas, birthMs };
}
function subPeriods(node) { // 상위 구간을 9개 하위 구간으로 (안타르/프라티안타르 공통)
  const out = []; const total = node.e - node.s; let cur = node.s;
  const i0 = VIM_LORDS.indexOf(node.lord);
  for (let k = 0; k < 9; k++) {
    const l = VIM_LORDS[(i0 + k) % 9];
    const seg = total * VIM_YRS[l] / 120;
    out.push({ lord: l, s: cur, e: cur + seg }); cur += seg;
  }
  out[8].e = node.e; // 부동소수 누적 보정
  return out;
}
function locate(tl, tMs) {
  const maha = tl.mahas.find(m => m.s <= tMs && tMs < m.e);
  if (!maha) return null;
  const antar = subPeriods(maha).find(x => x.s <= tMs && tMs < x.e);
  return antar ? { maha, antar } : null;
}

// ── 기존 DasaAtRange 스키마로 조립 (index.js 의 sandhi 플래튼 파서와 키 호환)
const iso = ms => new Date(ms).toISOString();
const durTxt = (s, e) => (((e - s) / 86400000) / 365.25).toFixed(2) + ' years';
function buildNested(tl, birthMs, winS, winE, levels) {
  const nested = {};
  for (const m of tl.mahas) {
    if (m.e <= winS || m.s >= winE || m.e <= birthMs) continue;
    const node = { Start: iso(Math.max(m.s, birthMs)), End: iso(m.e),
                   DurationText: VIM_YRS[m.lord] + ' years', Nature: VIM_NAT[m.lord] };
    if (levels >= 2) {
      const subs = {};
      for (const a of subPeriods(m)) {
        if (a.e <= winS || a.s >= winE || a.e <= birthMs) continue;
        const an = { Start: iso(Math.max(a.s, birthMs)), End: iso(a.e),
                     DurationText: durTxt(Math.max(a.s, birthMs), a.e), Nature: VIM_NAT[a.lord] };
        if (levels >= 3) {
          const ps = {};
          for (const p of subPeriods(a)) {
            if (p.e <= winS || p.s >= winE || p.e <= birthMs) continue;
            ps[p.lord] = { Start: iso(Math.max(p.s, birthMs)), End: iso(p.e),
                           DurationText: durTxt(Math.max(p.s, birthMs), p.e), Nature: VIM_NAT[p.lord] };
          }
          if (Object.keys(ps).length) an.SubDasas = ps;
        }
        subs[a.lord] = an;
      }
      if (Object.keys(subs).length) node.SubDasas = subs;
    }
    nested[m.lord] = node;
  }
  return nested;
}

async function handleDasaAtRange(origFetch, init) {
  const body = JSON.parse(init && init.body || '{}');
  if (!body.birthTime || !body.startTime || !body.endTime) throw new Error('DasaAtRange body incomplete');
  const bt = parseStdTime(body.birthTime.StdTime);
  const st = parseStdTime(body.startTime.StdTime);
  const en = parseStdTime(body.endTime.StdTime);
  const levels = Number(body.levels) || 2;
  if (en.ms <= bt.ms) throw new Error('requested window is entirely before birth');
  const moon = await fetchMoonLongitude(origFetch, body.birthTime.Location, bt);
  const tl = vimTimeline(moon.lon, bt.ms);
  const tRef = Math.max(st.ms, bt.ms); // 창이 출생 전에 시작하면 출생 시점 기준으로 현재 로드 산출
  const cur = locate(tl, tRef);
  if (!cur) throw new Error('target outside computed dasha range');
  const nested = buildNested(tl, bt.ms, st.ms, Math.max(en.ms, st.ms + 1), levels);
  return {
    Status: 'Pass',
    Payload: {
      DasaAtRange: nested,
      dasha_lord: cur.maha.lord,
      antardasha_lord: cur.antar.lord,
      mahadasha: { lord: cur.maha.lord, start: iso(Math.max(cur.maha.s, bt.ms)), end: iso(cur.maha.e) },
      antardasha: { lord: cur.antar.lord, start: iso(Math.max(cur.antar.s, bt.ms)), end: iso(cur.antar.e) },
      birth_moon: { longitude_sidereal: +moon.lon.toFixed(4), nakshatra: VIM_NAKS[tl.nak], pada: tl.pada,
                    nakshatra_lord: tl.lord0, balance_at_birth_years: +tl.balance.toFixed(3),
                    constellation_reported: moon.constel, crosscheck_ok: moon.xok },
      ayanamsa: 'LAHIRI', year_basis_days: 365.25, method: 'server_vimshottari_v1(overlay)'
    }
  };
}

// ── fetch 인터셉트 설치 (DasaAtRange 외 전 트래픽은 원본 그대로 통과)
const _origFetch = globalThis.fetch.bind(globalThis);
let _tz0Logged = false;
const VED_TZ0_RE = /\/Time\/(\d{2}):(\d{2})\/(\d{2})\/(\d{2})\/(\d{4})\/[+-]00:00\//;
function rewriteVedTz0(u) {
  const m = u.match(VED_TZ0_RE);
  if (!m) return u;
  const ms = Date.UTC(+m[5], +m[4] - 1, +m[3], +m[1], +m[2]) + 3600000;
  const d = new Date(ms); const p = n => String(n).padStart(2, '0');
  const seg = `/Time/${p(d.getUTCHours())}:${p(d.getUTCMinutes())}/${p(d.getUTCDate())}/${p(d.getUTCMonth()+1)}/${d.getUTCFullYear()}/+01:00/`;
  if (!_tz0Logged) { console.log('[dasha_overlay] VedAstro ±00:00 falsy 폴백 감지 경로 → 등가 +01:00 으로 재작성'); _tz0Logged = true; }
  return u.replace(VED_TZ0_RE, seg);
}
globalThis.fetch = async function (input, init = {}) {
  const u = typeof input === 'string' ? input : (input && input.url) || '';
  if (!u.includes('/Calculate/DasaAtRange')) {
    if (u.includes('api.vedastro.org')) { const ru = rewriteVedTz0(u); if (ru !== u) return _origFetch(ru, init); }
    return _origFetch(input, init);
  }
  try {
    const out = await handleDasaAtRange(_origFetch, init);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ Status: 'Fail',
      Payload: { overlay_error: String(e && e.message || e), overlay: 'dasha_overlay v1' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
};
console.log('[dasha_overlay] active — DasaAtRange intercepted → server-side Vimshottari (LAHIRI, 365.25d/yr)');
