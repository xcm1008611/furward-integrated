/** Authentication and setup boundary tests; run with Node 24. */
import "./selfhost-loader.mjs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const password = randomBytes(24).toString("base64url");
const salt = randomBytes(16);
const hash = `pbkdf2-sha256$100000$${salt.toString("base64url")}$${pbkdf2Sync(password, salt, 100000, 32, "sha256").toString("base64url")}`;
const config = { passwordHash: hash, sessionSecret: randomBytes(32).toString("base64url") };
const rate = new Map();
globalThis[Symbol.for("lando.auth.test")] = { config, rate };
const dataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const modules = {
  "@/lib/content": new URL("../lib/content.ts", import.meta.url).href,
  "@/lib/admin-config": dataModule('export function getAdminConfig() { return globalThis[Symbol.for("lando.auth.test")].config; } export function getLoginAddress() { return "shared-admin-login"; }'),
  "@/lib/cms-store": dataModule(`
    const rate=globalThis[Symbol.for("lando.auth.test")].rate;
    export async function checkLoginRateLimit(key) { const count=(rate.get(key)||0)+1;rate.set(key,count);return {allowed:count<=5,retryAfter:900}; }
    export async function recordLoginFailure() {}
    export async function clearLoginFailures(key) {rate.delete(key);}
  `),
};
async function compile(path, name) {
  const source = await readFile(new URL(path, root), "utf8");
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  code = code.replace(/from\s+(["'])([^"']+)\1/g, (whole, _quote, id) => modules[id] ? `from ${JSON.stringify(modules[id])}` : whole);
  const url = dataModule(code);
  if (name) modules[name] = url;
  return import(url);
}
await compile("lib/cms-validation.ts", "@/lib/cms-validation");
const auth = await compile("lib/admin-auth.ts", "@/lib/admin-auth");
const login = await compile("app/api/admin/login/route.ts");
const logout = await compile("app/api/admin/logout/route.ts");
const nodeConfig = await compile("lib/admin-config-node.ts");
function loginRequest(value, origin = "https://example.com", extra = {}) {
  return new Request("https://example.com/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...extra }, body: JSON.stringify({ password: value }) });
}

test("PBKDF2 verifies both configuration formats and fails closed on invalid config", async () => {
  assert.equal(auth.isAdminConfigured(), true);
  assert.equal(await auth.verifyAdminPassword(password), true);
  assert.equal(await auth.verifyAdminPassword(`${password}x`), false);
  config.passwordHash = hash.replaceAll("$", ":");
  assert.equal(await auth.verifyAdminPassword(password), true);
  config.passwordHash = hash.replace("100000", "1");
  assert.equal(auth.isAdminConfigured(), false);
  assert.equal(await auth.verifyAdminPassword(password), false);
  config.passwordHash = hash;
});

test("signed sessions reject tampering, expiry, duplicate cookies and rotated secrets", async () => {
  const now = Date.now();
  const token = await auth.createAdminSession(now);
  assert.equal(await auth.validateAdminSession(token, now), true);
  assert.equal(await auth.validateAdminSession(token, now + 8 * 60 * 60 * 1000), false);
  assert.equal(await auth.validateAdminSession(`${token}a`, now), false);
  const [payload, signature] = token.split(".");
  const modified = JSON.parse(Buffer.from(payload, "base64url").toString());
  modified.exp += 60;
  assert.equal(await auth.validateAdminSession(`${Buffer.from(JSON.stringify(modified)).toString("base64url")}.${signature}`), false);
  const request = new Request("https://example.com/api/content", { headers: { cookie: `${auth.ADMIN_COOKIE}=${token}` } });
  assert.equal(await auth.isAdminAuthenticated(request), true);
  request.headers.append("cookie", `; ${auth.ADMIN_COOKIE}=${token}`);
  assert.equal(await auth.isAdminAuthenticated(request), false);
  const oldSecret = config.sessionSecret; config.sessionSecret = randomBytes(32).toString("base64url");
  assert.equal(await auth.validateAdminSession(token), false);
  config.sessionSecret = oldSecret;
  config.passwordHash = hash.replaceAll("$", ":");
  assert.equal(await auth.validateAdminSession(token), false);
  config.passwordHash = hash;
});

test("ChatGPT identity headers do not grant admin access; Node ignores forged client IP", async () => {
  const request = new Request("https://example.com/api/content", { headers: { "oai-authenticated-user-id": "owner", "oai-authenticated-user-email": "owner@example.com", "cf-connecting-ip": "198.51.100.5" } });
  assert.equal(await auth.isAdminAuthenticated(request), false);
  assert.equal(nodeConfig.getLoginAddress(request), "shared-admin-login");
  request.headers.set("cf-connecting-ip", "198.51.100.6");
  assert.equal(nodeConfig.getLoginAddress(request), "shared-admin-login");
});

test("login rejects cross-origin and incorrect credentials, then sets protected cookie", async () => {
  rate.clear();
  assert.equal((await login.POST(loginRequest(password, "https://attacker.example"))).status, 403);
  assert.equal(rate.size, 0);
  assert.equal((await login.POST(loginRequest("wrong"))).status, 401);
  const response = await login.POST(loginRequest(password));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  for (const part of ["HttpOnly", "SameSite=Strict", "Secure", "Max-Age=28800", "Path=/"]) assert.ok(cookie.includes(part));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(rate.size, 0);
  const cookieValue = cookie.split(";")[0].split("=")[1];
  assert.equal(await auth.validateAdminSession(cookieValue), true);
  const exit = await logout.POST(new Request("https://example.com/api/admin/logout", { method: "POST", headers: { Origin: "https://example.com" } }));
  assert.equal(exit.status, 200); assert.match(exit.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await logout.POST(loginRequest("", "https://attacker.example"))).status, 403);
});

test("parallel login attempts cannot bypass the five attempt limit", async () => {
  rate.clear();
  const responses = await Promise.all(Array.from({ length: 12 }, (_, index) => login.POST(loginRequest(`wrong-${index}`))));
  assert.equal(responses.filter(response => response.status === 401).length, 5);
  assert.equal(responses.filter(response => response.status === 429).length, 7);
  assert.equal(responses.find(response => response.status === 429).headers.get("retry-after"), "900");
  rate.clear();
});

test("Next internal URLs and HTTPS proxies preserve origin checks and cookie security", async () => {
  rate.clear();
  const local = new Request("http://localhost:3000/api/admin/login", { method: "POST", headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000", "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ password }) });
  const localResponse = await login.POST(local);
  assert.equal(localResponse.status, 200);
  assert.ok(!localResponse.headers.get("set-cookie").includes("; Secure"));
  const proxy = new Request("http://localhost:3000/api/admin/login", { method: "POST", headers: { Host: "example.com", Origin: "https://example.com", "X-Forwarded-Proto": "https", "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  const proxyResponse = await login.POST(proxy);
  assert.equal(proxyResponse.status, 200);
  assert.match(proxyResponse.headers.get("set-cookie"), /; Secure/);
  const wrongOrigin = new Request("http://localhost:3000/api/admin/login", { method: "POST", headers: { Host: "example.com", Origin: "https://evil.example", "X-Forwarded-Proto": "https", "X-Forwarded-Host": "evil.example", "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal((await login.POST(wrongOrigin)).status, 403);
  const noOrigin = new Request("https://example.com/api/admin/login", { method: "POST", headers: { "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" }, body: JSON.stringify({ password }) });
  assert.equal((await login.POST(noOrigin)).status, 403);
  assert.match(auth.adminCookie(new Request("https://example.com", { headers: { "X-Forwarded-Proto": "http" } }), "test"), /; Secure/);
});

test("missing auth setup never permits login and does not expose secret values", async () => {
  const previous = config.sessionSecret; config.sessionSecret = "";
  const response = await login.POST(loginRequest(password));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes(password), false);
  config.sessionSecret = previous;
});

test("setup writes usable private config, keeps passwords out of output and refuses overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lando-admin-"));
  try {
    const envFile = join(dir, ".env.production");
    const credentialsFile = join(dir, "credentials.txt");
    const args = [fileURLToPath(new URL("scripts/setup-admin.mjs", root)), "--generate", "--output", envFile, "--credentials-file", credentialsFile];
    const result = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const envText = await readFile(envFile, "utf8");
    const credentials = await readFile(credentialsFile, "utf8");
    const generatedPassword = credentials.match(/后台密码：(.+)/)[1];
    assert.ok(!`${result.stdout}${result.stderr}`.includes(generatedPassword));
    assert.ok(!envText.includes(generatedPassword));
    assert.match(envText, /pbkdf2-sha256:600000:/);
    assert.equal((await stat(envFile)).mode & 0o777, 0o600);
    assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);
    const before = { ...config };
    config.passwordHash = envText.match(/ADMIN_PASSWORD_HASH='([^']+)'/)[1];
    config.sessionSecret = envText.match(/ADMIN_SESSION_SECRET='([^']+)'/)[1];
    assert.equal(await auth.verifyAdminPassword(generatedPassword), true);
    Object.assign(config, before);
    const again = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.notEqual(again.status, 0);
    assert.equal(await readFile(envFile, "utf8"), envText);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
