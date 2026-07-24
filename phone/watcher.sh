#!/data/data/com.termux/files/usr/bin/bash
# 60초마다 GitHub main 확인 → 새 커밋이면 pull + deps + 재시작 (Claude 자동배포 루프)
cd "$HOME/srv/MCP_Server" || exit 1
echo "[watcher] start $(date)"
while true; do
  git fetch origin main -q 2>/dev/null || true
  L=$(git rev-parse HEAD 2>/dev/null)
  R=$(git rev-parse origin/main 2>/dev/null)
  if [ -n "$R" ] && [ "$L" != "$R" ]; then
    echo "[watcher] update: $L -> $R"
    git pull -q origin main || true
    npm install --omit=dev --no-audit --no-fund --silent || true
    pm2 restart mcp-server --update-env
    echo "[watcher] restarted $(date)"
  fi
  sleep 60
done
