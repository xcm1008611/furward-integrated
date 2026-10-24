import http from 'node:http';

const port = Number(process.env.PORT || 3000);
const host = process.env.BIND_ADDRESS || '0.0.0.0';
const web = new URL(process.env.WEB_ORIGIN || 'http://127.0.0.1:3001');
const demo = new URL(process.env.DEMO_ORIGIN || 'http://127.0.0.1:8100');
const targetFor = path => path === '/ws/demo' || /^\/api\/demo(?:\/|\?|$)/.test(path) ? demo : web;

function upstream(req, target) {
  const headers = { ...req.headers };
  // A local gateway is the outer trust boundary. Production sits behind Caddy.
  if (process.env.TRUST_PROXY !== '1') {
    headers['x-forwarded-proto'] = 'http';
    headers['x-forwarded-host'] = req.headers.host;
    headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  }
  return http.request({ hostname: target.hostname, port: target.port, path: req.url,
    method: req.method, headers });
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, project: 'furward-integrated-v1' }));
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
});

server.on('upgrade', (req, socket, head) => {
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
});
server.on('error', error => { console.error('入口服务启动失败：', error.message); process.exitCode = 1; });
server.listen(port, host, () => console.log(`Furward 统一入口 http://${host}:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
});
