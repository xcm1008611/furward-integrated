import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import net from 'node:net';

const root = fileURLToPath(new URL('../', import.meta.url));
const production = process.argv.includes('--production');
const port = Number(process.env.PORT || 3000);
const webPort = Number(process.env.WEB_PORT || 3001);
const demoPort = Number(process.env.DEMO_PORT || 8100);
// LAN HTTPS for phone microphones; HTTPS_PORT=0 turns it off.
const httpsPort = Number(process.env.HTTPS_PORT ?? 3443);
const host = process.env.BIND_ADDRESS || '0.0.0.0';
const children = [];
let stopping = false;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) throw new Error(`${command} 未成功完成，请检查上面的提示。`);
}
function launch(command, args, cwd, env = {}) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) { console.error(`服务退出（${code}），正在停止其他服务。`); stop(1); } });
  return child;
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); process.exit(code); }, 2000).unref();
}
async function free(p) {
  await new Promise((accept, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`端口 ${p} 已被使用。请关闭占用它的服务，或设置 PORT / WEB_PORT / DEMO_PORT。`)));
    probe.listen(p, host, () => probe.close(accept));
  });
}
async function ready(url) {
  for (let i = 0; i < 120; i++) {
    if (stopping) throw new Error('服务启动中断');
    try { const response = await fetch(url, { signal: AbortSignal.timeout(3000) }); if (response.ok) return; } catch { /* wait for process */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500));
  }
  throw new Error(`服务没有及时启动：${url}`);
}

function lanAddresses() {
  const found = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) for (const ip of addresses || []) {
    const physical = /^(en\d+|eth\d+|wlan\d+|wl\w+|Ethernet|Wi-Fi)/i.test(name);
    if (ip.family === 'IPv4' && !ip.internal && (physical || /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip.address)))
      found.push(ip.address);
  }
  return found;
}

/** A local CA (kept across runs, so a phone trusts it once) signs a server certificate for the current LAN addresses. */
function ensureTls(addresses) {
  const dir = resolve(root, '.runtime/tls');
  const file = name => resolve(dir, name);
  const names = ['DNS:localhost', 'IP:127.0.0.1', ...addresses.map(ip => `IP:${ip}`)].join(',');
  const openssl = args => {
    const result = spawnSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    if (result.status !== 0) throw new Error(`openssl ${args[0]}：${result.stderr?.toString().trim() || '无法运行'}`);
  };
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file('ca.crt')) || !existsSync(file('ca.key'))) {
    writeFileSync(file('ca.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n');
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650', '-subj', '/CN=Furward Local CA',
      '-config', 'ca.cnf', '-extensions', 'v3_ca', '-keyout', 'ca.key', '-out', 'ca.crt']);
  }
  const current = existsSync(file('server.names')) ? readFileSync(file('server.names'), 'utf8') : '';
  if (current !== names || !existsSync(file('server.crt'))) {
    // iOS rejects server certificates valid for more than 825 days.
    writeFileSync(file('server.ext'), `basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names}\n`);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Furward LAN', '-keyout', 'server.key', '-out', 'server.csr']);
    openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-sha256', '-days', '397',
      '-extfile', 'server.ext', '-out', 'server.crt']);
    writeFileSync(file('server.names'), names);
  }
  return { TLS_KEY: file('server.key'), TLS_CERT: file('server.crt'), TLS_CA: file('ca.crt') };
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('请先安装 Node.js 24 或更高版本。');
  try {
    const existing = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }).then(r => r.json());
    if (existing.project === 'furward-integrated-v1') { console.log(`绒途已经运行：http://localhost:${port}/`); return; }
  } catch { /* first start */ }
  for (const p of [port, webPort, demoPort, ...(httpsPort ? [httpsPort] : [])]) await free(p);
  mkdirSync(resolve(root, '.runtime'), { recursive: true });
  if (!existsSync(resolve(root, 'web/node_modules/next'))) run('npm', ['ci'], resolve(root, 'web'));
  const python = resolve(root, 'demo-service/.venv/bin/python');
  if (!existsSync(python)) {
    run(process.env.PYTHON || 'python3', ['-m', 'venv', '.venv'], resolve(root, 'demo-service'));
  }
  if (spawnSync(python, ['-c', 'import fastapi, uvicorn, websockets'], { stdio: 'ignore' }).status !== 0)
    run(python, ['-m', 'pip', 'install', '-r', 'requirements-lock.txt'], resolve(root, 'demo-service'));
  if (!existsSync(resolve(root, 'web/.env.production'))) {
    run(process.execPath, ['web/scripts/setup-admin.mjs', '--generate', '--output', 'web/.env.production',
      '--credentials-file', '.runtime/管理员登录信息.txt']);
  }
  if (production && !existsSync(resolve(root, 'web/.next/standalone/server.js'))) run('npm', ['run', 'build:selfhost'], resolve(root, 'web'));
  launch(python, ['-m', 'uvicorn', 'demo_service.main:app', '--host', '127.0.0.1', '--port', String(demoPort), '--workers', '1'], resolve(root, 'demo-service'));
  launch(process.execPath, ['scripts/run-selfhost.mjs', production ? 'start' : 'dev', ...(production ? [] : ['--port', String(webPort)])], resolve(root, 'web'),
    { PORT: String(webPort), BIND_ADDRESS: '127.0.0.1' });
  await Promise.all([ready(`http://127.0.0.1:${webPort}/api/content`), ready(`http://127.0.0.1:${demoPort}/api/demo/health`)]);
  const addresses = host === '0.0.0.0' ? lanAddresses() : [];
  let tls = {};
  if (httpsPort) {
    try { tls = { HTTPS_PORT: String(httpsPort), ...ensureTls(addresses) }; }
    catch (error) { console.error(`局域网 HTTPS 未开启：${error.message}`); }
  }
  launch(process.execPath, ['scripts/gateway.mjs'], root, { PORT: String(port), BIND_ADDRESS: host, ...tls,
    WEB_ORIGIN: `http://127.0.0.1:${webPort}`, DEMO_ORIGIN: `http://127.0.0.1:${demoPort}`,
    NODE_ENV: production ? 'production' : 'development' });
  await ready(`http://127.0.0.1:${port}/healthz`);
  console.log(`\n绒途已启动\n首页：http://localhost:${port}/\n城市体验：http://localhost:${port}/experience\n管理后台：http://localhost:${port}/admin`);
  for (const ip of addresses) console.log(`同一 Wi-Fi：http://${ip}:${port}/experience`);
  if (tls.TLS_CERT) {
    for (const ip of addresses) console.log(`手机语音（HTTPS）：https://${ip}:${httpsPort}/assistance`);
    if (addresses[0]) console.log(`手机信任证书：先用 http://${addresses[0]}:${port}/furward-ca.crt 下载安装（只需一次）`);
  }
  console.log(`后台密码保存在：${resolve(root, '.runtime/管理员登录信息.txt')}\n保持窗口打开；按 Ctrl+C 停止。\n`);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
main().catch(error => { console.error(error.message); stop(1); process.exitCode = 1; });
