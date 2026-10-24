import "./selfhost-env.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdir, copyFile, writeFile, readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { dataPaths, openDatabase, closeDatabases } from "../lib/selfhost-database.mjs";

export async function createBackup(destination) {
  const output = resolve(destination);
  const paths = dataPaths();
  if (output === paths.directory || output === paths.uploads) throw new Error("备份位置不能覆盖当前数据目录。");
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 }); // Deliberately reject an existing destination.
  await mkdir(join(output, "uploads"), { mode: 0o700 });
  // VACUUM INTO creates a consistent SQLite snapshot while the server is running.
  openDatabase().prepare("VACUUM INTO ?").run(join(output, "content.sqlite"));
  const snapshot = new DatabaseSync(join(output, "content.sqlite"), { readOnly: true });
  try {
    const rows = snapshot.prepare("SELECT id FROM media ORDER BY id").all();
    const files = [];
    for (const { id } of rows) {
      if (!/^[0-9a-f-]{36}\.(jpg|png|webp|gif)$/.test(id)) throw new Error("数据库中存在无效媒体编号。");
      const bytes = await readFile(join(paths.uploads, id));
      await copyFile(join(paths.uploads, id), join(output, "uploads", id));
      files.push({ id, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    await writeFile(join(output, "backup.json"), JSON.stringify({ format: "lando-selfhost-backup-v1", createdAt: new Date().toISOString(), media: files }, null, 2) + "\n", { mode: 0o600 });
    return { directory: output, mediaCount: files.length };
  } finally { snapshot.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error("请指定新备份目录，例如 npm run backup:selfhost -- ./backups/2026-10-24。");
    const result = await createBackup(process.argv[2]);
    console.log(`备份完成：${result.directory}，包含 ${result.mediaCount} 张上传图片。管理员密码配置不在备份内。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { closeDatabases(); }
}
