// PM2 process definition for zvezd.
// Start with: pm2 start ecosystem.config.cjs

const { execSync } = require('node:child_process');
const { existsSync } = require('node:fs');

// Resolve the bun binary instead of hardcoding a path: honour BUN_PATH, then
// the common install locations, then PATH.
function resolveBun() {
  for (const candidate of [process.env.BUN_PATH, '/usr/local/bin/bun', '/root/.bun/bin/bun']) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  try {
    return execSync('command -v bun', { encoding: 'utf8' }).trim();
  } catch {
    return 'bun';
  }
}

module.exports = {
  apps: [
    {
      name: 'zvezd',
      cwd: __dirname,
      script: 'src/index.ts',
      interpreter: resolveBun(),
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      restart_delay: 5000,
      min_uptime: '30s',
      max_restarts: 50,
      kill_timeout: 15000,
      time: true,
      merge_logs: true,
      out_file: '/root/.pm2/logs/zvezd-out.log',
      error_file: '/root/.pm2/logs/zvezd-error.log',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
