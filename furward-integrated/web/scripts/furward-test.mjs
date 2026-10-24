import './selfhost-loader.mjs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';
const { defaultContent, upgradeContent, FURWARD_SCHEMA_VERSION, DRAFT_KEY } = await import('../lib/content.ts');
const { furwardV2Defaults } = await import('../lib/furward-v2-defaults.ts');
const { defaultContent: oldDefault } = await import('../lib/legacy-content.ts');
const { createMigrationPlan } = await import('../lib/furward-migration.ts');
const { validateContent, validateSavePayload, validateImageSrc } = await import('../lib/cms-validation.ts');
const nodeStore = await import('../lib/cms-store-node.ts');
const { openDatabase, closeDatabases } = await import('../lib/selfhost-database.mjs');

const root = new URL('../', import.meta.url);
const upload = '/api/media/11111111-1111-4111-8111-111111111111.png';
const customLegacy = () => {
  const value = structuredClone(oldDefault);
  value.site.name = '我的旧网站'; value.sections[0].images[0].src = upload;
  value.sections[0].images[0].positionX = 73;
  value.sections[1].description = '需要保留的自定义介绍';
  value.sections[5].enabled = false;
  return value;
};
const customV2 = () => {
  const value = structuredClone(furwardV2Defaults);
  value.site.tagline = '用户自己的品牌标语';
  value.sections[0].description = '用户自己的首屏介绍';
  value.sections[0].images[0].scale = 1.35;
  value.sections.find(section => section.id === 'scenes').images[0] = {
    ...value.sections.find(section => section.id === 'scenes').images[0],
    src: upload, label: '用户实拍场景', alt: '自己的图片说明', positionX: 64, positionY: 38, scale: 1.2,
  };
  value.sections.find(section => section.id === 'gallery').images.push({
    id: 'my-extra-photo', label: '额外照片', src: upload, alt: '用户额外添加的图片', positionX: 50, positionY: 50, scale: 1,
  });
  value.sections.find(section => section.id === 'technology').items[0].description = '用户感知说明';
  value.sections.find(section => section.id === 'warmth').enabled = false;
  return value;
};
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

test('Furward defaults have only new assets and the agreed content contract', () => {
  assert.equal(FURWARD_SCHEMA_VERSION, 3); assert.equal(DRAFT_KEY, 'furward-content-draft-v3');
  assert.deepEqual(validateContent(defaultContent), defaultContent);
  assert.deepEqual(defaultContent.sections.map(section => section.id), ['hero','about','scenes','companion','textures','warmth','technology','gallery','footer']);
  assert.deepEqual(defaultContent.sections[0].images.map(image => image.id), ['hero-dog','hero-robot']);
  assert.equal(defaultContent.sections.reduce((n, section) => n + section.images.length, 0), 24);
  assert.ok(defaultContent.sections.flatMap(section => section.images).every(image => /^\/reference\/furward(?:-v3)?\//.test(image.src)));
  assert.equal(defaultContent.sections.flatMap(section => section.images).filter(image => image.src.startsWith('/reference/furward-v3/')).length, 18);
  assert.ok(defaultContent.sections.find(section => section.id === 'scenes').images.every(image => image.alt.includes('盲道')));
  const textures = defaultContent.sections.find(section => section.id === 'textures');
  assert.match(textures.description, /暖金色短毛/); assert.match(textures.description, /奶白色长毛/); assert.match(textures.description, /烟灰色顺毛/);
  assert.doesNotMatch(JSON.stringify(defaultContent), /lando|norris|formula|mclaren/i);
});

test('untouched v2 defaults become v3 without being reported as user edits', () => {
  const before = JSON.stringify(furwardV2Defaults);
  const plan = createMigrationPlan(furwardV2Defaults);
  assert.equal(plan.fromVersion, 2); assert.equal(plan.toVersion, 3); assert.equal(plan.needsMigration, true);
  assert.deepEqual(plan.content, defaultContent);
  assert.deepEqual(plan.customChanges, []); assert.deepEqual(plan.archivedSections, []);
  assert.equal(JSON.stringify(furwardV2Defaults), before);
  assert.equal(plan.content.sections[0].eyebrow, '有温度、会对话的 AI 导盲伙伴');
  assert.deepEqual(plan.content.sections[0].images.map(image => image.label), ['拉布拉多画面', '机器狗画面']);
  assert.deepEqual(upgradeContent(plan.content), plan.content);
});

test('v2 three-way migration retains uploaded images, personal copy, crop and added slots by ID', () => {
  const value = customV2();
  value.sections.reverse();
  value.sections.find(section => section.id === 'scenes').images.reverse();
  const before = JSON.stringify(value);
  const plan = createMigrationPlan(value);
  const upgraded = validateContent(plan.content);
  assert.equal(JSON.stringify(value), before);
  assert.equal(upgraded.site.tagline, value.site.tagline);
  assert.equal(upgraded.sections[0].description, '用户自己的首屏介绍');
  assert.equal(upgraded.sections[0].images[0].scale, 1.35);
  assert.deepEqual(upgraded.sections.find(section => section.id === 'scenes').images.find(image => image.id === 'scene-path'), value.sections.find(section => section.id === 'scenes').images.find(image => image.id === 'scene-path'));
  assert.equal(upgraded.sections.find(section => section.id === 'scenes').images.find(image => image.id === 'scene-indoor').src, '/reference/furward-v3/scene-indoor.png');
  assert.equal(upgraded.sections.find(section => section.id === 'gallery').images.at(-1).id, 'my-extra-photo');
  assert.equal(upgraded.sections.find(section => section.id === 'technology').items[0].description, '用户感知说明');
  assert.equal(upgraded.sections.find(section => section.id === 'warmth').enabled, false);
  assert.deepEqual(plan.preservedUploads, [upload]);
  assert.ok(plan.customChanges.length > 0);
  assert.ok(plan.customChanges.every(entry => entry.action === 'preserved_in_content'));
  assert.deepEqual(upgradeContent(upgradeContent(value)), upgraded);
  assert.equal(createMigrationPlan(upgraded).needsMigration, false);
  // Intentional v3 edits matching old defaults must not be upgraded a second time.
  upgraded.sections[0].eyebrow = furwardV2Defaults.sections[0].eyebrow;
  assert.equal(upgradeContent(upgraded).sections[0].eyebrow, furwardV2Defaults.sections[0].eyebrow);
});

test('legacy reads never revive old assets and the original custom content remains untouched', () => {
  const source = customLegacy(); const raw = JSON.stringify(source);
  const plan = createMigrationPlan(source);
  assert.deepEqual(plan.content, defaultContent);
  assert.deepEqual(upgradeContent(upgradeContent(source)), defaultContent);
  assert.equal(JSON.stringify(source), raw);
  assert.deepEqual(plan.preservedUploads, [upload]);
  assert.ok(plan.customChanges.some(entry => entry.path === 'site.name'));
  assert.ok(plan.customChanges.some(entry => entry.value === upload));
  assert.ok(plan.customChanges.some(entry => entry.value === '需要保留的自定义介绍'));
  assert.ok(plan.archivedSections.includes('ontrack'));
  assert.equal(createMigrationPlan(oldDefault).customChanges.length, 0);
});

test('v3 edits, scale, feature text and disabled sections survive repeated reads', () => {
  const value = structuredClone(defaultContent);
  value.site.name = '我的绒途'; value.sections[0].images[0].src = upload;
  value.sections[0].images[0].scale = 1.4; value.sections[0].images[0].positionY = 67;
  value.sections[1].enabled = false;
  value.sections.find(section => section.id === 'technology').items[0].description = '我的感知介绍';
  assert.deepEqual(upgradeContent(upgradeContent(value)), value);
  assert.deepEqual(validateContent(value), value);
  assert.equal(createMigrationPlan(value).needsMigration, false);
  assert.throws(() => upgradeContent({ ...value, schemaVersion: 99 }), /版本/);
});

test('old saves, Lando asset fallbacks and invalid scales cannot enter v3', () => {
  assert.throws(() => validateSavePayload({ content: oldDefault, expectedRevision: 2 }), /旧版/);
  assert.throws(() => validateSavePayload({ content: furwardV2Defaults, expectedRevision: 3 }), /旧版/);
  assert.equal(validateImageSrc('/reference/furward-v3/scene-path.png'), '/reference/furward-v3/scene-path.png');
  for (const src of ['/reference/furward-v3/../secret', '/reference/furward-v30/scene-path.png', '/reference/furward-v3//scene-path.png']) assert.throws(() => validateImageSrc(src));
  assert.throws(() => validateImageSrc('/reference/hero-diffuse.webp'));
  assert.throws(() => validateImageSrc('/reference-motion/helmet-lime.webp'));
  for (const scale of [0.49, 2.01, Infinity, '1', null]) {
    const value = structuredClone(defaultContent); value.sections[0].images[0].scale = scale;
    assert.throws(() => validateContent(value), /大小/);
  }
  const value = structuredClone(defaultContent); delete value.sections[0].images[0].scale;
  assert.equal(validateContent(value).sections[0].images[0].scale, 1);
});

test('SQLite migration archives exact legacy JSON and keeps media; stale saves cannot overwrite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'furward-db-'));
  const previous = process.env.DATA_DIR; process.env.DATA_DIR = dir;
  try {
    const db = openDatabase(); const raw = JSON.stringify(customLegacy());
    db.prepare('INSERT INTO site_content VALUES (?, ?, ?, ?)').run('site', raw, 2, '2026-01-01T00:00:00Z');
    db.prepare('INSERT INTO media VALUES (?, ?, ?, ?, ?)').run(upload.split('/').pop(), '我的上传.png', 'image/png', 100, '2026-01-01T00:00:00Z');
    assert.deepEqual((await nodeStore.getContent()).content, defaultContent);
    assert.equal(db.prepare('SELECT content FROM site_content WHERE key=?').get('site').content, raw);
    const result = await nodeStore.saveContent(defaultContent, 2);
    assert.equal(result.revision, 3);
    assert.equal(db.prepare('SELECT content FROM site_content WHERE key=?').get('furward-legacy-v1-revision-2').content, raw);
    assert.equal((await nodeStore.listMedia())[0].url, upload);
    await assert.rejects(nodeStore.saveContent(oldDefault, 3), /旧版/);
    await assert.rejects(nodeStore.saveContent(defaultContent, 2), nodeStore.CmsConflictError);
    const saved = structuredClone(defaultContent); saved.sections[0].images[0].src = upload;
    await nodeStore.saveContent(saved, 3);
    assert.equal((await nodeStore.getContent()).content.sections[0].images[0].src, upload);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM site_content').get().n, 2);
  } finally { closeDatabases(); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});

test('Worker D1 store also preserves the exact v1 source before a v3 save', async () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of (await readdir(new URL('drizzle/', root))).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL(`drizzle/${file}`, root), 'utf8'));
  const raw = JSON.stringify(customLegacy()); sqlite.prepare('INSERT INTO site_content VALUES (?, ?, ?, ?)').run('site', raw, 2, 'old');
  const DB = { prepare(sql) { let params = []; return { bind(...values) { params = values; return this; }, async first() { return sqlite.prepare(sql).get(...params) ?? null; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }; } }; } };
  globalThis[Symbol.for('furward.worker.test')] = { DB };
  let source = ts.transpileModule(await readFile(new URL('lib/cms-store.ts', root), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  source = source.replace('"cloudflare:workers"', JSON.stringify(dataURL('export const env=globalThis[Symbol.for("furward.worker.test")];')));
  const store = await import(dataURL(source));
  try {
    assert.deepEqual((await store.getContent()).content, defaultContent);
    await store.saveContent(defaultContent, 2);
    assert.equal(sqlite.prepare('SELECT content FROM site_content WHERE key=?').get('furward-legacy-v1-revision-2').content, raw);
    assert.equal((await store.getContent()).revision, 3);
    await assert.rejects(store.saveContent(oldDefault, 3), /旧版/);
    sqlite.exec("DELETE FROM site_content; CREATE TRIGGER reject_archive BEFORE INSERT ON site_content WHEN NEW.key != 'site' BEGIN SELECT RAISE(ABORT, 'backup failure'); END;");
    sqlite.prepare('INSERT INTO site_content VALUES (?, ?, ?, ?)').run('site', raw, 4, 'old');
    await assert.rejects(store.saveContent(defaultContent, 4), /backup failure/);
    assert.equal(sqlite.prepare('SELECT content FROM site_content WHERE key=?').get('site').content, raw);
  } finally { sqlite.close(); delete globalThis[Symbol.for('furward.worker.test')]; }
});

test('SQLite and D1 retain the exact v2 snapshot before saving upgraded edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'furward-v2-db-'));
  const previous = process.env.DATA_DIR; process.env.DATA_DIR = dir;
  try {
    for (const worker of [false, true]) {
      const sqlite = worker ? new DatabaseSync(':memory:') : openDatabase();
      if (worker) for (const file of (await readdir(new URL('drizzle/', root))).filter(file => file.endsWith('.sql')).sort()) sqlite.exec(await readFile(new URL(`drizzle/${file}`, root), 'utf8'));
      const raw = JSON.stringify(customV2(), null, 2);
      sqlite.prepare('INSERT INTO site_content VALUES (?, ?, ?, ?)').run('site', raw, 7, 'v2-time');
      let store = nodeStore;
      if (worker) {
        const DB = { prepare(sql) { let params = []; return { bind(...values) { params = values; return this; }, async first() { return sqlite.prepare(sql).get(...params) ?? null; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } }; } }; } };
        globalThis[Symbol.for('furward.worker.v2.test')] = { DB };
        let source = ts.transpileModule(await readFile(new URL('lib/cms-store.ts', root), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
        source = source.replace('"cloudflare:workers"', JSON.stringify(dataURL('export const env=globalThis[Symbol.for("furward.worker.v2.test")];')));
        store = await import(dataURL(source));
      }
      try {
        const read = await store.getContent();
        assert.deepEqual(read.content, upgradeContent(customV2())); assert.equal(read.revision, 7);
        assert.equal(sqlite.prepare('SELECT content FROM site_content WHERE key=?').get('site').content, raw);
        await assert.rejects(store.saveContent(customV2(), 7), /旧版/);
        assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM site_content').get().n, 1);
        const saved = await store.saveContent(read.content, 7);
        assert.equal(saved.revision, 8);
        assert.deepEqual(sqlite.prepare('SELECT content, revision, updated_at FROM site_content WHERE key=?').get('furward-legacy-v2-revision-7'), Object.assign(Object.create(null), { content: raw, revision: 7, updated_at: 'v2-time' }));
        await store.saveContent(saved.content, 8);
        assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM site_content').get().n, 2);
        await assert.rejects(store.saveContent(saved.content, 7), store.CmsConflictError);
        assert.equal(sqlite.prepare('SELECT content FROM site_content WHERE key=?').get('furward-legacy-v2-revision-7').content, raw);
      } finally { if (worker) sqlite.close(); }
    }
  } finally { closeDatabases(); delete globalThis[Symbol.for('furward.worker.v2.test')]; if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});

test('v2 CLI persists its source snapshot, upgrades only defaults and leaves uploads untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'furward-v2-cli-'));
  const previous = process.env.DATA_DIR;
  try {
    for (const custom of [false, true]) {
      process.env.DATA_DIR = join(dir, custom ? 'custom-data' : 'default-data');
      const source = custom ? customV2() : furwardV2Defaults;
      const raw = JSON.stringify(source, null, 2);
      const db = openDatabase();
      db.prepare('INSERT INTO site_content VALUES (?, ?, ?, ?)').run('site', raw, 8, 'v2-original'); closeDatabases();
      const uploadName = upload.split('/').pop();
      const uploadPath = join(process.env.DATA_DIR, 'uploads', uploadName);
      await writeFile(uploadPath, 'untouched-upload-bytes');
      const run = (name, flags = []) => spawnSync(process.execPath, [fileURLToPath(new URL('scripts/furward-migrate.mjs', root)), '--data-dir', process.env.DATA_DIR, '--output', join(dir, `${custom}-${name}`), ...flags], { encoding: 'utf8' });
      const flags = ['--apply', ...(custom ? ['--reviewed'] : [])];
      const result = run('applied', flags); assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(join(dir, `${custom}-applied/source-original.json`), 'utf8'), raw);
      const report = JSON.parse(await readFile(join(dir, `${custom}-applied/migration-review.json`), 'utf8'));
      assert.equal(report.fromVersion, 2); assert.equal(report.toVersion, 3);
      assert.equal(report.customChanges.length > 0, custom);
      const check = openDatabase();
      assert.equal(check.prepare('SELECT content FROM site_content WHERE key=?').get('furward-legacy-v2-revision-8').content, raw);
      assert.deepEqual(JSON.parse(check.prepare('SELECT content FROM site_content WHERE key=?').get('site').content), upgradeContent(source)); closeDatabases();
      assert.equal(await readFile(uploadPath, 'utf8'), 'untouched-upload-bytes');
      const again = run('again', ['--apply']); assert.equal(again.status, 0, again.stderr);
      assert.equal(openDatabase().prepare('SELECT revision FROM site_content WHERE key=?').get('site').revision, 9); closeDatabases();
    }
  } finally { closeDatabases(); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});

test('migration CLI defaults to review only, refuses unreviewed edits and applies idempotently', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'furward-cli-'));
  const previous = process.env.DATA_DIR; process.env.DATA_DIR = join(dir, 'data');
  try {
    const db = openDatabase(); db.prepare('INSERT INTO site_content VALUES (?, ?, ?, ?)').run('site', JSON.stringify(customLegacy()), 2, 'old'); closeDatabases();
    const run = (output, flags = []) => spawnSync(process.execPath, [fileURLToPath(new URL('scripts/furward-migrate.mjs', root)), '--data-dir', process.env.DATA_DIR, '--output', join(dir, output), ...flags], { encoding: 'utf8' });
    const review = run('review'); assert.equal(review.status, 0, review.stderr);
    assert.equal(openDatabase().prepare('SELECT revision FROM site_content WHERE key=?').get('site').revision, 2); closeDatabases();
    const report = JSON.parse(await readFile(join(dir, 'review/migration-review.json'), 'utf8')); assert.deepEqual(report.preservedUploads, [upload]);
    assert.notEqual(run('blocked', ['--apply']).status, 0);
    const applied = run('applied', ['--apply', '--reviewed']); assert.equal(applied.status, 0, applied.stderr);
    assert.equal(openDatabase().prepare('SELECT revision FROM site_content WHERE key=?').get('site').revision, 3); closeDatabases();
    assert.equal(run('again', ['--apply']).status, 0);
    assert.equal(openDatabase().prepare('SELECT revision FROM site_content WHERE key=?').get('site').revision, 3);
  } finally { closeDatabases(); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; await rm(dir, { recursive: true, force: true }); }
});

test('production migration CLI runs in an isolated standalone copy without node_modules', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'furward-standalone-'));
  try {
    await mkdir(join(dir, 'scripts')); await mkdir(join(dir, 'lib'));
    const files = ['scripts/furward-migrate.mjs', 'scripts/selfhost-loader.mjs', 'lib/furward-migration.ts', 'lib/furward-v2-defaults.ts', 'lib/legacy-content.ts', 'lib/editorial-defaults.ts', 'lib/content.ts', 'lib/cms-validation.ts', 'lib/cms-store-node.ts', 'lib/selfhost-database.mjs'];
    for (const file of files) await copyFile(new URL(file, root), join(dir, file));
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    await writeFile(join(dir, 'snapshot.json'), JSON.stringify({ content: oldDefault, revision: 2 }));
    const result = spawnSync(process.execPath, [join(dir, 'scripts/furward-migrate.mjs'), '--input', join(dir, 'snapshot.json'), '--output', join(dir, 'review')], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(join(dir, 'review/furward-content.json'), 'utf8')).content.schemaVersion, 3);
    const dataDir = join(dir, 'data'); await mkdir(dataDir);
    const db = new DatabaseSync(join(dataDir, 'content.sqlite'));
    db.exec('CREATE TABLE site_content (key TEXT PRIMARY KEY, content TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);');
    db.prepare('INSERT INTO site_content VALUES (?, ?, ?, ?)').run('site', JSON.stringify(oldDefault), 2, 'old'); db.close();
    const applied = spawnSync(process.execPath, [join(dir, 'scripts/furward-migrate.mjs'), '--data-dir', dataDir, '--output', join(dir, 'applied'), '--apply'], { cwd: dir, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    const check = new DatabaseSync(join(dataDir, 'content.sqlite'), { readOnly: true });
    assert.equal(check.prepare('SELECT revision FROM site_content WHERE key=?').get('site').revision, 3);
    assert.ok(check.prepare('SELECT content FROM site_content WHERE key=?').get('furward-legacy-v1-revision-2'));
    check.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
