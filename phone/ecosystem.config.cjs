const H = process.env.HOME;
const P = process.env.PREFIX || '/data/data/com.termux/files/usr';

module.exports = {
  apps: [
    {
      name: 'mcp-server',
      cwd: H + '/srv/MCP_Server',
      script: 'phone/boot.js',   // index.js를 직접 띄우지 않고 래퍼 경유 (metadata shim + .env 로드)
      interpreter: 'node',
      env: { PORT: '8080' },
      max_restarts: 100,
      restart_delay: 3000,
      max_memory_restart: '1G'
    },
    {
      name: 'cloudflared',
      script: P + '/bin/bash',
      interpreter: 'none',
      args: ['-lc', 'exec cloudflared tunnel run --token "$(cat $HOME/.cloudflared_token)" 2>&1'],
      max_restarts: 200,
      restart_delay: 5000
    },
    {
      name: 'watcher',
      cwd: H + '/srv/MCP_Server',
      script: 'phone/watcher.sh',
      interpreter: 'bash',
      max_restarts: 50,
      restart_delay: 10000
    },
    {
      // Hub Chat — MCP와 같은 폰. MCP_SERVER_URL은 127.0.0.1:8080 로컬 직결(.env)
      name: 'ai-chat-hub',
      cwd: H + '/srv/AI_Chat_Hub',
      script: 'phone/boot.js',
      interpreter: 'node',
      env: { PORT: '8090' },
      max_restarts: 100,
      restart_delay: 3000,
      max_memory_restart: '1G'
    },
    {
      // Hub 전용 watcher — MCP watcher와 독립(한쪽이 죽어도 다른 쪽 유지)
      name: 'watcher-hub',
      cwd: H + '/srv/AI_Chat_Hub',
      script: 'phone/watcher-hub.sh',
      interpreter: 'bash',
      max_restarts: 50,
      restart_delay: 10000
    }
  ]
};
