# dasha_overlay — 다샤 3종 교정 (2026-07)

## 무엇이 문제였나
`get_current_dasha` / `get_dasha_timeline` / `get_dasha_sandhi` 는 VedAstro `DasaAtRange`(POST) 를 호출하는데,
이 경로만 시스템의 다른 호출들과 달리 `Ayanamsa/LAHIRI` 지정이 없고 출생 시각 처리도 어긋나,
Swati 달(라후 시작) 차트에 Mars/Rahu 마하다샤를 반환했다. 신뢰 가능한 LAHIRI 달 경도로 직접 계산한
정답은 (XRP 두 후보 출생 모두) 현재 **Jupiter** 마하다샤.

## 무엇을 바꿨나
- **index.js 는 한 바이트도 수정하지 않았다.** BTR·영상·시트 등 모든 기존 코드 경로 물리적 무변경.
- `dasha_overlay.js`: `globalThis.fetch` 를 감싸 `/Calculate/DasaAtRange` POST 만 가로채고,
  출생 달의 LAHIRI 경도(`AllPlanetData/PlanetName/Moon` — `get_planet_positions` 와 동일 경로)로
  비심다샤(365.25일/년)를 서버에서 계산해 **기존 DasaAtRange 스키마 그대로** 반환.
  추가로 `dasha_lord` / `antardasha_lord` / `birth_moon` 를 Payload 최상위에 병기(G-01 Step 3-4 추출 필드).
- `server.js`: 오버레이 → index.js 순서로 로드하는 진입 래퍼.
- `package.json`: `start` 를 `node server.js` 로 변경 (v2.4.0).

## 실패 정책
내부 오류 시 `Status:'Fail' + overlay_error` 로 **소리 내며 실패**한다.
조용히 구버전(오답) 동작으로 폴백하지 않는다.

## 롤백
`package.json` 의 `start` 를 `node index.js` 로 되돌리면 오버레이 없이 원상복구.
