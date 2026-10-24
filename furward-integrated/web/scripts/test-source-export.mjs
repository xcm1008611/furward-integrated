/** Source delivery boundaries: isolated fixtures, no project data is modified. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const exporter = new URL('./export-source.mjs', import.meta.url);
const required = ['package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json', 'postcss.config.mjs', '.dockerignore', '.env.example', 'Dockerfile', 'compose.yml', 'README.md', '使用说明.md', '自己服务器部署.md', 'eslint.config.mjs', 'components.json', 'drizzle.config.ts', 'cloudflare-env.d.ts', '.gitignore', '启动网站.command', 'reference-assets.json', 'reference-notes.md', 'motion-reference.md', 'scripts/run-selfhost.mjs', 'scripts/build-selfhost.mjs', 'scripts/setup-admin.mjs', 'scripts/selfhost-env.mjs', 'scripts/selfhost-loader.mjs', 'scripts/selfhost-backup.mjs', 'scripts/selfhost-restore.mjs', 'lib/cms-store-node.ts', 'lib/selfhost-database.mjs', 'lib/admin-auth.ts', 'lib/admin-config-node.ts'];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lando-source-test-'));
  for (const file of required) { await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), ''); }
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'old', build: 'old', start: 'old', 'dev:selfhost': 'node dev.mjs', 'build:selfhost': 'node build.mjs', 'start:selfhost': 'node start.mjs' } }));
  await writeFile(join(root, '.env.example'), "ADMIN_PASSWORD_HASH=''\nADMIN_SESSION_SECRET=''\nDATA_DIR=./data\n");
  await cp(exporter, join(root, 'scripts/export-source.mjs'));
  return root;
}
const run = root => spawnSync(process.execPath, ['scripts/export-source.mjs'], { cwd: root, encoding: 'utf8', env: { ...process.env, DATA_DIR: '' } });
// Read stored local ZIP entries directly; the exported archive uses method 0.
function entries(bytes) {
  const files = new Map(); let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 8), 0);
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, bytes.subarray(start, start + size)); offset = start + size;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
  return files;
}
test('export keeps required source and changes ZIP defaults without including identity, credentials, custom data or symlinks', async () => {
  const root = await fixture();
  try {
    for (const path of ['.openai/hosting.json', 'public/custom-runtime/private.json', '.admin-credentials', '.env.production', 'outputs/migration/content.json', 'public/visible.svg']) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), path === '.env.production' ? 'DATA_DIR="./public/custom-runtime" # private runtime\nADMIN_SESSION_SECRET=fixture-only\n' : 'fixture-only');
    }
    await symlink(join(root, '.admin-credentials'), join(root, 'public/linked.txt'));
    await writeFile(join(root, 'scripts/test-cms.mjs'), "const rejectedFixture='https://name:password@example.com';\n");
    const result = run(root); assert.equal(result.status, 0, result.stderr);
    const path = result.stdout.match(/源码 ZIP：([^\n]+)/)?.[1]; assert.ok(path);
    const files = entries(await readFile(path));
    assert.ok(files.has('lando-studio/public/visible.svg'));
    for (const name of files.keys()) assert.doesNotMatch(name, /(?:\.openai|\.admin-credentials|custom-runtime|linked\.txt|\/outputs\/|\.env\.production)/);
    assert.ok(files.has('lando-studio/.env.example'));
    const packed = JSON.parse(files.get('lando-studio/package.json').toString());
    for (const command of ['dev', 'build', 'start']) assert.equal(packed.scripts[command], packed.scripts[`${command}:selfhost`]);
    assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts.dev, 'old');
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('export refuses a missing required deployment file', async () => {
  const root = await fixture();
  try { await rm(join(root, 'Dockerfile')); const result = run(root); assert.notEqual(result.status, 0); assert.match(result.stderr, /Required source file is missing: Dockerfile/); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('export refuses a populated example secret', async () => {
  const root = await fixture();
  try { await writeFile(join(root, '.env.example'), "ADMIN_SESSION_SECRET='fixture-value'\n"); const result = run(root); assert.notEqual(result.status, 0); assert.match(result.stderr, /must not contain a real password/); }
  finally { await rm(root, { recursive: true, force: true }); }
});
test('credential URL exemption is limited to example.com test fixtures', async () => {
  const root = await fixture();
  try { await writeFile(join(root, 'scripts/test-cms.mjs'), ['https:/', '/name:password@other.invalid'].join('')); const result = run(root); assert.notEqual(result.status, 0); assert.match(result.stderr, /Credential-bearing URL detected/); }
  finally { await rm(root, { recursive: true, force: true }); }
});
