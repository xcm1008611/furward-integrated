import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';

const port = Number(process.env.PORT || 3000);
const host = process.env.BIND_ADDRESS || '0.0.0.0';
// Optional LAN HTTPS so phone browsers treat the page as a secure context (microphone, wake lock).
const httpsPort = Number(process.env.HTTPS_PORT || 0);
const tls = httpsPort && process.env.TLS_KEY && process.env.TLS_CERT
  ? { key: readFileSync(process.env.TLS_KEY), cert: readFileSync(process.env.TLS_CERT) } : null;
const caCert = process.env.TLS_CA ? readFileSync(process.env.TLS_CA) : null;
const web = new URL(process.env.WEB_ORIGIN || 'http://127.0.0.1:3001');
const demo = new URL(process.env.DEMO_ORIGIN || 'http://127.0.0.1:8100');
const targetFor = path => path === '/ws/demo' || /^\/api\/demo(?:\/|\?|$)/.test(path) ? demo : web;

function upstream(req, target) {
  const headers = { ...req.headers };
  // A local gateway is the outer trust boundary. Production sits behind Caddy.
  if (process.env.TRUST_PROXY !== '1') {
    headers['x-forwarded-proto'] = req.socket.encrypted ? 'https' : 'http';
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  }
  return http.request({ hostname: target.hostname, port: target.port, path: req.url,
    method: req.method, headers });
}

function handle(req, res) {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, project: 'furward-integrated-v1' }));
    return;
  }
  // The local CA, so a phone can install it once and trust the LAN HTTPS address.
  if (req.url === '/furward-ca.crt' && caCert) {
    res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="furward-ca.crt"', 'cache-control': 'no-store' });
    res.end(caCert);
    return;
  }
  const proxy = upstream(req, targetFor(req.url || '/'));
  proxy.on('response', response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'UPSTREAM_UNAVAILABLE', message: '服务暂时不可用，请稍后重试。' }));
  });
  req.on('aborted', () => proxy.destroy());
  res.on('close', () => { if (!res.writableFinished) proxy.destroy(); });
  req.pipe(proxy);
}

function upgrade(req, socket, head) {
  const path = (req.url || '').split('?')[0];
  if (path !== '/ws/demo' && !(process.env.NODE_ENV !== 'production' && path.startsWith('/_next/'))) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return;
  }
  const proxy = upstream(req, path === '/ws/demo' ? demo : web);
  proxy.on('upgrade', (response, remote, upstreamHead) => {
    const headers = Object.entries(response.headers).flatMap(([key, value]) =>
      (Array.isArray(value) ? value : [value]).map(item => `${key}: ${item}`));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) remote.write(head);
    socket.pipe(remote); remote.pipe(socket);
    socket.on('error', () => remote.destroy()); remote.on('error', () => socket.destroy());
    socket.on('close', () => remote.destroy()); remote.on('close', () => socket.destroy());
  });
  proxy.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`); response.resume(); });
  proxy.on('error', () => socket.destroy());
  socket.on('error', () => proxy.destroy());
  proxy.end();
}

const servers = [http.createServer(handle)];
if (tls) servers.push(https.createServer(tls, handle));
for (const server of servers) {
  server.on('upgrade', upgrade);
  server.on('error', error => { console.error('入口服务启动失败：', error.message); process.exitCode = 1; });
}
servers[0].listen(port, host, () => console.log(`Furward 统一入口 http://${host}:${port}`));
servers[1]?.listen(httpsPort, host, () => console.log(`Furward 统一入口 https://${host}:${httpsPort}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  let open = servers.length;
  for (const server of servers) server.close(() => { if (--open === 0) process.exit(0); });
  setTimeout(() => process.exit(0), 1500).unref();
});
