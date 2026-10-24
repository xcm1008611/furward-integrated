import "./selfhost-loader.mjs";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, mkdir, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "lando-selfhost-test-"));
const directory = join(temporary, "data");
process.env.DATA_DIR = directory;
const store = await import("../lib/cms-store-node.ts");
const { dataPaths, openDatabase, closeDatabases } = await import("../lib/selfhost-database.mjs");
let passed = 0;
const ok = name => { passed++; console.log(`✓ ${name}`); };
const run = (script, args = [], data = directory) => spawnSync(process.execPath, [resolve(root, script), ...args], { cwd: root, env: { ...process.env, DATA_DIR: data }, encoding: "utf8" });
const child = code => new Promise((resolveResult, reject) => {
  const p = spawn(process.execPath, ["--import", resolve(root, "scripts/selfhost-loader.mjs"), "--input-type=module", "-e", code], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = ""; p.stdout.on("data", b => stdout += b); p.stderr.on("data", b => stderr += b);
  p.on("error", reject); p.on("exit", status => resolveResult({ status, stdout, stderr }));
});

try {
  const initial = await store.getContent();
  assert.equal(initial.revision, 0); assert.equal(initial.content.sections.length, 9);
  const first = await store.saveContent(initial.content, 0);
  await assert.rejects(store.saveContent(initial.content, 0), store.CmsConflictError);
  ok("默认内容、初次保存及过期版本冲突");

  const storeURL = new URL("../lib/cms-store-node.ts", import.meta.url).href;
  const concurrencyCode = `const s=await import(${JSON.stringify(storeURL)});const c=(await s.getContent()).content;try{await s.saveContent(c,1);process.stdout.write('saved')}catch(e){if(e.name==='CmsConflictError')process.stdout.write('conflict');else throw e}`;
  const concurrent = await Promise.all([child(concurrencyCode), child(concurrencyCode)]);
  assert.deepEqual(concurrent.map(x => x.stdout).sort(), ["conflict", "saved"]);
  assert.equal((await store.getContent()).revision, 2);
  ok("两个独立进程并发保存只允许一个成功");

  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64"));
  const media = await store.saveMedia(png, "../../测试.png", "image/png", "png");
  assert.equal(media.name, "测试.png");
  assert.deepEqual((await store.getMedia(media.id)).body, png);
  assert.equal((await store.getMedia(media.id)).httpEtag, (await store.getMedia(media.id)).httpEtag);
  assert.equal(await store.getMedia("../../content.sqlite"), null);
  await assert.rejects(store.saveMedia(png, "bad.jpg", "image/jpeg", "jpg"));
  await assert.rejects(store.saveMedia(new TextEncoder().encode("<svg></svg>"), "bad.svg", "image/svg+xml", "svg"));
  ok("图片内容、MIME、不可变ETag及路径保护");

  openDatabase().exec("CREATE TRIGGER test_media_failure BEFORE INSERT ON media BEGIN SELECT RAISE(ABORT, 'test insert failure'); END;");
  const before = await readdir(dataPaths().uploads);
  await assert.rejects(store.saveMedia(png, "fail.png", "image/png", "png"));
  assert.deepEqual(await readdir(dataPaths().uploads), before);
  openDatabase().exec("DROP TRIGGER test_media_failure;");
  ok("媒体元数据写入失败时清理新文件");

  const attempts = await Promise.all(Array.from({ length: 8 }, () => store.checkLoginRateLimit("shared-test")));
  assert.equal(attempts.filter(item => item.allowed).length, 5);
  await store.recordLoginFailure("shared-test");
  closeDatabases();
  assert.equal((await store.checkLoginRateLimit("shared-test")).allowed, false);
  openDatabase().prepare("UPDATE admin_login_limits SET reset_at = ? WHERE key = ?").run(Date.now() - 1, "shared-test");
  assert.equal((await store.checkLoginRateLimit("shared-test")).allowed, true);
  await store.clearLoginFailures("shared-test");
  assert.equal((await store.checkLoginRateLimit("shared-test")).allowed, true);
  ok("持久化原子登录额度、过期重置和成功清除");

  const content = (await store.getContent()).content;
  content.sections[0].images[0].src = media.url;
  const saved = await store.saveContent(content, 2);
  closeDatabases();
  assert.equal((await store.getContent()).revision, saved.revision);
  assert.equal((await store.listMedia()).length, 1);
  ok("数据库关闭后重新打开仍保留内容与上传");

  const backup = join(temporary, "backup");
  let command = run("scripts/selfhost-backup.mjs", [backup]);
  assert.equal(command.status, 0, command.stderr);
  const restored = join(temporary, "restored");
  command = run("scripts/selfhost-restore.mjs", [backup], restored);
  assert.equal(command.status, 0, command.stderr);
  const persisted = await child(`process.env.DATA_DIR=${JSON.stringify(restored)};const s=await import(${JSON.stringify(storeURL)});process.stdout.write(JSON.stringify({revision:(await s.getContent()).revision,media:(await s.listMedia()).length,bytes:(await s.getMedia(${JSON.stringify(media.id)})).size}))`);
  assert.deepEqual(JSON.parse(persisted.stdout), { revision: 3, media: 1, bytes: png.length });
  assert.notEqual(run("scripts/selfhost-restore.mjs", [backup], restored).status, 0);
  command = run("scripts/selfhost-restore.mjs", [backup, "--replace"], restored);
  assert.equal(command.status, 0, command.stderr);
  assert.equal((await readdir(join(restored, "backups"))).length, 1);
  ok("完整备份恢复、非空库保护和替换前自动备份");

  const migration = join(temporary, "migration");
  await mkdir(join(migration, "uploads"), { recursive: true });
  await writeFile(join(migration, "content.json"), JSON.stringify(saved));
  await copyFile(join(directory, "uploads", media.id), join(migration, "uploads", media.id));
  command = run("scripts/selfhost-restore.mjs", ["--from-content", migration], join(temporary, "migrated"));
  assert.equal(command.status, 0, command.stderr);
  await rm(join(migration, "uploads", media.id));
  assert.notEqual(run("scripts/selfhost-restore.mjs", ["--from-content", migration], join(temporary, "missing-media")).status, 0);
  ok("线上公开快照导入，缺失引用图片时拒绝迁移");

  const envURL = new URL("./selfhost-env.mjs", import.meta.url).href;
  const pathResult = await child(`await import(${JSON.stringify(envURL)});process.chdir(${JSON.stringify(temporary)});const p=await import(${JSON.stringify(new URL("../lib/selfhost-database.mjs", import.meta.url).href)});process.stdout.write(p.dataPaths().directory)`);
  assert.equal(pathResult.stdout, directory);
  ok("standalone改变工作目录后仍使用原持久化DATA_DIR");
  console.log(`自托管集成检查通过：${passed} 组。`);
} finally { closeDatabases(); await rm(temporary, { recursive: true, force: true }); }
