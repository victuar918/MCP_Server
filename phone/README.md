# ASTERION PhoneServer — 갤럭시 S22 Ultra 상주 서버

도메인: **asterion-origin.uk** (Cloudflare)
- MCP: `https://mcp.asterion-origin.uk` → 폰 `localhost:8080`
- Hub: `https://hub.asterion-origin.uk` → 폰 `localhost:8090` (2단계 예약)

## 설계 원칙
- `index.js`(서버 본체)는 **수정하지 않는다.** 폰 전용 차이는 전부 `phone/boot.js` 래퍼가 흡수.
- 따라서 **GCP Cloud Run 경로는 그대로 살아있고**, 문제 시 커넥터 URL만 되돌리면 즉시 복귀.

## 1. 앱 설치 (공폰)
1. f-droid.org → F-Droid 설치 → F-Droid에서 **Termux**, **Termux:Boot** 설치 (플레이스토어판 금지)
2. Termux:Boot 한 번 실행 (부팅 훅 등록)
3. 설정 → 앱 → Termux → 배터리 → **제한 없음**
4. 설정 → 배터리 → **배터리 보호(85%)** 켜기 — 24시간 충전 기기 필수

## 2. Cloudflare 터널 (대시보드)
1. dash.cloudflare.com → **Networking > Tunnels** → 터널 생성 (이름: `asterion-phone`)
2. **토큰**(`eyJ`로 시작) 복사해 보관
3. 터널 → **경로(Routes) 탭 → 경로 추가 → 게시된 애플리케이션**
   - 호스트 이름: `mcp` + `asterion-origin.uk`
   - 서비스 URL: `http://localhost:8080`
   - (커넥터가 연결된 뒤에 이 화면이 열립니다 → 3번을 먼저 해도 됨)

## 3. 폰 설치 (Termux 한 줄)
```
curl -sL https://raw.githubusercontent.com/victuar918/MCP_Server/main/phone/setup.sh | bash
```

## 4. 키 입력 (1회)
```
nano ~/srv/MCP_Server/.env      # API 키들
nano ~/srv/sa-key.json          # GCP 서비스계정 키 JSON 전체 붙여넣기
echo '터널토큰' > ~/.cloudflared_token
```
- 서비스계정 키: GCP 콘솔 → IAM → 서비스 계정 → Cloud Run이 쓰는 SA → 키 → **JSON 생성**
- 이 키가 없으면 영상 시트 도구(video_*)와 GCP 관리 도구가 동작하지 않습니다.

## 5. 기동
```
pm2 start ~/srv/MCP_Server/phone/ecosystem.config.js
pm2 save
pm2 logs mcp-server --lines 30
```
확인: `https://mcp.asterion-origin.uk` 접속 → 서버 상태 JSON이 보이면 성공.

## 자동배포 (Claude 워크플로 유지)
`watcher`가 60초마다 GitHub main을 확인 → 새 커밋이면 `git pull` + 의존성 설치 + `pm2 restart`.
즉, Claude가 GitHub에 패치하면 폰에 **1분 내 자동 반영**. GCP 시절과 동일한 개발 흐름.

## 문제 해결
| 증상 | 확인 |
|---|---|
| 접속 시 1033 | cloudflared 미기동 → `pm2 logs cloudflared` |
| 접속 시 502 | MCP 프로세스 다운 → `pm2 logs mcp-server` |
| video_* 도구 실패 | `sa-key.json` 경로/내용 확인 (`[boot] SA token minted` 로그 확인) |
| 재부팅 후 정지 | Termux:Boot 설치·1회 실행 여부, 배터리 최적화 예외 |

## 롤백 (GCP 복귀)
Cloud Run + `cloudbuild.yaml`은 그대로 보존. 커넥터/Hub의 MCP URL을
`https://mcp-server-611151539232.asia-northeast3.run.app` 로 되돌리면 즉시 복귀.
