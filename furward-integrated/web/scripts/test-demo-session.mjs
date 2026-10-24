import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

// Execute the actual hook and its asynchronous callbacks with deterministic
// React/browser boundaries. Fetch deliberately ignores aborts in race tests:
// a response already decoded or queued must still be fenced by its generation.
const runtimeKey = Symbol.for('furward.demo.session.test');
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const hooksUrl = moduleUrl(`
  const runtime = () => globalThis[Symbol.for('furward.demo.session.test')];
  export const useRef = value => runtime().useRef(value);
  export const useState = value => runtime().useState(value);
  export const useEffect = (effect, deps) => runtime().useEffect(effect, deps);
  export const useCallback = (callback, deps) => runtime().useCallback(callback, deps);
`);
const source = await readFile(new URL('../lib/demo-session.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replace(/from ['"]react['"]/, `from ${JSON.stringify(hooksUrl)}`);
const { useDemoSession: renderSession } = await import(moduleUrl(code));
const snapshot = (id, revision = 0, status = 'IDLE') => ({ session_id: id, revision, status, distance_m: 0,
  current_step: 0, pause_reason: status === 'PAUSED' ? 'disconnected' : null, obstacle_active: false,
  obstacle_triggered: false, message: `${id}:${revision}:${status}` });

async function mount(t) {
  let cursor = 0, dirty = true, now = 0, nextTimer = 1, created = 0, value;
  const slots = [], effects = [], timers = new Map(), storage = new Map(), sockets = [], requests = [], calls = [];
  const sessions = new Map();
  const original = new Map(['fetch', 'WebSocket', 'sessionStorage', 'location', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const same = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  globalThis[runtimeKey] = {
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: initial };
      return [slots[index].value, next => {
        const result = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(result, slots[index].value)) { slots[index].value = result; dirty = true; }
      }];
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) slots[index] = { callback, deps };
      return slots[index].callback;
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (!same(slots[index]?.deps, deps)) {
        const old = slots[index];
        slots[index] = { deps, cleanup: old?.cleanup };
        effects.push(() => { old?.cleanup?.(); slots[index].cleanup = effect(); });
      }
    },
  };
  const install = (key, value) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const timer = (fn, delay, interval) => { const id = nextTimer++; timers.set(id, { fn, at: now + delay, interval }); return id; };
  install('performance', { now: () => now });
  install('setTimeout', (fn, delay) => timer(fn, delay, 0));
  install('setInterval', (fn, delay) => timer(fn, delay, delay));
  install('clearTimeout', id => timers.delete(id));
  install('clearInterval', id => timers.delete(id));
  install('location', { protocol: 'http:', host: 'test.example' });
  install('sessionStorage', { getItem: key => storage.get(key) ?? null, setItem: (key, item) => storage.set(key, item), removeItem: key => storage.delete(key) });
  install('WebSocket', class {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(packet) { this.sent.push(JSON.parse(packet)); }
    close() { this.readyState = 3; } // No automatic close event: also models a half-open link.
    open() { this.readyState = 1; this.onopen?.(); }
    receive(data) { this.onmessage?.({ data: JSON.stringify(data) }); }
    drop(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
  });
  const response = (data, ok = true, error) => ({ ok, json: async () => ok ? { ok, data } : { ok, error, message: error } });
  install('fetch', async (path, options) => {
    calls.push(path);
    if (path === '/api/demo/world') return response({ route: {} });
    if (path === '/api/demo/sessions') {
      const identity = { session_id: `session-${++created}`, token: `test-token-${created}` };
      sessions.set(identity.session_id, snapshot(identity.session_id));
      return response({ ...identity, state: sessions.get(identity.session_id) });
    }
    if (/\/(actions|text)$/.test(path)) {
      return await new Promise(resolve => requests.push({ path, options,
        succeed: data => resolve(response(data)), fail: error => resolve(response(null, false, error)) }));
    }
    const id = path.split('/').at(-1);
    return response(sessions.get(id));
  });
  async function settle() {
    for (let i = 0; i < 25; i++) {
      if (dirty) {
        dirty = false; cursor = 0; value = renderSession();
        for (const run of effects.splice(0)) run();
      }
      await Promise.resolve();
    }
  }
  async function advance(ms) {
    const target = now + ms;
    while (true) {
      const ready = [...timers].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!ready) break;
      const [id, item] = ready;
      now = item.at;
      if (item.interval) item.at += item.interval; else timers.delete(id);
      item.fn();
      await settle();
    }
    now = target;
    await settle();
  }
  async function connect() {
    await settle();
    const ws = sockets.at(-1);
    ws.open();
    const id = ws.sent[0].session_id;
    ws.receive({ type: 'demo.state', data: sessions.get(id) });
    await settle();
    return ws;
  }
  t.after(() => {
    for (const slot of slots) slot?.cleanup?.();
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
    delete globalThis[runtimeKey];
  });
  await settle();
  return { get value() { return value; }, get created() { return created; }, sockets, requests, sessions, calls, settle, connect, advance };
}

test('late old-session HTTP success cannot overwrite replacement state or unlock its request', async t => {
  const h = await mount(t), oldSocket = await h.connect();
  const old = h.value.action('start');
  const first = h.requests[0];
  oldSocket.drop(1008);
  await h.settle();
  await h.connect();
  const id = h.value.state.session_id;
  const current = h.value.action('start');
  await h.settle();
  assert.equal(first.options.signal.aborted, true);
  first.succeed(snapshot('session-1', 999, 'ACTIVE'));
  assert.equal(await old, null);
  await h.settle();
  assert.equal(h.value.state.session_id, id);
  assert.equal(h.value.busy, true);
  assert.equal(await h.value.action('pause'), null);
  h.requests[1].succeed(snapshot(id, 1, 'ACTIVE'));
  await current;
  await h.settle();
  assert.equal(h.value.busy, false);
  assert.equal(h.value.state.status, 'ACTIVE');
});

test('late old-effect HTTP auth error cannot invalidate a restored identity', async t => {
  const h = await mount(t);
  await h.connect();
  const pending = h.value.sendText('暂停');
  h.value.retry();
  await h.settle();
  await h.connect();
  h.requests[0].fail('AUTH');
  assert.equal(await pending, null);
  await h.settle();
  assert.equal(h.created, 1);
  assert.equal(h.value.error, '');
  assert.equal(h.value.notice, '');
  assert.equal(h.value.connection, 'online');
});

test('queued old WebSocket message/open/expiry callbacks cannot alter a replacement session', async t => {
  const h = await mount(t), old = await h.connect();
  old.drop(1008);
  await h.settle();
  const current = await h.connect();
  old.receive({ type: 'demo.state', data: snapshot('session-1', 999, 'ACTIVE') });
  old.open();
  old.drop(1008);
  await h.settle();
  assert.equal(h.created, 2);
  assert.equal(h.value.state.session_id, 'session-2');
  assert.equal(h.value.connection, 'online');
  assert.equal(current.readyState, 1);
  assert.equal(old.sent.length, 1);
});

test('an old socket in the same effect cannot schedule a second reconnect or overwrite progress', async t => {
  const h = await mount(t), old = await h.connect();
  old.drop();
  await h.advance(800);
  const current = await h.connect();
  current.receive({ type: 'demo.state', data: snapshot('session-1', 5, 'PAUSED') });
  old.receive({ type: 'demo.state', data: snapshot('session-1', 999, 'ACTIVE') });
  old.drop(1008);
  await h.settle();
  assert.equal(h.created, 1);
  assert.equal(h.value.state.revision, 5);
  assert.equal(h.value.state.status, 'PAUSED');
  assert.equal(h.value.connection, 'online');
});

test('wrong-session packets and same-session old revisions are ignored', async t => {
  const h = await mount(t), ws = await h.connect();
  ws.receive({ type: 'demo.state', data: snapshot('session-1', 5, 'PAUSED') });
  ws.receive({ type: 'demo.state', data: snapshot('session-1', 4, 'ACTIVE') });
  ws.receive({ type: 'demo.state', data: snapshot('other', 999, 'ACTIVE') });
  await h.settle();
  assert.equal(h.value.state.revision, 5);
  assert.equal(h.value.state.status, 'PAUSED');
});

test('missing pong changes to reconnecting without close event, blocks actions, and restores paused snapshot', async t => {
  const h = await mount(t), old = await h.connect();
  await h.advance(5007); // A pong need not align with the 5s sending interval.
  assert.deepEqual(old.sent.at(-1), { type: 'ping' });
  old.receive({ type: 'pong' });
  await h.advance(10000);
  assert.equal(h.value.connection, 'online');
  await h.advance(4999);
  assert.equal(h.value.connection, 'online');
  await h.advance(1);
  assert.equal(h.value.connection, 'reconnecting');
  assert.equal(old.readyState, 3);
  assert.equal(await h.value.action('start'), null);
  h.sessions.set('session-1', snapshot('session-1', 10, 'PAUSED'));
  await h.advance(800);
  await h.connect();
  assert.equal(h.value.state.status, 'PAUSED');
  assert.equal(h.value.connection, 'online');
  assert.equal(h.requests.length, 0); // Reconnection never auto-resumes.
});
