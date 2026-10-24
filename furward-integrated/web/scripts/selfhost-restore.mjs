import "./selfhost-env.mjs";
import "./selfhost-loader.mjs";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir, lstat, copyFile, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { dataPaths, openDatabase, closeDatabases } from "../lib/selfhost-database.mjs";
import { createBackup } from "./selfhost-backup.mjs";

const { validateContent, detectImage, MEDIA_ID_PATTERN, safeDisplayName } = await import("../lib/cms-validation.ts");
const { upgradeContent } = await import("../lib/content.ts");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export async function restoreData(source, { fromContent = false, replace = false } = {}) {
  const input = resolve(source);
  const paths = dataPaths();
  if (input === paths.directory) throw new Error("不能从当前数据目录恢复到自身。");
  let contentRow;
  let media;
  let limits = [];
  if (fromContent) {
    const snapshot = JSON.parse(await readFile(join(input, "content.json"), "utf8"));
    if (!snapshot || typeof snapshot !== "object" || !snapshot.content) throw new Error("content.json 需要包含 content、revision、updatedAt 的网站快照。");
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw new Error("快照revision必须是非负整数。");
    contentRow = { content: JSON.stringify(validateContent(upgradeContent(snapshot.content))), revision: Math.max(1, snapshot.revision), updated_at: snapshot.updatedAt || new Date().toISOString() };
    media = (await readdir(join(input, "uploads"))).filter(id => !id.startsWith(".")).map(id => ({ id, name: id, type: "", created_at: contentRow.updated_at }));
  } else {
    const metadata = JSON.parse(await readFile(join(input, "backup.json"), "utf8"));
    if (metadata.format !== "lando-selfhost-backup-v1") throw new Error("不是受支持的自托管备份目录。");
    const snapshot = new DatabaseSync(join(input, "content.sqlite"), { readOnly: true });
    try {
      contentRow = snapshot.prepare('SELECT content, revision, updated_at FROM site_content WHERE "key" = ?').get("site");
      media = snapshot.prepare("SELECT id, name, type, size, created_at FROM media").all();
      limits = snapshot.prepare("SELECT key, attempts, failures, reset_at FROM admin_login_limits").all();
      for (const item of media) item.expectedHash = metadata.media.find(file => file.id === item.id)?.sha256;
    } finally { snapshot.close(); }
  }
  if (contentRow) {
    contentRow.content = JSON.stringify(validateContent(upgradeContent(JSON.parse(contentRow.content))));
    if (!Number.isSafeInteger(contentRow.revision) || contentRow.revision < 1) throw new Error("备份内容版本无效。");
  }
  // Validate every file and reference BEFORE modifying the destination.
  for (const item of media) {
    if (!MEDIA_ID_PATTERN.test(item.id)) throw new Error(`无效图片文件名：${item.id}`);
    const file = join(input, "uploads", item.id);
    if (!(await lstat(file)).isFile()) throw new Error(`不接受目录或符号链接：${item.id}`);
    const bytes = await readFile(file);
    const image = detectImage(bytes, item.type);
    if (!item.id.endsWith(`.${image.extension}`)) throw new Error(`图片扩展名不匹配：${item.id}`);
    if (item.size !== undefined && item.size !== bytes.length) throw new Error(`图片长度不匹配：${item.id}`);
    if (item.expectedHash && hash(bytes) !== item.expectedHash) throw new Error(`图片校验失败：${item.id}`);
    item.type = image.type; item.size = bytes.length; item.name = safeDisplayName(item.name); item.hash = hash(bytes);
  }
  const ids = new Set(media.map(item => item.id));
  if (contentRow) for (const section of JSON.parse(contentRow.content).sections) for (const image of section.images) {
    if (image.src.startsWith("/api/media/") && !ids.has(image.src.slice(11))) throw new Error(`迁移包缺少页面正在使用的图片：${image.src}`);
  }
  const db = openDatabase();
  const nonEmpty = db.prepare("SELECT (SELECT COUNT(*) FROM site_content) + (SELECT COUNT(*) FROM media) AS count").get().count > 0;
  if (nonEmpty && !replace) throw new Error("当前数据库不是空的，已停止导入。若确认替换，请先停止网站，再加 --replace；程序会先创建旧数据备份。");
  let previousBackup;
  if (nonEmpty) previousBackup = await createBackup(join(paths.directory, "backups", `before-restore-${Date.now()}`));
  const copied = [];
  try {
    for (const item of media) {
      const target = join(paths.uploads, item.id);
      try { await copyFile(join(input, "uploads", item.id), target, constants.COPYFILE_EXCL); copied.push(target); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (hash(await readFile(target)) !== item.hash) throw new Error(`同编号图片内容冲突，已停止恢复：${item.id}`);
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM site_content; DELETE FROM media; DELETE FROM admin_login_limits;");
      if (contentRow) db.prepare('INSERT INTO site_content ("key", content, revision, updated_at) VALUES (?, ?, ?, ?)').run("site", contentRow.content, contentRow.revision, contentRow.updated_at);
      const insertMedia = db.prepare("INSERT INTO media (id, name, type, size, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const item of media) insertMedia.run(item.id, item.name, item.type, item.size, item.created_at);
      const insertLimit = db.prepare("INSERT INTO admin_login_limits (key, attempts, failures, reset_at) VALUES (?, ?, ?, ?)");
      for (const item of limits) insertLimit.run(item.key, item.attempts, item.failures, item.reset_at);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { await Promise.all(copied.map(file => unlink(file).catch(() => undefined))); throw error; }
  return { mediaCount: media.length, previousBackup: previousBackup?.directory };
}

try {
  const args = process.argv.slice(2);
  if (!args.length) throw new Error("用法：restore:selfhost -- [--from-content] 备份目录 [--replace]");
  if (args.some(arg => arg.startsWith("--") && !["--from-content", "--replace"].includes(arg))) throw new Error("不支持的参数。");
  const source = args.find(arg => !arg.startsWith("--"));
  if (!source) throw new Error("请指定备份或内容迁移包目录。");
  const result = await restoreData(source, { fromContent: args.includes("--from-content"), replace: args.includes("--replace") });
  console.log(`恢复完成，共 ${result.mediaCount} 张上传图片。${result.previousBackup ? `旧数据保留在 ${result.previousBackup}。` : ""}请启动或重新启动网站。`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { closeDatabases(); }
