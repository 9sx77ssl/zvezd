// PM2 process definition for the Lolz Star Bot.
// Start with: pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'zvezd',
      cwd: __dirname,
      script: 'src/index.ts',
      interpreter: '/usr/local/bin/bun',
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
