/**
 * PM2 Ecosystem — PLASCHEMA Customer Assistant
 * Start:    pm2 start ecosystem.config.js
 * Restart:  pm2 restart all
 * Logs:     pm2 logs
 * Status:   pm2 status
 * On boot:  pm2 save && pm2 startup
 */
module.exports = {
  apps: [
    {
      name: 'plaschema-api',
      script: './apps/api/dist/main.js',
      cwd: '/Users/mac/Customer Assistance',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      log_file: '/tmp/plaschema-api.log',
      error_file: '/tmp/plaschema-api-err.log',
      out_file: '/tmp/plaschema-api-out.log',
    },
    {
      name: 'plaschema-web',
      script: 'npm',
      args: 'run start',
      cwd: '/Users/mac/Customer Assistance/apps/web',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
      log_file: '/tmp/plaschema-web.log',
      error_file: '/tmp/plaschema-web-err.log',
      out_file: '/tmp/plaschema-web-out.log',
    },
  ],
};
