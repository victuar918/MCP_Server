# ASTERION 시스템 로드맵 & 유지관리 가이드

> **작성일**: 2026-05-19  
> **목적**: 구축 과정에서 얻은 핵심 지식을 보존하여 추후 유지관리 시 참조

---

## 🔱 시스템 전체 구조

### 서비스 URL
| 서비스 | URL |
|--------|-----|
| MCP 서버 | https://mcp-server-611151539232.asia-northeast3.run.app |
| Hub Chat | https://ai-chat-hub-w4ozxil5aq-du.a.run.app |
| Agent Registry ID | agentregistry-00000000-0000-0000-d9ab-851925d12ac3 |

### GitHub 레포지토리
| 레포 | 용도 |
|------|------|
| victuar918/MCP_Server | MCP 서버 (Cloud Run 자동배포) |
| victuar918/AI_Chat_Hub | Hub Chat 프론트+백엔드 |
| victuar918/ASTERION | 모바일 앱 (GitHub Pages PWA) |

### GCP 인프라
- **프로젝트 ID**: `asterion-server`
- **리전**: `asia-northeast3` (서울)
- **배포 방식**: GitHub main 브랜치 push → Cloud Trigger → Cloud Build → Cloud Run 자동배포

---

## 📚 [CRITICAL] Agent Registry MCP 등록 — 절대 잊으면 안 되는 기록

### 왜 이게 그토록 어려웠나

**GCP Console UI 버그**: "Add MCP Server" 버튼이 있지만 항상 `protocolBinding: HTTP_JSON`을 강제로 전송하는 버그가 있어서 저장 불가. **UI로는 절대 등록 불가능**, REST API 직접 호출만 가능.

**gcloud CLI도 안 됨**: `gcloud services create --interfaces` 플래그가 Agent Registry에서 동작하지 않음.

**Discovery API**: 공식 REST 스키마는 `https://agentregistry.googleapis.com/$discovery/rest?version=v1alpha`에서 확인 가능 (GCP 인증 필요).

### 오류 이력 (버전별 삽질 기록)

| MCP 버전 | 오류 | 원인 | 수정 |
|----------|------|------|------|
| v5.2 | `Unknown name "endpointUri"` | 필드명 오류 | `endpointUri` → `url` |
| v5.3 | `Unknown name "toolSpec"` | 필드명 오류 | `toolSpec` → `content` |
| v5.4 | `inputSchema is required` | 각 도구마다 inputSchema 필수 | `{type:'object'}` 최소형식 추가 |
| v5.5 | ✅ 성공 | — | TOOL_SPEC + content + inputSchema |

### Discovery API에서 확인한 정확한 스키마

```json
POST https://agentregistry.googleapis.com/v1alpha/projects/{proj}/locations/{loc}/services?serviceId={id}

{
  "displayName": "ASTERION AI Evolution Engine",
  "interfaces": [{
    "url": "https://...run.app/mcp",
    "protocolBinding": "JSONRPC"
  }],
  "mcpServerSpec": {
    "type": "TOOL_SPEC",
    "content": {
      "tools": [
        {
          "name": "tool_name",
          "description": "설명",
          "inputSchema": {"type": "object"}
        }
      ]
    }
  }
}
```

**핵심 체크리스트**:
- `interfaces[0].url` — endpointUri, endpoint 아님
- `interfaces[0].protocolBinding` — `JSONRPC` (대소문자 정확히)
- `mcpServerSpec.content.tools` — toolSpec 아님
- 각 tool에 `inputSchema` 필수 (없으면 400 오류)
- URL에 `?serviceId=asterion-mcp` 쿼리 파라미터 필수
- 응답이 Long-running Operation → done:true 될 때까지 폴링 필요

### 재등록 방법 (추후 도구 추가/변경 시)

Hub Chat에서 Gemini에게 다음 명령:
```
agent_registry_register 도구를 실행해서 MCP 서버를 재등록해줘
```
또는 Claude.ai에서 직접:
```
ASTERION MCP의 agent_registry_register 도구를 호출해줘
```
→ 기존 서비스 자동 삭제 후 74개 도구 전체 재등록됨

---

## 🤖 Hub Chat 구조 (v3.2 현재)

### 백엔드 (Node.js/Express)

```
AI_Chat_Hub/
├── index.js          # 서버 메인 (모든 API 로직)
└── static/
    └── index.html    # 프론트엔드 SPA
```

### 3개 AI 모델의 MCP 연결 방식

| AI | MCP 연결 방식 | 특이사항 |
|----|--------------|---------|
| Claude | Native API (`mcp-client-2025-11-20` 베타) | SSE URL 직접 주입 |
| Gemini | Manual function calling 루프 | buildMcpToolSection()으로 시스템 프롬프트에 도구 목록 주입 필수 |
| GPT | Responses API + native MCP | SSE URL 직접 주입 |

### Gemini 할루시네이션 방지 핵심 코드

Gemini에게 `functionDeclarations`를 전달해도, "도구 목록 나열해줘" 같은 질문에는 학습 데이터 기반으로 도구를 만들어낸다. 이를 방지하려면 **시스템 프롬프트에 실제 도구 목록을 직접 삽입**해야 함:

```javascript
function buildMcpToolSection() {
  return `\n\n[실제 연결된 MCP 도구 ${mcpTools.length}개 — asterion-mcp]\n...`;
}
// buildStringSystem() 내에서 항상 buildMcpToolSection()을 포함
```

### Gemini 400 오류 주의 (arrays 관련)

Gemini `functionDeclarations`에서 `type:'array'`인 파라미터는 반드시 `items` 필드가 있어야 함. 없으면 400 `INVALID_ARGUMENT` 오류 발생.

```javascript
// ❌ 오류 발생
values: {type:'array'}

// ✅ 올바른 형식
values: {type:'array', items:{type:'array', items:{type:'string'}}}
```

---

## 🛠 MCP 서버 구조 (v5.5 현재)

### 엔드포인트

| 경로 | 방식 | 용도 |
|------|------|------|
| `GET /sse` | SSE | 레거시 MCP 연결 (Hub Chat용) |
| `POST /message` | REST | SSE 세션 도구 호출 |
| `ALL /mcp` | REST JSON-RPC | Agent Registry / Claude API용 |
| `POST /` | REST JSON-RPC | 기본 JSON-RPC |
| `GET /` | REST | 상태 확인 |

### 도구 계층 (L0~L6, 총 74개)

| 계층 | 수 | 도구 분류 |
|------|-----|-----------|
| L0 | 21 | VedAstro (베딕 점성술 연산) |
| L1 | 13 | BTR (생시 보정 세션 관리) |
| L2 | 7 | GCloud (Cloud Run, Agent Registry) |
| L3 | 8 | SystemOps (GitHub, Sheets, HTTP) |
| L4 | 17 | Workspace (Drive, Docs, GAS) |
| L5 | 3 | AI (call_gemini, call_claude, call_gpt) |
| L6 | 5 | Report/Ops (BTR 보고서, 감사로그) |

### 환경변수 (Cloud Run 설정)

```
ANTHROPIC_API_KEY    # Claude API
GEMINI_API_KEY       # Gemini API
OPENAI_API_KEY       # GPT API
GITHUB_PAT           # GitHub Personal Access Token
GITHUB_OWNER         # victuar918
GCP_PROJECT          # asterion-server
GCP_REGION           # asia-northeast3
GOOGLE_CLIENT_ID     # OAuth 클라이언트 ID
GOOGLE_CLIENT_SECRET # OAuth 클라이언트 시크릿
GOOGLE_REFRESH_TOKEN # OAuth 리프레시 토큰
MCP_SECRET_KEY       # (미설정) MCP 접근 키
```

### 핵심 스프레드시트 ID

```
Archive:        1ym1cgr1apEyTlqtJXqrfdnLjoyJTh086CjGycMcUOS8
JuliarCalendar: 1whKvFyWmb-qbR6OJt5dcI6WOJMLB5MUIzNMlJBFeq_g
```

---

## 📋 향후 작업 계획 (HubChat 고도화)

### Phase 0 — 즉시 수정 (완료)
- [x] Agent Registry TOOL_SPEC 등록
- [x] Gemini 도구 할루시네이션 방지 (buildMcpToolSection)
- [ ] Gemini 400 오류 수정 (sheets_write, append_sheet_row items 필드)

### Phase 1 — HubChat UX 개편
- [ ] 엔터키 → 줄바꿈 처리 (Shift+Enter도 줄바꿈, 버튼 클릭 = 전송)
- [ ] GPT 버튼 → BTR 알림 버튼으로 교체
- [ ] BTR 알림 카드 시스템 (Google Sheets `BTRNotifications` 시트 연동)
- [ ] 알림 카드 답변 발송 → 해당 카드 삭제
- [ ] 카드 수동 삭제 버튼 (삭제 확인 팝업 포함)
- [ ] 설정 페이지 기본 틀

### Phase 2 — Supertonic TTS 통합
- [ ] `onnxruntime-web` CDN 통합
- [ ] 설정 페이지에서 7개 파일 업로드
- [ ] IndexedDB에 모델 파일 영구 저장
- [ ] TTS 추론 파이프라인 (4개 ONNX 순서대로 실행)
- [ ] AI 답변 하단 재생/정지 버튼
- [ ] 화자 선택 (sid 0~9), 속도/피치 조절
- [ ] 알림 메시지 TTS 설정

### Phase 3 — MCP BTR 알림 연동
- [ ] MCP에 `send_notification` 도구 추가
- [ ] BTR 루브릭 파이프라인에서 컨펌 필요 시 알림 발송
- [ ] Google Sheets `BTRNotifications` 시트 스키마 설계
- [ ] 알림 폴링 (Hub Chat이 주기적으로 시트 체크)

---

## 🔑 Supertonic 3 TTS 모델 정보

### 다운로드
```
https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2
```

### 파일 목록 (7개, 압축 해제 후)
```
duration_predictor.int8.onnx  # 발음 길이 예측
text_encoder.int8.onnx         # 텍스트 인코딩
vector_estimator.int8.onnx     # 음향 특성 추정
vocoder.int8.onnx              # 실제 음성 생성 (가장 큰 파일)
tts.json                       # 모델 설정
unicode_indexer.bin            # 텍스트 토크나이저
voice.bin                      # 화자 스타일
```

### 사양
- **언어**: 31개 (ko, en, ja 포함)
- **화자**: 10명 (sid 0~9)
- **샘플레이트**: 24000 Hz
- **브라우저 지원**: `onnxruntime-web` via WebGPU/WASM (서버 불필요)
- **출력**: 16-bit WAV
- **표현 태그**: `<laugh>`, `<breath>`, `<sigh>` 지원

### 브라우저에서 실행하는 원리
```javascript
// CDN 로드
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js"></script>

// 4단계 파이프라인: text → text_encoder → vector_estimator → duration_predictor → vocoder → audio
```

### 핸드폰에서 준비하는 법
1. 위 링크에서 `.tar.bz2` 다운로드 (약 150~200MB)
2. ZArchiver 앱(안드로이드)으로 압축 해제
3. Hub Chat 설정 페이지에서 7개 파일 각각 업로드
4. IndexedDB에 저장 → 이후 재업로드 불필요

---

## 🧠 BTR 시스템 개요

### S-Class 달성 조건
```
Claude ≥ 97점 AND Gemini ≥ 97점 AND GPT ≥ 97점
AND critical_issues = []
```

### 루브릭 진행 시 컨펌이 필요한 시점
1. 추가 정보 필요 시 (Phase 구간 후보 표시 + 정보 요청)
2. Phase 구간 확정 요청 시 (컨펌 or 수정 입력)
3. 최종 보고서 작성 완료 알림

### 알림 카드 데이터 구조 (Google Sheets BTRNotifications)
```
| id | session_id | type | content | status | created_at | responded_at |
```
- `type`: `info_request` | `phase_confirm` | `report_complete`
- `status`: `pending` | `responded` | `dismissed`
- 답변 발송 → status를 `responded`로 업데이트 후 행 삭제

---

## ⚠️ 알아두면 유용한 함정들

### Cloud Run 배포 관련
- GitHub push → Cloud Build 빌드 → 배포까지 약 3~5분 소요
- 배포 중에 `get_system_status` 도구로 버전 확인 가능
- `github_write_file` 후 반드시 버전 확인하고 다음 작업 진행

### MCP 도구 추가 시 주의사항
- `ALL_TOOLS` 배열에 도구 추가
- 해당 계층 Set(L0~L6)에도 추가
- `agent_registry_register` 재호출 필요 (Tools 탭 업데이트)
- Gemini 400 방지: array 타입에는 항상 `items` 필드 포함

### Google OAuth 토큰 관련
- `GOOGLE_REFRESH_TOKEN`은 Google OAuth Playground에서 발급
- 스코프: Drive, Sheets, Docs, Apps Script 모두 포함
- 토큰 만료 시 재발급 후 `cloudrun_set_env` 도구로 업데이트

### Gemini API 모델명
- 현재 사용: `gemini-3.1-pro-preview`
- Vertex AI에 등록되지 않음 → `generativelanguage.googleapis.com` 직접 호출
- 잘못된 예: Vertex AI endpoint로 Gemini 호출 → 모델 없음 오류

---

*이 파일은 AI(Claude)가 작성하고 지훈님이 검토합니다. 중요한 변경사항 발생 시 업데이트 바랍니다.*
