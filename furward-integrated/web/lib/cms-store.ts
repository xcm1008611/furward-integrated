import { env } from "cloudflare:workers";
import { defaultContent, FURWARD_SCHEMA_VERSION, upgradeContent } from "@/lib/content";
import type { SiteContent } from "@/lib/content";
import { MEDIA_ID_PATTERN, CmsValidationError, validateContent } from "@/lib/cms-validation";

export type ContentSnapshot = { content: SiteContent; revision: number; updatedAt: string | null };
export type MediaItem = { id: string; url: string; name: string; type: string; size: number; createdAt: string };

export class CmsConflictError extends Error {
  constructor() { super("网站已在其他窗口更新。请先刷新后台，再重新修改保存，避免覆盖新内容。"); this.name = "CmsConflictError"; }
}

function database(): D1Database {
  if (!env.DB) throw new Error("CMS database binding is unavailable.");
  return env.DB;
}

function bucket(): R2Bucket {
  if (!env.BUCKET) throw new Error("CMS media bucket binding is unavailable.");
  return env.BUCKET;
}

export async function getContent(): Promise<ContentSnapshot> {
  const row = await database().prepare('SELECT content, revision, updated_at FROM site_content WHERE "key" = ?').bind("site").first<{ content: string; revision: number; updated_at: string }>();
  if (!row) return { content: structuredClone(defaultContent), revision: 0, updatedAt: null };
  return { content: validateContent(upgradeContent(JSON.parse(row.content))), revision: row.revision, updatedAt: row.updated_at };
}

export async function saveContent(content: SiteContent, expectedRevision: number): Promise<ContentSnapshot> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CmsValidationError("页面版本不正确，请刷新后台后重试。");
  const valid = validateContent(content);
  const db = database();
  const updatedAt = new Date().toISOString();
  const serialized = JSON.stringify(valid);
  // Archive the exact legacy revision before replacing it. Both statements are
  // revision-conditional: a concurrent edit can only cause a conflict, never
  // replace the source without its backup. Private archive keys are not public.
  if (expectedRevision > 0) await db.prepare('INSERT INTO site_content ("key", content, revision, updated_at) SELECT \'furward-legacy-v\' || COALESCE(json_extract(content, \'$.schemaVersion\'), 1) || \'-revision-\' || revision, content, revision, updated_at FROM site_content WHERE "key" = ? AND revision = ? AND COALESCE(json_extract(content, \'$.schemaVersion\'), 1) < ? ON CONFLICT("key") DO NOTHING').bind("site", expectedRevision, FURWARD_SCHEMA_VERSION).run();
  // The comparison and write happen in one SQL statement. Two browser tabs can
  // never silently overwrite each other's changes, including the initial save.
  const result = expectedRevision === 0
    ? await db.prepare('INSERT INTO site_content ("key", content, revision, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT("key") DO NOTHING').bind("site", serialized, updatedAt).run()
    : await db.prepare('UPDATE site_content SET content = ?, revision = revision + 1, updated_at = ? WHERE "key" = ? AND revision = ?').bind(serialized, updatedAt, "site", expectedRevision).run();
  if (result.meta.changes !== 1) throw new CmsConflictError();
  return { content: valid, revision: expectedRevision + 1, updatedAt };
}

export async function listMedia(): Promise<MediaItem[]> {
  const result = await database().prepare("SELECT id, name, type, size, created_at AS createdAt FROM media ORDER BY created_at DESC, id DESC").all<Omit<MediaItem, "url">>();
  return result.results.map((item) => ({ ...item, url: `/api/media/${item.id}` }));
}

export async function saveMedia(bytes: Uint8Array, name: string, type: string, extension: string): Promise<MediaItem> {
  const id = `${crypto.randomUUID()}.${extension}`;
  if (!MEDIA_ID_PATTERN.test(id)) throw new Error("Invalid media identifier.");
  const createdAt = new Date().toISOString();
  const storage = bucket();
  const db = database();
  await storage.put(id, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
  try {
    await db.prepare("INSERT INTO media (id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, type, bytes.byteLength, createdAt).run();
  } catch (error) {
    // A metadata failure should not leave an unreachable uploaded file behind.
    await storage.delete(id).catch(() => undefined);
    throw error;
  }
  return { id, url: `/api/media/${id}`, name, type, size: bytes.byteLength, createdAt };
}

export async function getMedia(id: string): Promise<R2ObjectBody | null> {
  if (!MEDIA_ID_PATTERN.test(id)) return null;
  return bucket().get(id);
}

/** Atomically reserves one login attempt; at most five proceed per 15 minutes. */
export async function checkLoginRateLimit(key: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const now = Date.now();
  const row = await database().prepare(`INSERT INTO admin_login_limits (key, attempts, failures, reset_at) VALUES (?, 1, 0, ?)
    ON CONFLICT(key) DO UPDATE SET
      attempts = CASE WHEN reset_at <= ? THEN 1 ELSE MIN(attempts + 1, 6) END,
      failures = CASE WHEN reset_at <= ? THEN 0 ELSE failures END,
      reset_at = CASE WHEN reset_at <= ? THEN excluded.reset_at ELSE reset_at END
    RETURNING attempts, reset_at`).bind(key, now + 15 * 60 * 1000, now, now, now).first<{ attempts: number; reset_at: number }>();
  if (!row) throw new Error("Login limiter unavailable");
  return { allowed: row.attempts <= 5, retryAfter: Math.max(1, Math.ceil((row.reset_at - now) / 1000)) };
}

export async function recordLoginFailure(key: string): Promise<void> {
  await database().prepare("UPDATE admin_login_limits SET failures = MIN(failures + 1, 5) WHERE key = ?").bind(key).run();
}

export async function clearLoginFailures(key: string): Promise<void> {
  await database().prepare("DELETE FROM admin_login_limits WHERE key = ?").bind(key).run();
}
