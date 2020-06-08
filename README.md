# Rippled Edge Proxy

### wss://xrpl.ws

XRP ledger full history cluster
High available, low latency & geographic routing. Provided by trusted XRP community members.

See: https://xrpl.ws

## Setup

This package (Typescript, node) runs best on [node 14](https://nodejs.org/download/release/latest-v14.x/). Tested on Debian and Ubuntu, and runs in Docker containers (of course).

1. Make sture node 14 is installed
2. Clone the repository
3. Enter the local (checked out) repository directory
4. Run `npm install` and `npm build` to install dependencies and build 
5. Install the process manager `pm2` globally, `npm install -g pm2` (or run in dev mode without the process manager)
6. Copy `config.default.json` to `config.json` and modify. Remove the `mattermost` and `xrpforensics` section if not required.
7. Run. Install in the `pm2` process manager with `npm run pm2`, or run in dev (verbose) with `npm run dev`. If running in pm2, check status with `pm2 monit` (and check the pm2 manual for more commands)
8. When running in pm2 mode, the proxy will run at **TCP port 4001**, the admin API will run at **TCP port 4002**. Please **KEEP THE ADMIN PORT CLOSED IN THE FIREWALL OF YOUR MACHINE/NETWORK!**. The admin port will automatically be the public port +1. To change the public port, change `pm2.config.js`. When running in dev mode, the proxy will run at TCP port 4000 and the admin port (+1) at 4001. You can change this by invoking the dev command manually (with `nodemon` globally installed, `npm install -g nodemon`) (`npm run build;PORT=4000 DEBUG=app*,msg* nodemon dist/index.js`) with a changed port number, or changing `package.json`.
