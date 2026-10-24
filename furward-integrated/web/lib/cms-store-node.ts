import { randomUUID, createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { defaultContent, FURWARD_SCHEMA_VERSION, upgradeContent } from "@/lib/content";
import type { SiteContent } from "@/lib/content";
import { MEDIA_ID_PATTERN, CmsValidationError, detectImage, safeDisplayName, validateContent } from "@/lib/cms-validation";
import { dataPaths, openDatabase } from "./selfhost-database.mjs";

export type ContentSnapshot = { content: SiteContent; revision: number; updatedAt: string | null };
export type MediaItem = { id: string; url: string; name: string; type: string; size: number; createdAt: string };
export type NodeMediaBody = { body: Uint8Array<ArrayBuffer>; size: number; httpEtag: string };

export class CmsConflictError extends Error {
  constructor() { super("网站已在其他窗口更新。请先刷新后台，再重新修改保存，避免覆盖新内容。"); this.name = "CmsConflictError"; }
}

export async function getContent(): Promise<ContentSnapshot> {
  const row = openDatabase().prepare('SELECT content, revision, updated_at FROM site_content WHERE "key" = ?').get("site") as { content: string; revision: number; updated_at: string } | undefined;
  if (!row) return { content: structuredClone(defaultContent), revision: 0, updatedAt: null };
  return { content: validateContent(upgradeContent(JSON.parse(row.content))), revision: row.revision, updatedAt: row.updated_at };
}

export async function saveContent(content: SiteContent, expectedRevision: number): Promise<ContentSnapshot> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CmsValidationError("页面版本不正确，请刷新后台后重试。");
  const valid = validateContent(content);
  const db = openDatabase();
  const updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(valid);
  // The exact old JSON and all its upload references are preserved under a
  // private key before the first Furward save. A stale writer cannot replace it.
  if (expectedRevision > 0) db.prepare('INSERT INTO site_content ("key", content, revision, updated_at) SELECT \'furward-legacy-v\' || COALESCE(json_extract(content, \'$.schemaVersion\'), 1) || \'-revision-\' || revision, content, revision, updated_at FROM site_content WHERE "key" = ? AND revision = ? AND COALESCE(json_extract(content, \'$.schemaVersion\'), 1) < ? ON CONFLICT("key") DO NOTHING').run("site", expectedRevision, FURWARD_SCHEMA_VERSION);
  // This compare-and-swap is a single SQLite statement, including the first save.
  const result = expectedRevision === 0
    ? db.prepare('INSERT INTO site_content ("key", content, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT("key") DO NOTHING').run("site", serialized, updatedAt)
    : db.prepare('UPDATE site_content SET content = ?, revision = revision + 1, updated_at = ? WHERE "key" = ? AND revision = ?').run(serialized, updatedAt, "site", expectedRevision);
  if (Number(result.changes) !== 1) throw new CmsConflictError();
  return { content: valid, revision: expectedRevision + 1, updatedAt };
}

export async function listMedia(): Promise<MediaItem[]> {
  const rows = openDatabase().prepare('SELECT id, name, type, size, created_at AS createdAt FROM media ORDER BY created_at DESC, id DESC').all() as Omit<MediaItem, "url">[];
  return rows.map(item => ({ ...item, url: `/api/media/${item.id}` }));
}

export async function saveMedia(bytes: Uint8Array, name: string, type: string, extension: string): Promise<MediaItem> {
  const detected = detectImage(bytes, type);
  if (extension !== detected.extension) throw new CmsValidationError("图片扩展名和实际格式不一致。");
  const id = `${randomUUID()}.${detected.extension}`;
  const createdAt = new Date().toISOString();
  const safeName = safeDisplayName(name);
  const db = openDatabase();
  const path = join(dataPaths().uploads, id);
  // The file is not readable through the API until its metadata insert succeeds.
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    db.prepare('INSERT INTO media (id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?)').run(id, safeName, detected.type, bytes.byteLength, createdAt);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  return { id, url: `/api/media/${id}`, name: safeName, type: detected.type, size: bytes.byteLength, createdAt };
}

export async function getMedia(id: string): Promise<NodeMediaBody | null> {
  if (!MEDIA_ID_PATTERN.test(id)) return null;
  const metadata = openDatabase().prepare('SELECT size, type FROM media WHERE id = ?').get(id) as { size: number; type: string } | undefined;
  if (!metadata) return null;
  let file;
  try { file = await open(join(dataPaths().uploads, id), constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size !== metadata.size) throw new Error("Uploaded file is incomplete.");
    const bytes = await file.readFile();
    const detected = detectImage(bytes, metadata.type);
    if (!id.endsWith(`.${detected.extension}`)) throw new Error("Uploaded file type is inconsistent.");
    return { body: new Uint8Array(bytes), size: bytes.byteLength, httpEtag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
  } finally { await file.close(); }
}

const LOGIN_WINDOW = 15 * 60 * 1000;
function validKey(key: string) {
  if (!key || key.length > 256) throw new Error("Invalid login rate-limit key.");
  return key;
}

export async function checkLoginRateLimit(key: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const now = Date.now();
  const row = openDatabase().prepare(`INSERT INTO admin_login_limits (key, attempts, failures, reset_at) VALUES (?, 1, 0, ?)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN reset_at <= ? THEN 1 ELSE MIN(attempts + 1, 6) END,
      failures = CASE WHEN reset_at <= ? THEN 0 ELSE failures END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    RETURNING attempts, reset_at`).get(validKey(key), now + LOGIN_WINDOW, now, now, now) as { attempts: number; reset_at: number };
  if (!row) throw new Error("Login limiter unavailable");
  return { allowed: row.attempts <= 5, retryAfter: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) };
}

export async function recordLoginFailure(key: string): Promise<void> {
  openDatabase().prepare("UPDATE admin_login_limits SET failures = MIN(failures + 1, 5) WHERE key = ?").run(validKey(key));
}

export async function clearLoginFailures(key: string): Promise<void> {
  openDatabase().prepare("DELETE FROM admin_login_limits WHERE key = ?").run(validKey(key));
}
