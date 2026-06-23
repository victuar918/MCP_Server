# ASTERION 시스템 로드맵 & 유지관리 가이드

> **최종 업데이트**: 2026-06-24
> **현재 버전**: MCP v5.18 · Hub v3.6

---

## 🔱 시스템 현황

### 서비스 URL
| 서비스 | URL |
|--------|-----|
| MCP 서버 | https://mcp-server-611151539232.asia-northeast3.run.app |
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

### MCP 서버 (v5.18)
- [x] L0~L6 계층 구조 89개 도구 (VedAstro, BTR, GCloud, SystemOps, Workspace, AI, Report)
- [x] `gh_push_files`: 여러 파일 한 번의 코미으로 push (Git Tree API)
- [x] `github_patch_file`: 파일 부분 업데이트 (find/replace 배열)
- [x] `sheets_update_row`: 키 콼럼으로 행 찾아 지정 콼럼만 수정
- [x] `delete_sheet_row`: Sheets batchUpdate deleteDimension — row_index 또는 key_column+key_value
- [x] `insert_sheet_row`: Sheets batchUpdate insertDimension — row_index 위치에 행 삽입, values 선택입력
- [x] Agent Registry TOOL_SPEC 등록
- [x] BTR 파이프라인: create_btr_session → save_runtime_snapshot → validate_sclass_gate
- [x] 앤커링 방지 가이드라인: `critical_issues` → 검증 의제 프레이밍 (buildAntiAnchoredContext)
- [x] `init_btr_sheets`: BTRRuntime·BTRNotifications 시트 생성 + 헤더 + OAuth 진단
- [x] VedAstro API: 행성별 AllPlanetData GET 루프 (POST 버그 확인된 우회유)
- [x] update_script_file, deploy_script_webapp (OAuth 스코프 제한 있음)

### Hub Chat (v3.6)
- [x] Claude / Gemini 멀티모델 (Native MCP 연결)
- [x] Supertonic 3 TTS v4.2.15 (ONNX, 문장 단위 청크 파이프라인)
- [x] BTR 알림 시스템: SSE 5초 폴링 → 알림 카드 → 응답 → Gemini 전달

### HTML Registration Form
- [x] **AsterionHtmlReg GAS 배포 완료**
  - Script ID: `1Bs43_qnj31xBizc6a7_LhyKPbI3n_O36GD-RHmuvdFawB34tpJwRZQ1D`
  - Web App URL: `https://script.google.com/macros/s/AKfycby_uXWtm4lgpxJTgvQr6En5MiGaBOkVtLZAniqxF5vE0sMR8sSUavex-hQK-KzGicWn/exec`
  - 완전 독립 실행형 — 기존 SignReg GAS 자리보전없음
- [x] **API 4개 함수 검증 완료** (2026-06-24)
  - `createPrivateRow` → PvReg 임시 행 생성
  - `saveDraftData` → 단계별 중간 저장
  - `saveRegistration` → L-코드 발급 + Archive 행 추가
  - `checkOrderStatus` → COMPLETED/IN_PROGRESS/PENDING 상태 농
- [x] **보안 구조 확인**: HTML폼 → GAS → PvReg → Archive (직접 접근 불가)
- [x] `reg_config.js` GAS_URL 업데이트 완료
- [x] PvReg 시트 헤더 25콼럼 정확히 설정된 상태 (코드 _PVREG_COL 매핑과 일치)

---

## 🚧 진행 중 / 다음 작업

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
- [ ] **Gemini 400 오류**: `sheets_write`, `append_sheet_row` 파라미터의 `array` 타입에 `items` 필드 누락
- [ ] **Agent Registry 재등록**: v5.18 기준 89개 도구 재등록 필요

### Archive GAS Web App — 미완성 페이지
- [ ] `booklet.html` — 고객 북클릿 생성/조회
- [ ] `forwarding.html` — 발송 관리
- 완성된 페이지: index, worksdesk, selectstone, inventory, invenmanage, stoneinfo, newlisting, design, analysismemo, productimage, structureindex

### 중장기
- [ ] Signature Registration HTML폼 구현 (Private Registration 완료 후)
- [ ] Evolution Registration HTML폼 구현
- [ ] BTR 3자 루브릭 실전 파이프라인 1회 완전 실행
- [ ] Archive GAS 콼럼 추가: BTRIteration, HeartbeatTime, HeartbeatStep, SearchRangeType, SearchRangeNote, GptScores, WaitInfo_DateRange, WaitInfo_TimeRange, DEGRADED
- [ ] Supertonic TTS Lexicon Skip 문제 검증

---

## 📚 [CRITICAL] Agent Registry 재등록 방법

**배경**: GCP Console UI에 버그가 있어 UI로는 등록 불가. REST API 직접 호출만 가능.

```
Hub Chat → Gemini 모델 선택 →
"agent_registry_register 도구를 실행해서 MCP 서버를 재등록해줘"
```

또는 Claude.ai에서:
```
ASTERION MCP:agent_registry_register 호출
```
→ 기존 서비스 자동 삭제 후 현재 ALL_TOOLS 기준 전체 재등록

---

## 🤖 MCP 도구 계층 (v5.18, 89개)

| 계층 | 수 | 분류 |
|------|----|------|
| L0 | 21 | VedAstro (베딕 점성술 연산) |
| L1 | 22 | BTR (생시 보정 파이프라인 + 알림) + 영상 자동화 |
| L2 | 7 | GCloud (Cloud Run, Agent Registry) |
| L3 | 13 | SystemOps (GitHub, Sheets CRUD, HTTP) |
| L4 | 18 | Workspace (Drive, Docs, GAS) |
| L5 | 3 | AI (call_gemini, call_claude, call_gpt) |
| L6 | 5 | Report/Ops (BTR 보고서, 감사로그) |

### 환경변수 (Cloud Run)
```
ANTHROPIC_API_KEY    GEMINI_API_KEY    OPENAI_API_KEY
GITHUB_PAT           GITHUB_OWNER=victuar918
GCP_PROJECT=asterion-server   GCP_REGION=asia-northeast3
GOOGLE_CLIENT_ID     GOOGLE_CLIENT_SECRET    GOOGLE_REFRESH_TOKEN
MCP_SECRET_KEY
```

---

## ⚠️ 알아두면 유용한 함정들

### VedAstro AllPlanetData(All) POST is broken
POST /Calculate/AllPlanetData with PlanetName "All" returns the FIRST planet (Sun) data duplicated across all 9 planets. v5.13에서 행성별 GET 루프로 전환. POST 절대 되돌리기 금지.

### GitHub Pages (RegistrationForm)
- 저장소 설정에서 수동 활성화 필요 (API로 활성화 불가 — 401)
- `deploy_script_webapp`도 403 (OAuth scope `script.deployments` 미포함)
- GAS 업데이트: `update_script_file` ✓ / 배포: 수동 1회

### Gemini array 파라미터
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
- 단일 `Code.gs` 파일에 모든 코드 (SIGNREG_CONFIG, _PVREG_COL, 4개 함수 + doPost)
- `update_script_file` 후 배포는 수동 1회 (deploy_script_webapp scope 부족)
- 테스트 시 cleanupTestData 함수 임시 추가 → 직접 실행 → 제거 후 재배포 필요

### Cloud Run 배포
- GitHub push → 배포 완료까지 약 2~3분
- 배포 후 `get_system_status`로 버전 확인
- `github_write_file` 후 반드시 버전 확인 후 다음 작업 진행

### BTR 알림 흐름
```
MCP btr_write_notification → BTRNotifications 시트 (GCP ADC)
    → Hub SSE 5초 폴링 → 바지 점등
    → 관리자 응답 → Gemini 채팅 전달
    → updateNotifStatus('responded') → 카드 제거
```

---

*이 파일은 Claude가 작성하고 지훈님이 검토합니다.*
