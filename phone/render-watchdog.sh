#!/data/data/com.termux/files/usr/bin/bash
# ─────────────────────────────────────────────────────────────
# render-watchdog.sh — ASTERION 렌더 앱 감시 (pm2: render-watchdog)
#  - 앱이 1분마다 갱신하는 render_status.txt 가 STALE_SEC 넘게 멈추면 앱을 실행
#  - 상태 파일이 한 번도 없으면 아무것도 하지 않음 (상태 파일 없는 구버전 앱 보호)
#  - 홈 아이콘과 같은 방식(MAIN/LAUNCHER)으로 실행 + 앱은 singleTask
#    → 이미 떠 있으면 기존 화면에 전달될 뿐 중복 실행 없음
#  - 실행 후 COOLDOWN_SEC 동안은 재실행하지 않음
#  - 일시 정지: output 폴더에 watchdog.off 파일을 만들면 감시 중단 (지우면 재개)
#  - 이 파일을 고친 뒤에는 watcher가 자동 재시작하지 않으므로: pm2 restart render-watchdog
# ─────────────────────────────────────────────────────────────
OUT="$HOME/storage/shared/Documents/work/ASTERION/YouTube/output"
STATUS="$OUT/render_status.txt"
OFF_FLAG="$OUT/watchdog.off"
ACT="com.asterion.video/.ui.AsterionVideoActivity"
STALE_SEC="${STALE_SEC:-600}"
CHECK_SEC="${CHECK_SEC:-60}"
COOLDOWN_SEC="${COOLDOWN_SEC:-600}"
last_launch=0

log() { echo "$(date '+%F %T') $*"; }

log "start: stale=${STALE_SEC}s check=${CHECK_SEC}s cooldown=${COOLDOWN_SEC}s"
while true; do
  now=$(date +%s)
  if [ -f "$OFF_FLAG" ]; then
    :
  elif [ -f "$STATUS" ]; then
    mt=$(stat -c %Y "$STATUS" 2>/dev/null || echo "$now")
    age=$(( now - mt ))
    if [ "$age" -gt "$STALE_SEC" ] && [ $(( now - last_launch )) -gt "$COOLDOWN_SEC" ]; then
      log "status stale ${age}s -> launch app"
      out=$(am start -a android.intent.action.MAIN -c android.intent.category.LAUNCHER -n "$ACT" 2>&1 | head -c 300 | paste -sd ' ')
      log "am: $out"
      last_launch=$now
    fi
  fi
  sleep "$CHECK_SEC"
done
