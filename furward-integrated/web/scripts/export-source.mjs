#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve, extname, basename, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// Deliberately use an allow-list. This archive is source, never a server backup.
const root = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const sourceDirectories = ['app', 'components', 'db', 'drizzle', 'hooks', 'lib', 'public', 'scripts', 'vendor'];
const rootFiles = [
  'package.json', 'package-lock.json', 'next.config.ts', 'tsconfig.json',
  'postcss.config.mjs', 'eslint.config.mjs', 'components.json', 'drizzle.config.ts',
  'cloudflare-env.d.ts', '.gitignore', '.dockerignore', '.env.example',
  'Dockerfile', 'compose.yml', 'compose.yaml', 'docker-compose.yml',
  'README.md', '使用说明.md', '自己服务器部署.md', '启动网站.command',
  'reference-assets.json', 'reference-notes.md', 'motion-reference.md',
];
const composeNames = ['compose.yml', 'compose.yaml', 'docker-compose.yml'];
const requiredFiles = [...rootFiles.filter(file => !composeNames.includes(file)), 'scripts/run-selfhost.mjs', 'scripts/build-selfhost.mjs', 'scripts/setup-admin.mjs', 'scripts/selfhost-env.mjs', 'scripts/selfhost-loader.mjs', 'scripts/selfhost-backup.mjs', 'scripts/selfhost-restore.mjs', 'lib/cms-store-node.ts', 'lib/selfhost-database.mjs', 'lib/admin-auth.ts', 'lib/admin-config-node.ts'];
const deniedDirectories = new Set(['.git', '.openai', '.agents', '.codex', '.wrangler', '.sites-runtime', '.taste-skill', '.next', '.vinext', 'node_modules', 'dist', 'outputs', 'data', 'uploads', 'backups', 'coverage', 'test-results', 'playwright-report', '__pycache__']);
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.css', '.scss', '.json', '.sql', '.md', '.txt', '.sh', '.command']);
const publicExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.glb', '.gltf', '.bin', '.hdr', '.riv', '.wasm', '.mp4', '.webm', '.json', '.txt', '.md', '.js']);
const privateExtensions = /\.(?:pem|key|p12|pfx|sqlite(?:3)?(?:-wal|-shm)?|db(?:-wal|-shm)?|log|zip|tar|gz|bak|tsbuildinfo)$/i;
const privateName = /(?:^|[._-])(?:credentials?|secrets?|session|token)(?:[._-]|$)/i;
const runtimeDirectories = new Set([resolve(root, 'data')]);
let skipped = 0;

// DATA_DIR may have been placed inside an otherwise allowed directory. Read
// only its assignment, never print or archive environment-file contents.
if (process.env.DATA_DIR) runtimeDirectories.add(resolve(root, process.env.DATA_DIR));
for (const name of await readdir(root)) {
  if (!/^\.env(?:\.|$)/.test(name) || name === '.env.example') continue;
  const stat = await lstat(resolve(root, name));
  if (!stat.isFile() || stat.isSymbolicLink()) continue;
  const content = await readFile(resolve(root, name), 'utf8');
  const value = parseEnv(content).DATA_DIR;
  if (value) runtimeDirectories.add(resolve(root, value));
}
const inside = (path, parent) => path === parent || path.startsWith(parent + sep);
const privatePath = path => [...runtimeDirectories].some(parent => inside(resolve(root, path), parent));
const entries = [];

async function addFile(path, explicit = false) {
  const absolute = resolve(root, path);
  if (privatePath(path)) { skipped++; return; }
  let stat;
  try { stat = await lstat(absolute); } catch (error) { if (error.code === 'ENOENT' && explicit) return; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) { skipped++; return; }
  if (!inside(await realpath(absolute), root)) throw new Error(`Refusing a file outside the project: ${path}`);
  const name = basename(path);
  if (privateExtensions.test(name) || (name.startsWith('.') && !explicit) || /^\.env/.test(name) && path !== '.env.example') { skipped++; return; }
  // Known source modules legitimately contain words such as session/token;
  // private-name detection applies to non-code artefacts only.
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(name) && privateName.test(name)) { skipped++; return; }
  let bytes = await readFile(absolute);
  if (path === 'package.json') {
    const pkg = JSON.parse(bytes.toString('utf8'));
    for (const command of ['dev', 'build', 'start']) {
      if (!pkg.scripts?.[`${command}:selfhost`]) throw new Error(`Missing ${command}:selfhost; finish the self-host runtime before exporting.`);
      pkg.scripts[command] = pkg.scripts[`${command}:selfhost`];
    }
    bytes = Buffer.from(JSON.stringify(pkg, null, 2) + '\n');
  }
  if (path === '.env.example') {
    for (const [key, value] of Object.entries(parseEnv(bytes.toString('utf8')))) {
      if (/(?:PASSWORD|SECRET|TOKEN|(?:^|_)KEY)(?:_|$)/i.test(key) && value) {
        throw new Error('.env.example must not contain a real password, hash, session secret or API key. Leave sensitive values empty.');
      }
    }
  }
  if (sourceExtensions.has(extname(path)) || explicit) {
    const text = bytes.toString('utf8');
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw new Error(`Private key detected; refusing export: ${path}`);
    for (const match of text.matchAll(/https?:\/\/[^\s/"'`]+:[^\s/@"'`]+@[^\s"'`<>]+/g)) {
      let fixture = false;
      try { fixture = /^scripts\/test[^/]*\.(?:mjs|js|ts)$/.test(path) && new URL(match[0]).hostname === 'example.com'; } catch { /* Invalid embedded URLs are not exempted. */ }
      if (!fixture) throw new Error(`Credential-bearing URL detected; refusing export: ${path}`);
    }
  }
  if (bytes.length > 0xffffffff) throw new Error(`File exceeds this ZIP writer's size limit: ${path}`);
  entries.push({ name: `lando-studio/${path.split(sep).join('/')}`, bytes, mode: stat.mode, date: stat.mtime });
}

async function walk(directory) {
  const absolute = resolve(root, directory);
  let names;
  try { names = await readdir(absolute, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  names.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const item of names) {
    const path = `${directory}/${item.name}`;
    if (item.isSymbolicLink() || item.name.startsWith('.') || deniedDirectories.has(item.name) || privatePath(path)) { skipped++; continue; }
    if (item.isDirectory()) await walk(path);
    else if (item.isFile()) {
      const allowed = directory === 'public' || directory.startsWith('public/') ? publicExtensions : sourceExtensions;
      if (allowed.has(extname(item.name).toLowerCase()) || /(?:^|\.)LICENSE(?:\.md)?$/i.test(item.name)) await addFile(path);
      else skipped++;
    }
  }
}
for (const file of requiredFiles) {
  let stat;
  try { stat = await lstat(resolve(root, file)); } catch { throw new Error(`Required source file is missing: ${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Required source file is not a regular file: ${file}`);
}
if (!(await readdir(root)).some(name => composeNames.includes(name))) throw new Error('Required Docker Compose configuration is missing.');
for (const file of rootFiles) await addFile(file, true);
for (const directory of sourceDirectories) await walk(directory);
entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
for (const file of requiredFiles) if (!entries.some(entry => entry.name === `lando-studio/${file}`)) throw new Error(`Required file was excluded by the safety rules: ${file}`);
if (!entries.some(entry => composeNames.some(name => entry.name === `lando-studio/${name}`))) throw new Error('Required Docker Compose configuration was excluded by the safety rules.');
if (entries.length > 65535) throw new Error('ZIP64 is not supported by this small source exporter.');

// Standard, UTF-8 ZIP with stored entries. No shell, third-party zipper or
// dependency install is required, and no temporary copy contains credentials.
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; crcTable[i] = c >>> 0; }
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
function dosDate(date) { const year = Math.max(1980, Math.min(2107, date.getUTCFullYear())); return { time: date.getUTCHours() << 11 | date.getUTCMinutes() << 5 | date.getUTCSeconds() >>> 1, day: (year - 1980) << 9 | (date.getUTCMonth() + 1) << 5 | date.getUTCDate() }; }
const localParts = [], centralParts = [];
let offset = 0;
for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8'), crc = crc32(entry.bytes), stamp = dosDate(entry.date);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.day, 12); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(entry.bytes.length, 18); local.writeUInt32LE(entry.bytes.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.day, 14); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(entry.bytes.length, 20); central.writeUInt32LE(entry.bytes.length, 24); central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((entry.mode & 0xffff) * 65536 >>> 0, 38); central.writeUInt32LE(offset, 42);
  localParts.push(local, name, entry.bytes); centralParts.push(central, name);
  offset += local.length + name.length + entry.bytes.length;
  if (offset > 0xffffffff) throw new Error('Archive exceeds the ZIP size limit.');
}
const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0), end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
const outputDirectory = resolve(root, 'outputs');
await mkdir(outputDirectory, { recursive: true });
const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');
const output = resolve(outputDirectory, `lando-studio-source-${timestamp}.zip`);
await writeFile(output, Buffer.concat([...localParts, ...centralParts, end]), { flag: 'wx', mode: 0o600 });
console.log(`源码 ZIP：${output}\n文件数：${entries.length}；体积：${((offset + centralSize + end.length) / 1024 / 1024).toFixed(2)} MiB\n顶层目录：lando-studio\n已排除账号身份、环境密码、运行数据、依赖、构建产物和测试截图。\n归档内 npm run dev / build / start 默认使用独立 Node 运行时；原项目 package.json 未修改。\n按白名单另跳过 ${skipped} 项。`);
