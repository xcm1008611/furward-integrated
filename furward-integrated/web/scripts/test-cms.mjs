/** Run with `node scripts/test-cms.mjs` (Node 22.13+).
 * Uses actual SQLite for the generated migrations and compare-and-swap SQL.
 * Only the Cloudflare bindings and identity boundary are substituted in memory.
 */
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const sqlite = new DatabaseSync(":memory:");
const migrationNames = (await readdir(new URL("drizzle/", root))).filter((name) => name.endsWith(".sql")).sort();
assert.ok(migrationNames.length, "A committed D1 migration is required");
for (const name of migrationNames) sqlite.exec(await readFile(new URL(`drizzle/${name}`, root), "utf8"));

const objects = new Map();
const state = { authenticated: true, failNextMediaInsert: false, env: {} };
state.env.DB = {
  prepare(sql) {
    let bindings = [];
    const execute = () => {
      if (state.failNextMediaInsert && sql.startsWith("INSERT INTO media")) {
        state.failNextMediaInsert = false;
        throw new Error("Simulated metadata write failure");
      }
      return sqlite.prepare(sql);
    };
    return {
      bind(...values) { bindings = values; return this; },
      async first() { return execute().get(...bindings) ?? null; },
      async all() { return { results: execute().all(...bindings) }; },
      async run() { return { meta: { changes: Number(execute().run(...bindings).changes) } }; },
    };
  },
};
state.env.BUCKET = {
  async put(id, bytes, options) { objects.set(id, { bytes: new Uint8Array(bytes), options }); },
  async delete(id) { objects.delete(id); },
  async get(id) {
    const object = objects.get(id);
    return object ? { body: new Response(object.bytes).body, size: object.bytes.length, httpEtag: `"${id}"` } : null;
  },
};
globalThis[Symbol.for("lando.cms.test")] = state;

const dataModule = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const modules = {
  "cloudflare:workers": dataModule('export const env = globalThis[Symbol.for("lando.cms.test")].env;'),
  "@/lib/admin-auth": dataModule('export async function isAdminAuthenticated() { return globalThis[Symbol.for("lando.cms.test")].authenticated; }'),
};
async function compile(relativePath, name) {
  const source = await readFile(new URL(relativePath, root), "utf8");
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  code = code.replace(/from\s+(["'])([^"']+)\1/g, (whole, quote, id) => modules[id] ? `from ${JSON.stringify(modules[id])}` : whole);
  const url = dataModule(code);
  if (name) modules[name] = url;
  return import(url);
}
await compile("lib/editorial-defaults.ts", "./editorial-defaults");
await compile("lib/furward-v2-defaults.ts", "./furward-v2-defaults");
const { defaultContent, upgradeContent } = await compile("lib/content.ts", "@/lib/content");
const validation = await compile("lib/cms-validation.ts", "@/lib/cms-validation");
const store = await compile("lib/cms-store.ts", "@/lib/cms-store");
const contentRoute = await compile("app/api/content/route.ts");
const mediaRoute = await compile("app/api/media/route.ts");
const imageRoute = await compile("app/api/media/[id]/route.ts");
const clone = () => structuredClone(defaultContent);
const saveRequest = (content, expectedRevision, origin = "https://example.com") => new Request("https://example.com/api/content", { method: "PUT", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ content, expectedRevision }) });
const png = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V3UAAAAASUVORK5CYII=", "base64"));
const uploadRequest = (bytes = png, type = "image/png", origin = "https://example.com") => {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), "替换图片.png");
  return new Request("https://example.com/api/media", { method: "POST", headers: { Origin: origin }, body: form });
};

test("default content satisfies the shared schema and reads without creating a row", async () => {
  assert.deepEqual(validation.validateContent(clone()), defaultContent);
  assert.equal((await store.getContent()).revision, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM site_content").get().total, 0);
});

test("unsafe links, traversal, invalid crops, duplicate sections and overlarge galleries are rejected", () => {
  for (const link of ["javascript:alert(1)", "data:text/html,x", "//evil.example", "http://example.com", "https://name:password@example.com"]) {
    assert.throws(() => validation.validateLink(link), validation.CmsValidationError);
  }
  for (const src of ["https://evil.example/a.png", "//evil.example/a.png", "/reference/../secret", "/reference/%2e%2e/secret", "/reference/a\\b.png", "/api/media/not-a-uuid.png"]) {
    assert.throws(() => validation.validateImageSrc(src), validation.CmsValidationError);
  }
  assert.equal(validation.validateLink("#about"), "#about");
  assert.equal(validation.validateLink("mailto:hello@example.com"), "mailto:hello@example.com");
  const content = clone(); content.sections[0].images[0].positionX = 101;
  assert.throws(() => validation.validateContent(content), validation.CmsValidationError);
  const duplicate = clone(); duplicate.sections[1].id = duplicate.sections[0].id;
  assert.throws(() => validation.validateContent(duplicate), validation.CmsValidationError);
  const tooMany = clone();
  tooMany.sections[0].images = Array.from({ length: 61 }, (_, i) => ({ ...tooMany.sections[0].images[0], id: `image-${i}` }));
  assert.throws(() => validation.validateContent(tooMany), validation.CmsValidationError);
  assert.throws(() => validation.validateSavePayload({ content: clone(), expectedRevision: -1 }), validation.CmsValidationError);
});

test("initial writes and subsequent updates atomically reject stale revisions", async () => {
  const results = await Promise.allSettled([store.saveContent(clone(), 0), store.saveContent(clone(), 0)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof store.CmsConflictError).length, 1);
  const edited = clone(); edited.site.name = "已保存的网站";
  assert.equal((await store.saveContent(edited, 1)).revision, 2);
  await assert.rejects(store.saveContent(clone(), 1), store.CmsConflictError);
  assert.equal((await store.getContent()).content.site.name, "已保存的网站");
});

test("anonymous reads remain public; writes and media listing require authentication", async () => {
  state.authenticated = false;
  assert.equal((await contentRoute.GET()).status, 200);
  assert.equal((await contentRoute.PUT(saveRequest(clone(), 2))).status, 401);
  assert.equal((await mediaRoute.GET()).status, 401);
  assert.equal((await mediaRoute.POST(uploadRequest())).status, 401);
  state.authenticated = true;
});

test("route writes enforce same-origin, schema errors and revision conflicts", async () => {
  assert.equal((await contentRoute.PUT(saveRequest(clone(), 2, "https://evil.example"))).status, 403);
  assert.equal((await mediaRoute.POST(uploadRequest(png, "image/png", "https://evil.example"))).status, 403);
  const unsafe = clone(); unsafe.sections[0].buttonHref = "javascript:alert(1)";
  assert.equal((await contentRoute.PUT(saveRequest(unsafe, 2))).status, 400);
  const successful = await contentRoute.PUT(saveRequest(clone(), 2));
  assert.equal(successful.status, 200);
  assert.equal((await successful.json()).revision, 3);
  assert.equal((await contentRoute.PUT(saveRequest(clone(), 2))).status, 409);
  const cli = saveRequest(clone(), 3); cli.headers.delete("origin");
  assert.equal((await contentRoute.PUT(cli)).status, 200);
});

test("origin validation normalizes Host and ports while rejecting spoofed proxy hosts", () => {
  const request = (headers, url = "http://localhost:3000/api/content") => new Request(url, { headers });
  assert.equal(validation.isSameOrigin(request({ Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" })), true);
  assert.equal(validation.isSameOrigin(request({ Host: "EXAMPLE.com:443", Origin: "https://example.com", "X-Forwarded-Proto": "https" })), true);
  assert.equal(validation.isSameOrigin(request({ Host: "[::1]:3000", Origin: "http://[::1]:3000" })), true);
  assert.equal(validation.isSameOrigin(request({ Host: "example.com", Origin: "https://evil.example", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https" })), false);
  assert.equal(validation.isSameOrigin(request({ Host: "example.com", Origin: "https://example.com", "X-Forwarded-Proto": "https, http" })), false);
  assert.equal(validation.isSameOrigin(request({ Host: "example.com@evil.example", Origin: "https://evil.example", "X-Forwarded-Proto": "https" })), false);
  assert.equal(validation.isSameOrigin(request({ "Sec-Fetch-Site": "cross-site" })), false);
  assert.equal(validation.isSameOrigin(request({ "Sec-Fetch-Site": "same-site" })), false);
  assert.equal(validation.isSameOrigin(request({})), true);
  assert.equal(validation.isSameOrigin(request({ Origin: "http://localhost:3000" })), true);
  assert.equal(validation.isSameOrigin(request({ Origin: "null" })), false);
  assert.equal(validation.isSameOrigin(request({ Origin: "http://localhost:3000/path" })), false);
});

test("the content API rejects an old schema even when its revision matches", async () => {
  const before = await store.getContent();
  for (const version of [undefined, 1, 2]) {
    const old = clone();
    if (version === undefined) delete old.schemaVersion; else old.schemaVersion = version;
    const response = await contentRoute.PUT(saveRequest(old, before.revision));
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /旧版/);
    assert.equal((await store.getContent()).revision, before.revision);
  }
});

test("uploads reject spoofed image content, SVG, MIME mismatches and oversize bodies", async () => {
  assert.equal((await mediaRoute.POST(uploadRequest(new TextEncoder().encode("<svg></svg>")))).status, 400);
  assert.equal((await mediaRoute.POST(uploadRequest(png, "image/gif"))).status, 400);
  assert.throws(() => validation.detectImage(new Uint8Array(validation.MAX_IMAGE_BYTES + 1), "image/png"), validation.CmsValidationError);
  await assert.rejects(validation.readLimitedBody(new Request("https://example.com", { method: "POST", body: "12345" }), 4), validation.CmsValidationError);
  assert.equal(validation.safeDisplayName("../folder/测试\u0000.png"), "测试.png");
});

test("uploaded images persist in the library and are served with safe MIME, ETag and nosniff", async () => {
  const upload = await mediaRoute.POST(uploadRequest());
  assert.equal(upload.status, 201);
  const { item } = await upload.json();
  assert.match(item.id, validation.MEDIA_ID_PATTERN);
  assert.equal(item.type, "image/png");
  assert.equal(item.name, "替换图片.png");
  assert.equal((await (await mediaRoute.GET()).json()).items[0].id, item.id);
  state.authenticated = false;
  const request = new Request(`https://example.com${item.url}`);
  const result = await imageRoute.GET(request, { params: Promise.resolve({ id: item.id }) });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "image/png");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), png);
  request.headers.set("if-none-match", result.headers.get("etag"));
  assert.equal((await imageRoute.GET(request, { params: Promise.resolve({ id: item.id }) })).status, 304);
  assert.equal((await imageRoute.GET(request, { params: Promise.resolve({ id: "../secret" }) })).status, 404);
  state.authenticated = true;
});

test("metadata write failure rolls back the R2 upload", async () => {
  const before = objects.size;
  state.failNextMediaInsert = true;
  await assert.rejects(store.saveMedia(png, "rollback.png", "image/png", "png"), /metadata write failure/);
  assert.equal(objects.size, before);
});


test("current schema slot expansion preserves saved custom images, hidden sections and captions", () => {
  const saved = clone();
  saved.sections = saved.sections.slice(0, 5);
  saved.sections[0].images[0].src = '/api/media/11111111-1111-4111-8111-111111111111.png';
  saved.sections[0].images[0].positionX = 73;
  saved.sections[0].images[0].scale = 1.2;
  saved.sections[1].description = '我的自定义介绍';
  saved.sections[1].enabled = false;
  const upgraded = upgradeContent(saved);
  assert.equal(upgraded.sections.length, 9);
  assert.equal(upgraded.sections[0].images[0].src, saved.sections[0].images[0].src);
  assert.equal(upgraded.sections[0].images[0].positionX, 73);
  assert.equal(upgraded.sections[0].images[0].scale, 1.2);
  assert.equal(upgraded.sections[1].description, '我的自定义介绍');
  assert.equal(upgraded.sections[1].enabled, false);
  assert.deepEqual(upgradeContent(upgraded), upgraded);
  assert.deepEqual(validation.validateContent(upgraded), upgraded);
  const legacy = clone(); delete legacy.schemaVersion;
  assert.throws(() => validation.validateSavePayload({ content: legacy, expectedRevision: 4 }), /旧版/);
});


test("persistent login limiter reserves attempts atomically and resets expired windows", async () => {
  const key = "test-rate-key";
  const attempts = await Promise.all(Array.from({ length: 20 }, () => store.checkLoginRateLimit(key)));
  assert.equal(attempts.filter(result => result.allowed).length, 5);
  assert.ok(attempts.every(result => result.retryAfter > 0 && result.retryAfter <= 900));
  await Promise.all(Array.from({ length: 5 }, () => store.recordLoginFailure(key)));
  assert.equal(sqlite.prepare("SELECT failures FROM admin_login_limits WHERE key=?").get(key).failures, 5);
  assert.equal((await store.checkLoginRateLimit(key)).allowed, false);
  sqlite.prepare("UPDATE admin_login_limits SET reset_at=? WHERE key=?").run(Date.now() - 1, key);
  assert.equal((await store.checkLoginRateLimit(key)).allowed, true);
  assert.equal(sqlite.prepare("SELECT failures FROM admin_login_limits WHERE key=?").get(key).failures, 0);
  await store.clearLoginFailures(key);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM admin_login_limits WHERE key=?").get(key).total, 0);
});
