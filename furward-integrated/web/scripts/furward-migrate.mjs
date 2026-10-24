#!/usr/bin/env node
/** Review first; --apply is an explicit local SQLite mutation. Never reads auth env. */
import './selfhost-loader.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const { createMigrationPlan } = await import('../lib/furward-migration.ts');
const { validateContent } = await import('../lib/cms-validation.ts');

async function main() {
  const args = process.argv.slice(2);
  const options = { apply: false, reviewed: false, input: '', data: '', output: '' };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--reviewed') options.reviewed = true;
    else if (['--input', '--data-dir', '--output'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg === '--data-dir' ? 'data' : arg.slice(2)] = resolve(args[++i]);
    else throw new Error('用法：node scripts/furward-migrate.mjs (--input content.json | --data-dir 数据目录) --output 新备份目录 [--apply --reviewed]');
  }
  if (!!options.input === !!options.data || !options.output) throw new Error('请指定一个内容快照或数据目录，并指定一个新的输出目录。');
  if (options.apply && !options.data) throw new Error('--apply 仅用于本地 SQLite 数据目录；线上 D1 通过新版后台保存并自动备份。');
  let raw;
  let snapshot;
  if (options.input) {
    raw = await readFile(options.input, 'utf8');
    const parsed = JSON.parse(raw);
    snapshot = parsed.content ? parsed : { content: parsed, revision: null, updatedAt: null };
  } else {
    const db = new DatabaseSync(join(options.data, 'content.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT content, revision, updated_at AS updatedAt FROM site_content WHERE "key" = ?').get('site');
      if (!row) throw new Error('当前还没有保存过内容；新版程序会直接使用绒途默认内容，无需迁移。');
      raw = row.content;
      snapshot = { content: JSON.parse(raw), revision: row.revision, updatedAt: row.updatedAt };
    } finally { db.close(); }
  }
  const plan = createMigrationPlan(snapshot.content);
  const valid = validateContent(plan.content);
  await mkdir(options.output, { mode: 0o700 });
  const write = (name, value) => writeFile(join(options.output, name), value, { flag: 'wx', mode: 0o600 });
  await write('source-original.json', raw);
  await write('source-snapshot.json', JSON.stringify(snapshot, null, 2));
  await write('furward-content.json', JSON.stringify({ ...snapshot, content: valid }, null, 2));
  const { content: _content, ...report } = plan;
  await write('migration-review.json', JSON.stringify({ ...report, note: plan.fromVersion === 2 ? '仅替换与 v2 默认值一致的字段；自定义文案、上传图片和位置大小保留。完整 v2 原文同时备份，素材库不删除。' : '所有旧内容保留在原始备份，上传素材库不删除。v1 自定义内容需要人工选择合适的新用途，不会自动放入不同含义的图片槽。' }, null, 2));
  console.log(`检查完成：${plan.customChanges.length} 处自定义差异，${plan.preservedUploads.length} 张上传图片引用。完整原始内容及差异清单：${options.output}`);
  if (!options.apply) { console.log('当前仅生成审核与备份文件，数据库没有修改。'); return; }
  if (!plan.needsMigration) { console.log(`已经是绒途 v${plan.toVersion}，无需重复迁移。`); return; }
  if (plan.customChanges.length && !options.reviewed) throw new Error('检测到自定义内容，数据库尚未修改。请先检查 migration-review.json，再使用新的输出目录加 --apply --reviewed 执行。');
  process.env.DATA_DIR = options.data;
  const { saveContent } = await import('../lib/cms-store-node.ts');
  const { closeDatabases } = await import('../lib/selfhost-database.mjs');
  try {
    const saved = await saveContent(valid, snapshot.revision);
    console.log(`迁移已保存，内容版本 ${saved.revision}。旧 JSON 同时保留在数据库的私有备份记录中。`);
  } finally { closeDatabases(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
