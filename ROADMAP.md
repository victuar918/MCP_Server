# ASTERION 시스템 로드맵 & 유지관리 가이드

> **최종 업데이트**: 2026-05-23  
> **현재 버전**: MCP v5.9 · Hub v3.6

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

### GCP 인프라
- **프로젝트 ID**: `asterion-server`
- **리전**: `asia-northeast3` (서울)
- **배포**: GitHub main push → Cloud Trigger → Cloud Build → Cloud Run
- **Archive SS ID**: `1ym1cgr1apEyTlqtJXqrfdnLjoyJTh086CjGycMcUOS8`
- **JuliarCalendar SS ID**: `1whKvFyWmb-qbR6OJt5dcI6WOJMLB5MUIzNMlJBFeq_g`
- **Cloud Run SA**: `611151539232-compute@developer.gserviceaccount.com` (Archive SS 편집자 권한 보유)

---

## ✅ 완료된 구축 항목

### MCP 서버 (v5.9)
- [x] L0~L6 계층 구조 79개 도구 (VedAstro, BTR, GCloud, SystemOps, Workspace, AI, Report)
- [x] Agent Registry TOOL_SPEC 등록
- [x] BTR 파이프라인: create_btr_session → save_runtime_snapshot → validate_sclass_gate
- [x] 앵커링 방지 가이드라인: `critical_issues` → 검증 의제 프레이밍 (buildAntiAnchoredContext)
- [x] 알림 재설계: `info_request` + `phase_confirm`만 유지, sclass_reached·rubric_held 제거
- [x] `btr_finalize_confirmed` / `btr_finalize_held`: Archive 업데이트만, 알림 없음
- [x] `fetchWithTimeout`: 모든 외부 HTTP 요청 타임아웃 처리
- [x] `gh_push_files`: 여러 파일 한 번의 커밋으로 push (Git Tree API)
- [x] `init_btr_sheets`: BTRRuntime·BTRNotifications 시트 생성 + 헤더 + OAuth 진단
- [x] BTRRuntime·BTRNotifications 시트 생성 완료 (Archive SS)

### Hub Chat (v3.6)
- [x] Claude / Gemini 멀티모델 (Native MCP 연결)
- [x] COOP/COEP 헤더 → SharedArrayBuffer → WASM 멀티스레딩
- [x] Supertonic 3 TTS v4.2.15 (ONNX, 문장 단위 청크 파이프라인)
- [x] BTR 알림 시스템: SSE 5초 폴링 → 알림 카드 → 응답 → Gemini 전달
- [x] Drive KB 연동, 시스템 프롬프트 추가 입력
- [x] Freestyle 모드 (페르소나 해제)

---

## 🚧 진행 중 / 다음 작업

### 즉시 수정 필요
- [ ] **Gemini 400 오류**: `sheets_write`, `append_sheet_row` 파라미터의 `array` 타입에 `items` 필드 누락
  → Gemini로 BTR 파이프라인 실행 시 도구 호출 실패
  → MCP `buildMcpToolSection()` 또는 파라미터 스키마에서 수정
- [ ] **Agent Registry 재등록**: v5.9 기준 79개 도구 재등록 필요 (기존 74개)
  → Hub에서 Gemini에게 `agent_registry_register 실행해줘` 명령

### 검증 필요
- [ ] **BTR 알림 End-to-End 테스트**
  1. `btr_write_notification(type:'info_request', ...)` 호출
  2. BTRNotifications 시트 기록 확인
  3. Hub 🔔 뱃지 점등 확인
  4. 응답 입력 → Gemini 전달 확인

### Archive GAS Web App — 미완성 페이지
- [ ] `booklet.html` — 고객 북클릿 생성/조회
- [ ] `forwarding.html` — 발송 관리
- 완성된 페이지: index, worksdesk, selectstone, inventory, invenmanage, stoneinfo, newlisting, design, analysismemo, productimage, structureindex

### 중장기
- [ ] Supertonic TTS Lexicon Skip 문제 검증 (직접 테스트 후 판단)
- [ ] BTR 3자 루브릭 실전 파이프라인 1회 완전 실행
- [ ] ASTERION Flow 구독 분석 (Annual/Monthly/Weekly) 구현

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

**등록 스키마 핵심**:
- `interfaces[0].protocolBinding` = `JSONRPC` (대소문자 정확히)
- `mcpServerSpec.type` = `TOOL_SPEC`
- 각 tool에 `inputSchema: {type:'object'}` 필수
- URL에 `?serviceId=asterion-mcp` 쿼리 파라미터 필수

---

## 🤖 MCP 도구 계층 (v5.9, 79개)

| 계층 | 수 | 분류 |
|------|----|------|
| L0 | 21 | VedAstro (베딕 점성술 연산) |
| L1 | 17 | BTR (생시 보정 파이프라인 + 알림) |
| L2 | 7 | GCloud (Cloud Run, Agent Registry) |
| L3 | 9 | SystemOps (GitHub, Sheets, HTTP, gh_push_files) |
| L4 | 17 | Workspace (Drive, Docs, GAS) |
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
3. Hub `index.js` `buildMcpToolSection()`의 해당 레이어 목록에 추가
4. `agent_registry_register` 재호출

### Google OAuth 토큰 (MCP 서버)
- `GOOGLE_REFRESH_TOKEN`: OAuth Playground 발급
- 필요 스코프: drive + spreadsheets + documents + script.projects + cloud-platform
- 현재 상태: spreadsheets 쓰기 권한 미포함 → GCP ADC 폴백으로 동작
- 근본 해결: 전체 스코프로 토큰 재발급 후 cloudrun_set_env 업데이트

### BTR 알림 흐름
```
MCP btr_write_notification → BTRNotifications 시트 (GCP ADC)
    → Hub SSE 5초 폴링 → 뱃지 점등
    → 관리자 응답 → Gemini 채팅 전달
    → updateNotifStatus('responded') → 카드 제거
```

### Cloud Run 배포
- GitHub push → 배포 완료까지 약 3~5분
- 배포 후 `get_system_status`로 버전 확인
- `github_write_file` 후 반드시 버전 확인하고 다음 작업 진행

---

*이 파일은 Claude가 작성하고 지훈님이 검토합니다.*
