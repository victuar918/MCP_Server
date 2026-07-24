#!/data/data/com.termux/files/usr/bin/bash
set -e
echo '== ASTERION PhoneServer bootstrap =='

pkg update -y
pkg install -y nodejs-lts git curl nano || true

if ! command -v cloudflared >/dev/null 2>&1; then
  pkg install -y cloudflared 2>/dev/null || {
    echo '-- cloudflared: GitHub 릴리스 바이너리 설치 --'
    curl -L -o "$PREFIX/bin/cloudflared" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64
    chmod +x "$PREFIX/bin/cloudflared"
  }
fi

npm i -g pm2 --silent

mkdir -p "$HOME/srv" && cd "$HOME/srv"
[ -d MCP_Server ] || git clone https://github.com/victuar918/MCP_Server.git
cd MCP_Server
git config core.fileMode false
git pull -q origin main || true
npm install --omit=dev --no-audit --no-fund
[ -f .env ] || cp phone/env.mcp.template .env
chmod +x phone/watcher.sh phone/setup.sh 2>/dev/null || true

# 부팅 자동 시작 (Termux:Boot)
mkdir -p "$HOME/.termux/boot"
cat > "$HOME/.termux/boot/start-asterion.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
termux-wake-lock
sleep 10
pm2 resurrect || pm2 start $HOME/srv/MCP_Server/phone/ecosystem.config.cjs
EOF
chmod +x "$HOME/.termux/boot/start-asterion.sh"

termux-wake-lock || true

echo ''
echo '===== 설치 완료 ====='
echo '남은 3가지:'
echo '  1) nano ~/srv/MCP_Server/.env      → API 키 입력 (Ctrl+O 저장, Ctrl+X 종료)'
echo '  2) ~/srv/sa-key.json               → 서비스계정 키 JSON 복사'
echo "  3) echo '터널토큰' > ~/.cloudflared_token"
echo ''
echo '그다음 기동:'
echo '  pm2 start ~/srv/MCP_Server/phone/ecosystem.config.cjs && pm2 save'
