# ASTERION 시스템 로드맵 & 유지관리 가이드

> **최종 업데이트**: 2026-07-25
> **현재 버전**: MCP v5.22 · Hub v3.6

---

## 🔱 시스템 현황

### 서비스 URL
| 서비스 | URL |
|--------|-----|
| MCP 서버 | https://mcp.asterion-origin.uk/mcp — **폰 서버 (현재)** |
| MCP 서버 (GCP · 롤백용) | https://mcp-server-611151539232.asia-northeast3.run.app |
| Hub Chat | https://ai-chat-hub-611151539232.asia-northeast3.run.app |
| Agent Registry ID | agentregistry-00000000-0000-0000-d9ab-851925d12ac3 |

### GitHub 레포지토리
| 레포 | 용도 |
|------|------|
| victuar918/MCP_Server | MCP 서버 (Cloud Run 자동배포) |
| victuar918/AI_Chat_Hub | Hub Chat 프론트+백엔드 |
| victuar918/RegistrationForm | HTML 등록폼 (정적 파일, GitHub Pages) |
| victuar918/ASTERION | Android 영상 파이프라인 |

### GCP 인프라
- **프로젝트 ID**: `asterion-server`
- **리전**: `asia-northeast3` (서울)
- **배포**: GitHub main push → Cloud Trigger → Cloud Build → Cloud Run
- **Archive SS ID**: `1ym1cgr1apEyTlqtJXqrfdnLjoyJTh086CjGycMcUOS8`
- **StructureRegistration SS ID**: `1JFR7O9wxzvK4aqw_O2s6ZUSkX8_hw03rAc02l4Km90k`
- **JuliarCalendar SS ID**: `1whKvFyWmb-qbR6OJt5dcI6WOJMLB5MUIzNMlJBFeq_g`
- **Cloud Run SA**: `611151539232-compute@developer.gserviceaccount.com` (Archive SS 편집자 권한 보유)

### GAS 프로젝트
| 이름 | Script ID | 용도 |
|------|-----------|------|
| AsterionArchiveSystem | `1tuxbpJoVug40yYHXg-ZjOvWdwSbtiuiNhK9931DkvrHw3vqaMJ0YOiDH` | Archive 백오피스 GAS |
| ASTERION SignReg GAS | `1B4nDjIXQVsh2XN0AS48_tSAxSqJZmMIwTjr7z1ifosTw0wsoXVMZ0TN2` | 구글폼 연동 GAS |
| AsterionHtmlReg | `1Bs43_qnj31xBizc6a7_LhyKPbI3n_O36GD-RHmuvdFawB34tpJwRZQ1D` | HTML 등록폼 전용 GAS |

---

## ✅ 완료된 구축 항목

### MCP 서버 (v5.18 기준)
- [x] L0~L6 계층 구조 도구 (VedAstro, BTR, GCloud, SystemOps, Workspace, AI, Report) — 현재 배포 v5.22 · 92개 도구
- [x] `gh_push_files`: 여러 파일 한 번의 커밋으로 push (Git Tree API)
- [x] `github_patch_file`: 파일 부분 업데이트 (find/replace 배열)
- [x] `sheets_update_row`: 키 컬럼으로 행 찾아 지정 컬럼만 수정
- [x] `delete_sheet_row`: Sheets batchUpdate deleteDimension — row_index 또는 key_column+key_value
- [x] `insert_sheet_row`: Sheets batchUpdate insertDimension — row_index 위치에 행 삽입, values 선택입력
- [x] Agent Registry TOOL_SPEC 등록
- [x] BTR 파이프라인 도구: create_btr_session → save_runtime_snapshot → validate_sclass_gate (※ 루프 드라이버는 코드에 없음 — 아래 [확정] 섹션 참조)
- [x] 앤커링 방지 가이드라인: `critical_issues` → 검증 의제 프레이밍 (buildAntiAnchoredContext)
- [x] `init_btr_sheets`: BTRRuntime·BTRNotifications 시트 생성 + 헤더 + OAuth 진단
- [x] VedAstro API: 행성별 AllPlanetData GET 루프 (POST 버그 확인된 우회)
- [x] update_script_file, deploy_script_webapp (OAuth 스코프 제한 있음)

### Hub Chat (v3.6)
- [x] **Claude / NEMO(Nemotron) / DeepSeek-v4-pro** 3모델 (Native MCP 연결) — 2026-07 전환 완료
- [x] 에이전트 지속성: MAX_TOOL_DEPTH 8→15 + 시스템 프롬프트 [작업 지속성] 지시문 (buildStringSystem·buildClaudeSystem 양쪽)
- [x] Cloud Run 설정: --timeout 900 + --memory 2Gi (도구 92개+thinking 응답 파싱 시 512MB OOM → HTTP 503 해결)
- [x] (구) Claude / Gemini 멀티모델 (Native MCP 연결)
- [x] Supertonic 3 TTS v4.2.15 (ONNX, 문장 단위 청크 파이프라인)
- [x] BTR 알림 시스템: SSE 5초 폴링 → 알림 카드 → 응답 → Gemini 전달

### HTML Registration Form
- [x] **AsterionHtmlReg GAS 배포 완료**
  - Script ID: `1Bs43_qnj31xBizc6a7_LhyKPbI3n_O36GD-RHmuvdFawB34tpJwRZQ1D`
  - Web App URL: `https://script.google.com/macros/s/AKfycby_uXWtm4lgpxJTgvQr6En5MiGaBOkVtLZAniqxF5vE0sMR8sSUavex-hQK-KzGicWn/exec`
  - 완전 독립 실행형 — 기존 SignReg GAS 미사용
- [x] **API 4개 함수 검증 완료** (2026-06-24)
  - `createPrivateRow` → PvReg 임시 행 생성
  - `saveDraftData` → 단계별 중간 저장
  - `saveRegistration` → L-코드 발급 + Archive 행 추가
  - `checkOrderStatus` → COMPLETED/IN_PROGRESS/PENDING 상태 판단
- [x] **saveAddInfo 검증 완료**: 완료 고객(StructureCode) 추가정보를 Archive AddInfo(AH열)에 `[시각][종류] 내용` 누적 append
- [x] **보안 구조 확인**: HTML폼 → GAS → PvReg → Archive (직접 접근 불가)
- [x] `reg_config.js` GAS_URL 업데이트 완료 (…CNB6 → …KzGicWn, commit 345fe391)
- [x] PvReg 시트 헤더 25컬럼 정확히 설정된 상태 (코드 _PVREG_COL 매핑과 일치)

---

## 🎯 [확정 · 2026-07-02] HTML 등록폼 ↔ BTR 실시간 통합 설계

> 이번 채팅 세션에서 확정. **기존 구글폼(운영자가 등록 이후 수동으로 BTR) → HTML폼(등록과 동시에 실제 3자 BTR 진행)** 으로 전환하는 것이 HTML폼의 존재 이유. "경량 접수 루브릭" 개념은 폐기 — 실제 3자 루브릭이 돈다. (관련 명세: `Html폼_구현_명세서`, `ASTERION_3자루브릭_v3_0.md`)

### 접수 흐름 (Signature/Private 공통)
1. **STEP 4(현재상태) 완료 직후** 실제 3자 BTR을 **비동기**로 착수. BTR 입력 = {생년월일·생시·출생지·사건목록}. 현재상태(삶의 방향)는 채점 항목이 아니라 분석 컨텍스트로 함께 투입.
2. BTR은 수 분~10분(Heartbeat 임계 10분) 소요 → **단일 블로킹 HTTP 호출 불가**. 진행상태를 BTRRuntime 시트에 기록하고 프런트가 폴링.
3. 꼬리 단계(현재상태 → 시계/손목 → 수령 → 동의 1개씩 → 필요 시 안내영상/추가화면)로 연산 시간 확보. 목표 = 인세션 S-Class 도달. 미완 시 standby 영상("정보가 충분한지 검토 중"), 길거나 Held면 "접수완료 + 결과 연락".
4. 추가질문은 꼬리 단계 사이에 동적 삽입 → **동적 스텝 큐** 필요 (현재 고정 STEP 1~8 switch 교체).
5. **InProgress_BTR 임시 Archive 행 없음.** Archive 행은 BTR 종료(Confirmed/Held) 시에만 생성. StructureCode 채번도 Confirmed 시점(서버측). `saveRegistration`을 [제출: 폼데이터 마감] / [Confirmed: 서버측 채번+Archive 생성]으로 분리.
6. 완료 화면에서 코드 노출 제거(`renderComplete`). 코드는 북클릿/연락으로 전달.

### 3자 루브릭 라운드/리셋 개정 (v3.0 → 갱신)
- **carry-forward 유지**: `buildAntiAnchoredContext`가 이전 라운드 요약+critical_issues+suggestions를 "미검증 의제"로 다음 라운드에 주입(앤커링 방지 래퍼 유지). 구버전 Isolated Execution(매 라운드 초기화)은 v3.0 §17에서 이미 폐기됨.
- **최대 5→3라운드**: 종료 조건 = "수렴 OR 정체(직전 라운드 대비 점수 개선 없음·이견 안 줄어듦), 상한 3". 진전 없는 반복 방지.
- **초기화(full_reset)는 새 변곡점(사건) 추가 시에만**: 기존 사건 상세화(추가질문 응답)는 carry-forward, 새 사건 추가면 Round 1 재시작. (v3.0의 "답변 시 무조건 재시작"보다 정밀 — 판단 기준은 "사건 세트가 바뀌었나")

### ⚠️ 발견된 코드 이슈 (미수정 — 통합 착수 시 처리)
- **[MCP index.js] `call_gpt`가 `previous_round_context` 미지원**: 스키마에 파라미터 없음 + 실행부에서 antiAnchoredCtx 미적용. Claude·Gemini만 carry-forward, GPT는 매 라운드 독립 분석. "모든 AI 동등" 원칙 위반 → 한 곳 수정.
- **[MCP index.js] 이견 임계 불일치**: `btr_conflict_axis_finder`는 `>15`, v3.0 §8은 `≥5`. 라운드 개정 시 함께 확정.
- **[3자 루브릭 모델 구성 변경 · 2026-07]** 슬롯명(`call_gemini`/`call_claude`/`call_gpt`)은 그대로 두고 **실제 모델만 교체**됨:
  - `call_gemini` → **Nemotron** (`nvidia/nemotron-3-ultra-550b-a55b`, NVIDIA NIM · thinking ON)
  - `call_claude` → **claude-sonnet-4-6** (Anthropic)
  - `call_gpt` → **deepseek-v4-pro** (DeepSeek 자체 API · `thinking:{type:'enabled'}` + `reasoning_effort:'high'` + `stream:false`)
  - ⚠️ 문서 곳곳의 "Gemini"·"GPT" 표기는 **슬롯 기준**이지 실제 모델이 아니다. Google Gemini·OpenAI GPT는 더 이상 사용하지 않음
  - ✅ 폰 서버 3자 실호출 검증 완료 (2026-07-25): `call_gemini`/`call_claude`/`call_gpt` 전부 정상 응답
  - ☐ `ASTERION_3자루브릭_v3_0.md`의 모델명 표기도 동일하게 갱신 필요
- **[Hub index.js] 등록폼용 라우트 부재**: `/api/reg/rubric` · `/api/naver/verify-order` · `/api/reg/addinfo` 미구현. Signature/Evolution 진입·루브릭 경로 막힘.
- **[RegistrationForm reg_rubric.js] Private 게이지 = 로컬 시뮬레이션(`_localScore`)**: 실제 BTR 미호출(Grade-S는 연출값). BTR 통합으로 대체 예정.

### HTML폼 UI 개선 (Private 실사용 피드백)
- 생년월일: 네이티브 `<input type=date>` → 연도 선택 난해 → 커스텀 연/월/일 드롭다운(저장 YYYY-MM-DD 유지).
- 출생시각: 네이티브 `<input type=time>` → 오전/오후 색상 피드백 불가 → 커스텀 오전/오후 토글+시/분(저장 HH:MM 유지).
- 키보드: `_initKeyboardHandler`의 position:fixed 재배치가 안드로이드에서 버튼을 상단으로 튕김 → 재배치 제거 + 뷰포트 메타 `interactive-widget=resizes-content`, 버튼 흐름 유지.
- 게이지: 용어 "Grade"→"S-Class". 금빛 애니메이션은 현재 1px 헤어라인 → 두께 있는 형태로 리디자인 필요. 단 BTR 통합 시 게이지는 실제 상태 반영으로 성격 변경.

### 핵심 사실
라운드/리셋 로직은 코드에 하드코딩되어 있지 않음 — index.js에 5라운드 루프 드라이버 부재(툴만 존재, 루프는 오케스트레이터-프롬프트가 구동). BTR 3자 파이프라인 실전 1회 미실행. → 5→3·리셋 규칙 변경은 코드 리팩터가 아니라 **오케스트레이터 스펙/프롬프트 + `ASTERION_3자루브릭_v3_0.md` 갱신** 사안. 이 개정으로 인한 실제 코드 변경은 GPT 컨텍스트 누락 한 곳뿐.

---

## 🚧 진행 중 / 다음 작업

### HTML Registration Form — BTR 실시간 통합 (신규 · ↑ [확정] 섹션 참조)
- [ ] Hub `/api/reg/rubric` 구현 — 3자 루브릭 착수 트리거 + BTRRuntime 상태 기록 (비동기)
- [ ] MCP `call_gpt`에 `previous_round_context` 추가 (3자 carry-forward 대칭 완성)
- [ ] 오케스트레이터 스펙/프롬프트: 라운드 상한 3 + "수렴 OR 정체" 종료 + "새 사건 추가 시에만 full_reset"
- [ ] 프런트 동적 스텝 큐 전환 (고정 STEP 1~8 switch → 큐, 추가질문 동적 삽입 + BTRRuntime 폴링)
- [ ] `saveRegistration` 분리 (제출=폼마감 / Confirmed=서버측 채번+Archive) + `renderComplete` 코드노출 제거
- [ ] STEP 2 커스텀 입력 (연/월/일 드롭다운 + 오전/오후 토글) · 키보드 재배치 제거
- [ ] `ASTERION_3자루브릭_v3_0.md` 갱신 (5→3 · 정체 종료 · 새 사건 리셋)

### HTML Registration Form — 잔여 작업
- [ ] **GitHub Pages 활성화** (1회만 하면 완료)
  - `github.com/victuar918/RegistrationForm` → Settings → Pages → Branch: main / (root) → Save
  - 확인 URL: `https://victuar918.github.io/RegistrationForm/private_reg.html`
- [ ] **테스트 데이터 정리** (GitHub Pages 활성화 전에 실행)
  - StructureRegistration > PvReg 시트: 2행 (테스트 행) 삭제
  - ASTERION Code Archive > Archive 시트: L-00001-260615 행 삭제
  - 도구 사용: `delete_sheet_row`
- [ ] **AsterionHtmlReg GAS 코드 정리**: `cleanupTestData` 함수 제거 후 프로덕션 버전으로 재배포
- [ ] **HTML 폼 UI End-to-End 테스트**: 실제 브라우저에서 `private_reg.html` 접속후 전체 스텝 진행
- [ ] **이어하기 테스트**: 중간에 닫았다 재접속시 IN_PROGRESS 반환 확인

### MCP 서버 — 잔여 작업
- [ ] (Hub는 Gemini 미사용 — Agent Registry 등록 시에만 해당) **Gemini 400 오류**: `sheets_write`, `append_sheet_row` 파라미터의 `array` 타입에 `items` 필드 누락
- [ ] **Agent Registry 재등록**: 현재 배포(v5.22 · 92개 도구) 기준 재등록 필요

### Archive GAS Web App — 미완성 페이지
- [ ] `booklet.html` — 고객 북클릿 생성/조회
- [ ] `forwarding.html` — 발송 관리
- 완성된 페이지: index, worksdesk, selectstone, inventory, invenmanage, stoneinfo, newlisting, design, analysismemo, productimage, structureindex

### 중장기
- [ ] Signature Registration HTML폼 구현 (Private Registration 완료 후 · 위 [확정] BTR 통합 흐름 적용)
- [ ] Evolution Registration HTML폼 구현
- [ ] BTR 3자 루브릭 실전 파이프라인 1회 완전 실행
- [ ] Archive GAS 컬럼 추가: BTRIteration, HeartbeatTime, HeartbeatStep, SearchRangeType, SearchRangeNote, GptScores, WaitInfo_DateRange, WaitInfo_TimeRange, DEGRADED
- [ ] Supertonic TTS Lexicon Skip 문제 검증

---

## 📚 폰 서버 전환 (PhoneServer) — 2026-07-25

> MCP 서버 실행 위치를 **GCP Cloud Run → 갤럭시 S22 Ultra 상주 서버**로 이전. **콜드스타트 제거 + GCP 비용 0**. GCP 경로(Cloud Run·트리거·cloudbuild.yaml)는 **롤백용으로 그대로 보존**.

### 구조
```
claude.ai 커넥터 / Hub
   ↓  https://mcp.asterion-origin.uk/mcp
Cloudflare Tunnel (icn01 서울 edge, http2)
   ↓
공폰 Termux — pm2 3프로세스
  mcp-server   phone/boot.js → index.js (PORT 8080)
  cloudflared  터널
  watcher      60초 GitHub 폴링 → git pull + pm2 restart
```

### phone/ 파일
| 파일 | 역할 |
|------|------|
| `boot.js` | **metadata shim** — 폰엔 GCP metadata 서버가 없어 `getGCPToken()` 실패(영상 시트·GCP 도구 전멸) → 서비스계정 키로 JWT 발급해 동일 형식 반환. `.env` 로더 겸용. **index.js 무수정** = GCP 영향 0 |
| `ecosystem.config.cjs` | pm2 3프로세스 정의 |
| `watcher.sh` | 자동배포 루프 — Claude가 GitHub 패치 → **60초 내 폰 반영** (Cloud Build 대체) |
| `setup.sh` | Termux 원라인 설치 (멱등, 재실행 안전) |
| `env.mcp.template` | `.env` 템플릿 |

### 설치 순서
1. **F-Droid**에서 Termux + Termux:Boot 설치 (플레이스토어판 금지) → Termux:Boot 1회 실행(UI 없음, 설명문만 뜨면 정상) → 배터리 **제한 없음** + 배터리 보호 85%
2. `curl -sL https://raw.githubusercontent.com/victuar918/MCP_Server/main/phone/setup.sh | bash`
3. 키 3개: `~/srv/MCP_Server/.env` / `~/srv/sa-key.json` (GCP **서비스계정** 키 JSON — OAuth `client_secret.json` 아님) / `~/.cloudflared_token`
4. `pm2 start ~/srv/MCP_Server/phone/ecosystem.config.cjs && pm2 save`
5. Cloudflare 대시보드 → **Networking > Tunnels** → 터널 → **경로(Routes)** 탭 → 경로 추가 → **게시된 애플리케이션** (`mcp` / `asterion-origin.uk` / `http://localhost:8080`)
   - ⚠️ 커넥터가 붙은 뒤에야 경로 화면이 열림 → **폰 기동을 먼저**

### 검증
```
pm2 status                                    # 3개 online
tail -n 20 ~/.pm2/logs/cloudflared-out.log    # Registered tunnel connection ... icn01
curl -s https://mcp.asterion-origin.uk/ | head -c 200
```
- claude.ai 커넥터 URL: `https://mcp.asterion-origin.uk/mcp` (인증란 **비움**)
- `get_system_status` → `gcp_adc: ADC 정상`이면 boot.js shim 정상 동작

### 롤백 (GCP 복귀)
커넥터/Hub의 MCP URL을 `https://mcp-server-611151539232.asia-northeast3.run.app` 으로 되돌리면 **즉시 복귀**.

---

## 📚 [CRITICAL] Agent Registry 재등록 방법

**배경**: GCP Console UI에 버그가 있어 UI로는 등록 불가. REST API 직접 호출만 가능.

```
Hub Chat → Gemini 모델 선택 →
(Hub 모델 버튼: 구 "Gemini" → 현재 "NEMO")
"agent_registry_register 도구를 실행해서 MCP 서버를 재등록해줘"
```

또는 Claude.ai에서:
```
ASTERION MCP:agent_registry_register 호출
```
→ 기존 서비스 자동 삭제 후 현재 ALL_TOOLS 기준 전체 재등록

---

## 🤖 MCP 도구 계층 (v5.22, 92개)

| 계층 | 분류 |
|------|------|
| L0 | VedAstro (베딕 점성술 연산) |
| L1 | BTR (생시 보정 파이프라인 + 알림) + 영상 자동화 |
| L2 | GCloud (Cloud Run, Agent Registry) |
| L3 | SystemOps (GitHub, Sheets CRUD, HTTP) |
| L4 | Workspace (Drive, Docs, GAS) |
| L5 | AI — call_gemini=**Nemotron**(NVIDIA), call_claude=**claude-sonnet-4-6**, call_gpt=**deepseek-v4-pro** |
| L6 | Report/Ops (BTR 보고서, 감사로그) |

### 환경변수 (Cloud Run)
```
ANTHROPIC_API_KEY    NVIDIA_API_KEY    DEEPSEEK_API_KEY
GITHUB_PAT           GITHUB_OWNER=victuar918
GCP_PROJECT=asterion-server   GCP_REGION=asia-northeast3
GOOGLE_CLIENT_ID     GOOGLE_CLIENT_SECRET    GOOGLE_REFRESH_TOKEN
MCP_SECRET_KEY
```

---

## ⚠️ 알아두면 유용한 함정들

### [폰 서버] Cloudflare 터널 7844 차단 — edge IP 고정으로 우회
상위망이 **`198.41.192.x` 대역의 7844 포트를 차단**. cloudflared는 7844가 필수라 기본 설정으로는 절대 연결되지 않음 (`i/o timeout` 무한 반복).
- **진단**: `timeout 8 bash -c 'cat < /dev/null > /dev/tcp/<IP>/7844'` → `198.41.200.x` **전부 열림**, `192.x`·IPv6(`2606:4700::`) 막힘, `portquiz.net:7844` 열림 → **포트가 아니라 목적지 기반 차단**
- **해결**: `--protocol http2`(QUIC/UDP 회피) + `--edge-ip-version 4`(IPv6 회피) + `--edge 198.41.200.x:7844` 고정 + **`--ha-connections` = edge IP 개수**
- ⚠️ IP 개수 < 연결 개수면 `already connected to this server` / `no free edge addresses left`로 실패. **IP 3개 → ha-connections 3**
- ⚠️ `--region us`는 역효과(막힌 `192.x`·IPv6로 붙음). 사용 금지
- 성공 로그: `Registered tunnel connection ... location=icn01 protocol=http2`
- ⚠️ 포트포워딩·DMZ·DDNS·IP/Port 필터링은 **전부 인바운드 기능이라 무관**. 공유기 메뉴 삽질 금지

### [폰 서버] .env의 보이지 않는 문자 (U+200B)
모바일에서 콘솔의 API 키를 복사하면 **제로폭 공백(U+200B)** 이 섞여 들어옴. 화면상 식별 불가.
- **증상**: AI 호출이 **0.05초 만에 즉시 실패** — `Cannot convert argument to a ByteString because the character at index N has a value of 8203`. 타임아웃처럼 보이지만 정반대(즉시 실패)
- **해결**: `node -e 'const fs=require("fs");const p=process.env.HOME+"/srv/MCP_Server/.env";let s=fs.readFileSync(p,"utf8");s=s.split("\n").map(l=>l.replace(/[^\x20-\x7E]/g,"").replace(/\s+$/,"")).join("\n");fs.writeFileSync(p,s);'` → `pm2 restart mcp-server --update-env`
- 키를 새로 넣거나 수정할 때마다 재발 가능 → **AI 호출이 즉시 실패하면 먼저 이것부터 의심**

### [폰 서버] pm2 설정 파일은 반드시 `.cjs`
`package.json`에 `"type":"module"`이 있어 `ecosystem.config.js`는 ESM으로 해석됨 → `ReferenceError: module is not defined in ES module scope`. **`.cjs` 확장자 필수**

### [폰 서버] git core.fileMode — 자동배포 정지 원인
`chmod +x`가 tracked 파일의 모드 비트를 바꿔 git이 로컬 수정으로 인식 → watcher의 `git pull`이 **영구 실패**(자동배포 정지)
- 예방: `git config core.fileMode false` (setup.sh에 포함)
- 복구: `git checkout -- <파일>` 후 `git pull`

### [폰 서버] Termux 초기 curl 깨짐
미러 미선택 상태로 pkg 설치 시 openssl 라이브러리 불일치 → `CANNOT LINK EXECUTABLE "curl" ... SSL_set_quic_tls_transport_params`
- 해결: `termux-change-repo`(Mirror group 선택) → **`apt update && apt full-upgrade -y`**
- ⚠️ `pkg`는 내부적으로 curl을 쓰므로 이 상태에선 실패 → 반드시 `apt` 사용

### [폰 서버] MCP_SECRET_KEY는 claude.ai 커넥터에서 사용 불가
서버 인증은 `Authorization: Bearer <키>` / `x-mcp-token` **헤더** 방식인데, claude.ai 커넥터 설정에는 **OAuth 클라이언트 ID/시크릿 칸만** 있고 커스텀 헤더 입력란이 없음
- `MCP_SECRET_KEY`를 채우면 **모든 커넥터가 401로 즉시 끊김** → **비워둘 것**
- 보안이 필요하면 추측 불가능한 서브도메인(예: `mcp-a7f3k9x2.asterion-origin.uk`) 또는 Cloudflare WAF로 대체
- 폰 전용 추가 환경변수: `GOOGLE_SA_KEY_JSON=/data/data/com.termux/files/home/srv/sa-key.json`

### [교훈] MCP 안정화 패치 → 전면 롤백 (2026-07)
Cloud Run 시절 도구 호출 간헐 실패에 다음을 적용했다가 **끊김이 오히려 악화**되어 전면 롤백:
- 적용했던 것: SSE keepalive 25초 핑 / `process.on('unhandledRejection'|'uncaughtException')` 가드 / `/message` 죽은 세션 가드 / `--timeout 3600` / `--max-instances 1`
- **원인**: 크래시 가드 + max-instances 1 조합이 **죽으면 새 인스턴스로 자가치유되던 경로를 제거** → 병든 인스턴스 1개가 계속 서빙. `--timeout 3600`은 죽은 SSE를 오래 붙잡아 감지를 늦춤
- **교훈 1**: 잘 되던 시스템이 변경 직후 나빠지면 **새 대책을 더하지 말고 그 변경을 되돌린다**
- **교훈 2**: 롤백은 트래픽만 옮기지 말고 **git까지** 되돌려야 다음 배포에서 재발하지 않음
- **교훈 3**: `gcloud run deploy`는 플래그를 생략하면 **기존 설정이 유지**됨 → 되돌릴 땐 기본값을 **명시** (`--timeout 300`, `--max-instances default`)
- 근본 해결은 폰 서버 이전(상주 프로세스 = 콜드스타트·인스턴스 미스 원천 소멸)으로 대체

### NVIDIA는 자체 모델만 견고 — 외부 호스팅 모델 주의
`integrate.api.nvidia.com`의 **Nemotron(자체 모델)**은 도구 92개 + 풀 페르소나 요청도 안정적. 반면 외부 모델 `z-ai/glm-5.2`는 무거운 요청에서 **502 Bad Gateway / Upstream request failed** 반복(게이트웨이가 모델 서버 응답 못 받음) → Hub 설정으로 해결 불가, **DeepSeek 자체 API 교체가 정답**
- NVIDIA NIM 문서상 `stream` 기본값이 `true`인 모델 존재 → `response.json()` 파싱 구조면 **`stream:false` 명시** 필요

### HTTP 503 계층 진단법 (Cloud Run + SSE)
Hub `/api/chat`은 에러를 SSE(HTTP 200)로 흘리므로 **진짜 HTTP 503 = 컨테이너가 응답을 시작조차 못함**(hang/크래시/타임아웃). SSE가 한 번이라도 쓰였으면 이후 실패는 스트림 절단이지 503 아님
- fetch 타임아웃이 안 터지는데 503 → **Cloud Run 요청 타임아웃이 더 짧음**
- 메모리 상향 후 opaque 503이 graceful 에러로 바뀜 → **OOM이 원인이었음 확정**

### VedAstro AllPlanetData(All) POST is broken
POST /Calculate/AllPlanetData with PlanetName "All" returns the FIRST planet (Sun) data duplicated across all 9 planets. v5.13에서 행성별 GET 루프로 전환. POST 절대 되돌리기 금지.

### GitHub 접근 규칙
- MCP GitHub 도구는 API 사용 + `GITHUB_OWNER=victuar918`가 기본 → **repo 이름만** 전달 (예: `MCP_Server`, `RegistrationForm`).
- 한글 포함 파일 수정 = `gh_push_files`(전체 교체) 우선. `github_patch_file`은 find 문자열이 ASCII 전용이고 유일할 때만.
- 레포 검증은 `raw.githubusercontent.com` 캐시 가능 → `github_read_file`(API)로 확인.

### 3자 루브릭 carry-forward 비대칭 (미수정)
`call_claude`·`call_gemini`만 `previous_round_context`를 받아 앤커링 방지 컨텍스트를 붙임. `call_gpt`는 미지원 → GPT만 매 라운드 독립. 통합 착수 시 대칭화 필요.

### GitHub Pages (RegistrationForm)
- 저장소 설정에서 수동 활성화 필요 (API로 활성화 불가 — 401)
- `deploy_script_webapp`도 403 (OAuth scope `script.deployments` 미포함)
- GAS 업데이트: `update_script_file` ✓ / 배포: 수동 1회 (배포 관리 → 새 버전 선택 → 배포)

### [구 Gemini 연동 잔재 · 스키마 참고용] Gemini array 파라미터
```javascript
// ❌ Gemini 400 오류
values: {type:'array'}
// ✅ items 필드 필수
values: {type:'array', items:{type:'array', items:{type:'string'}}}
```

### MCP 도구 추가 시 체크리스트
1. `ALL_TOOLS` 배열에 추가
2. 해당 계층 Set (L0~L6)에도 추가
3. `agent_registry_register` 재호출

### AsterionHtmlReg GAS 유의사항
- 단일 `Code.gs` 파일에 모든 코드 (SIGNREG_CONFIG, _PVREG_COL, 함수 + doPost)
- `update_script_file` 후 배포는 수동 1회 (deploy_script_webapp scope 부족)
- 라이브 검증: `http_request`로 `/exec`에 POST (body=JSON, Content-Type text/plain;charset=utf-8). 가짜 코드로 saveAddInfo 호출 시 NOT_FOUND=정상.

### Cloud Run 배포
- GitHub push → 배포 완료까지 약 2~3분 (문서/README 단독 push도 트리거됨 — 코드 동일이면 무해)
- 배포 후 `get_system_status`로 버전 확인
- `github_write_file` 후 반드시 버전 확인 후 다음 작업 진행

### BTR 알림 흐름
```
# 주의: 아래 "Gemini 채팅 전달"은 현재 Hub의 "NEMO"(Nemotron) 탭을 뜻함
MCP btr_write_notification → BTRNotifications 시트 (GCP ADC)
    → Hub SSE 5초 폴링 → 배지 점등
    → 관리자 응답 → Gemini 채팅 전달
    → updateNotifStatus('responded') → 카드 제거
```

---

*이 파일은 Claude가 작성하고 지훈님이 검토합니다.*
