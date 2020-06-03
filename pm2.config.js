module.exports = {
  apps: [{
    name: 'RIPPLEDWSPROXY',
    script: 'dist/index.js',
    watch: true,
    instances: 1, // TODO: admin should report <all instance info>
    autorestart: true,
    max_memory_restart: '2000M',
    exec_mode: 'cluster',
    ignore_watch: ["node_modules", "db", ".git"],
    env: {
      DEBUG: 'app*'
    },
    env_pm2: {
      NODE_ENV: 'pm2',
      PORT: 4001
    }
  }]
}
