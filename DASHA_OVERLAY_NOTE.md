# dasha_overlay — 다샤 3종 교정 (2026-07)

## 무엇이 문제였나 (1) — DasaAtRange
`get_current_dasha` / `get_dasha_timeline` / `get_dasha_sandhi` 는 VedAstro `DasaAtRange`(POST) 를 호출하는데,
이 경로만 시스템의 다른 호출들과 달리 `Ayanamsa/LAHIRI` 지정이 없고 출생 시각 처리도 어긋나,
Swati 달(라후 시작) 차트에 Mars/Rahu 마하다샤를 반환했다.

## 무엇이 문제였나 (2) — VedAstro +00:00 falsy 버그 (v1.2 발견)
VedAstro 는 0이 아닌 오프셋(+09:00, +01:00 등)은 정확히 반영하지만,
**+00:00 / -00:00 은 falsy 로 무시하고 좌표에서 유추한 현지시간으로 폴백**한다.
근거(4점 실측, 전부 스위스 천체력 예측과 소수 3~4자리 일치):
- +00:00, SF 좌표, 00:00 → 달 197.4358 = 실제 하늘의 06-02 07:00 UT (= 00:00 PDT)
- +00:00, SF 좌표, 22:00 → 196.1883 = 06-02 05:00 UT (= 22:00 PDT)
- +09:00 → 187.4978 = 06-01 15:00 UT (정확히 반영)
- +01:00 → 192.4544 = 06-01 23:00 UT (정확히 반영)
즉 기존 파이프라인의 natal 호출(+00:00, 제네시스 좌표)은 의도한 UTC 가 아니라
해당 장소의 현지시간으로 계산되어 왔다 (SF 기준 약 7시간 오차, 달 약 4.4°).

## 무엇을 바꿨나
- **index.js 는 한 바이트도 수정하지 않았다.** BTR·영상·시트 등 모든 기존 코드 경로 물리적 무변경.
- `dasha_overlay.js`: (1) `/Calculate/DasaAtRange` POST 를 가로채 서버 자체 비심다샤(LAHIRI 달 경도,
  365.25일/년)로 계산 — 기존 DasaAtRange 스키마 그대로 + `dasha_lord`/`antardasha_lord`/`birth_moon` 병기.
  (2) 달 fetch 는 항상 등가 +01:00 벽시계로 전송(falsy 함정 원천 회피).
  (3) 그 외 모든 VedAstro GET 의 ±00:00 구간을 등가 +01:00 순간으로 자동 재작성 —
  `get_planet_positions` 등 natal 파이프라인까지 의도한 UT 순간으로 교정된다.
- `server.js`: 오버레이 → index.js 순서로 로드하는 진입 래퍼.
- `package.json`: `start` 를 `node server.js` 로 변경 (v2.4.0).

## 교정된 XRP 다샤 (출생 2012-06-02 00:00 UTC 기준, 진짜 하늘)
달 193.0763° = Swati 2파다, 잔여 9.347년 → Rahu →2021-10-06, **Jupiter 2021-10-06→2037-10-06**,
현재 안타르 **Jupiter–Mercury (2026-06-07 시작, →2028-09-12)**.

## 실패 정책
내부 오류 시 `Status:'Fail' + overlay_error` 로 **소리 내며 실패**한다.
조용히 구버전(오답) 동작으로 폴백하지 않는다.

## 롤백
`package.json` 의 `start` 를 `node index.js` 로 되돌리면 오버레이 없이 원상복구.
