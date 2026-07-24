// ASTERION PhoneServer boot wrapper
// 폰(Termux)에는 GCP metadata 서버가 없다. index.js의 getGCPToken()이 호출하는
// http://metadata.google.internal/.../token 요청을 가로채, 서비스계정 키(JSON)로
// 직접 발급한 access_token을 동일한 형식으로 돌려준다.
// index.js는 한 줄도 수정하지 않는다. Cloud Run 배포에서는 이 파일이 실행되지 않으므로 영향 없음.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');

// --- .env 로드 (Node 버전 무관, 외부 패키지 불필요) ---
const envPath = path.join(ROOT, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const i = s.indexOf('=');
    if (i < 1) continue;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in process.env)) process.env[k] = v;
  }
  console.log('[boot] .env loaded');
}

// --- metadata shim ---
const META = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const SA_PATH = process.env.GOOGLE_SA_KEY_JSON || '';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/documents'
].join(' ');

const realFetch = globalThis.fetch.bind(globalThis);
let cache = { token: null, exp: 0 };
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function mint() {
  const now = Math.floor(Date.now() / 1000);
  if (cache.token && cache.exp - 120 > now) return cache;
  if (!SA_PATH || !fs.existsSync(SA_PATH)) throw new Error('서비스계정 키 없음: ' + (SA_PATH || 'GOOGLE_SA_KEY_JSON 미설정'));
  const sa = JSON.parse(fs.readFileSync(SA_PATH, 'utf8'));
  const head = b64u({ alg: 'RS256', typ: 'JWT' });
  const claim = b64u({ iss: sa.client_email, scope: SCOPES, aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now });
  const sig = crypto.createSign('RSA-SHA256').update(head + '.' + claim).sign(sa.private_key).toString('base64url');
  const r = await realFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: head + '.' + claim + '.' + sig })
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('SA 토큰 발급 실패: ' + JSON.stringify(j).slice(0, 200));
  cache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  console.log('[boot] SA token minted (' + sa.client_email + ')');
  return cache;
}

globalThis.fetch = async (url, opts) => {
  const u = typeof url === 'string' ? url : (url && url.url) || '';
  if (u.startsWith(META)) {
    const now = Math.floor(Date.now() / 1000);
    const c = await mint();
    return new Response(JSON.stringify({ access_token: c.token, expires_in: Math.max(60, c.exp - now), token_type: 'Bearer' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
  return realFetch(url, opts);
};

console.log('[boot] metadata shim active | SA:', SA_PATH || 'MISSING', '| PORT:', process.env.PORT || 8080);
await import('../index.js');
