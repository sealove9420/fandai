#!/usr/bin/env node
// Clean reverse-proxy version, written from scratch.
// No Cloudflare Tunnel, no cloudflared, no Telegram, no embedded tokens.
// Flow:
//   client --TLS--> <DIRECT_DOMAIN>:443 (platform ingress)
//          --plain--> this server on $PORT
//          --WS upgrade--> 127.0.0.1:8001 (Xray, started below)
//          --outbound--> internet (Xray freedom outbound)
//
// Env vars (set in Abasthan):
//   PORT           - set by the platform, default 3000
//   UUID           - required, your node UUID (generate a fresh one)
//   DIRECT_DOMAIN  - the platform domain, e.g. provider-each-shark.abasthan.app
//   NAME           - optional node name, default "Direct"
//   XRAY_PORT      - optional, default 8001
//   SUB_PATH       - optional, default "sub"

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '3000', 10);
const UUID = process.env.UUID || '';
const DIRECT_DOMAIN = process.env.DIRECT_DOMAIN || process.env.ARGO_DOMAIN || '';
const NAME = process.env.NAME || 'Direct';
const XRAY_PORT = parseInt(process.env.XRAY_PORT || '8001', 10);
const SUB_PATH = process.env.SUB_PATH || 'sub';

// Internal WS fallback ports (localhost only, never exposed).
const P_VLESS_TCP = 18001;
const P_VLESS_WS = 18002;
const P_VMESS_WS = 18003;
const P_TROJAN_WS = 18004;
const WS_PATHS = ['/vless-argo', '/vmess-argo', '/trojan-argo'];

if (!UUID) {
  console.log('WARNING: UUID is empty. Set UUID in Abasthan env vars. Using a random one for this run only: ' + crypto.randomUUID());
}
const uuid = UUID || crypto.randomUUID();

if (!DIRECT_DOMAIN) {
  console.log('WARNING: DIRECT_DOMAIN is empty. Set it to your Abasthan domain, e.g. provider-each-shark.abasthan.app');
}
const domain = DIRECT_DOMAIN || 'example.invalid';

// --- Xray config, written at startup ---
function xrayConfig() {
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'main',
        port: XRAY_PORT,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: {
          clients: [{ id: uuid, flow: 'xtls-rprx-vision' }],
          decryption: 'none',
          fallbacks: [
            { dest: P_VLESS_TCP },
            { path: '/vless-argo', dest: P_VLESS_WS },
            { path: '/vmess-argo', dest: P_VMESS_WS },
            { path: '/trojan-argo', dest: P_TROJAN_WS },
          ],
        },
        streamSettings: { network: 'tcp' },
      },
      {
        tag: 'vless-tcp',
        port: P_VLESS_TCP,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: { clients: [{ id: uuid }], decryption: 'none' },
        streamSettings: { network: 'tcp' },
      },
      {
        tag: 'vless-ws',
        port: P_VLESS_WS,
        listen: '127.0.0.1',
        protocol: 'vless',
        settings: { clients: [{ id: uuid }], decryption: 'none' },
        streamSettings: { network: 'ws', wsSettings: { path: '/vless-argo' } },
      },
      {
        tag: 'vmess-ws',
        port: P_VMESS_WS,
        listen: '127.0.0.1',
        protocol: 'vmess',
        settings: { clients: [{ id: uuid, alterId: 0 }] },
        streamSettings: { network: 'ws', wsSettings: { path: '/vmess-argo' } },
      },
      {
        tag: 'trojan-ws',
        port: P_TROJAN_WS,
        listen: '127.0.0.1',
        protocol: 'trojan',
        settings: { clients: [{ password: uuid }] },
        streamSettings: { network: 'ws', wsSettings: { path: '/trojan-argo' } },
      },
    ],
    outbounds: [
      { protocol: 'freedom', tag: 'direct' },
      { protocol: 'blackhole', tag: 'blocked' },
    ],
  };
}

function startXray() {
  const xrayBin = path.join(__dirname, 'xray');
  if (!fs.existsSync(xrayBin)) {
    console.log('ERROR: ./xray binary not found. Build step must download it first (see README).');
    return null;
  }
  fs.writeFileSync(path.join(__dirname, 'config.json'), JSON.stringify(xrayConfig(), null, 2));
  const child = spawn(xrayBin, ['run', '-c', 'config.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => process.stdout.write('[xray] ' + d));
  child.stderr.on('data', (d) => process.stdout.write('[xray] ' + d));
  child.on('exit', (code) => console.log('[xray] exited with code ' + code));
  return child;
}

// --- Subscription ---
function subscription() {
  const enc = encodeURIComponent;
  const vless =
    `vless://${uuid}@${domain}:443?encryption=none&security=tls&sni=${domain}&fp=firefox&type=ws&host=${domain}&path=${enc('/vless-argo?ed=2560')}#${enc(NAME + '-VLESS')}`;
  const vmessObj = {
    v: '2', ps: NAME + '-VMESS', add: domain, port: '443', id: uuid, aid: '0',
    scy: 'auto', net: 'ws', type: 'none', host: domain,
    path: '/vmess-argo?ed=2560', tls: 'tls', sni: domain, fp: 'firefox',
  };
  const vmess = 'vmess://' + Buffer.from(JSON.stringify(vmessObj)).toString('base64');
  const trojan =
    `trojan://${uuid}@${domain}:443?security=tls&sni=${domain}&fp=firefox&type=ws&host=${domain}&path=${enc('/trojan-argo?ed=2560')}#${enc(NAME + '-TROJAN')}`;
  return Buffer.from([vless, vmess, trojan].join('\n')).toString('base64');
}

// --- HTTP server: / , /sub, everything else 404 ---
const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/' + SUB_PATH) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(subscription());
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

// --- WebSocket reverse proxy: upgrade -> 127.0.0.1:XRAY_PORT ---
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (!WS_PATHS.includes(url.pathname)) {
    socket.destroy();
    return;
  }
  const target = net.connect(XRAY_PORT, '127.0.0.1', () => {
    let headerLines = '';
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'connection' || lk === 'upgrade') continue;
      headerLines += `${k}: ${v}\r\n`;
    }
    target.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${XRAY_PORT}\r\n` +
      headerLines +
      'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n'
    );
    if (head && head.length) target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
});

startXray();
server.listen(PORT, () => {
  console.log(`Direct reverse-proxy server listening on ${PORT}`);
  console.log(`Domain: ${domain}`);
  console.log(`Xray WS on 127.0.0.1:${XRAY_PORT}, paths: ${WS_PATHS.join(', ')}`);
  console.log(`Subscription: /${SUB_PATH}`);
});
