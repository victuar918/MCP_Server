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
      args: ['-lc', 'exec cloudflared tunnel run --token "$(cat $HOME/.cloudflared_token)"'],
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
    }
  ]
};
