import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";

const databases = new Map();

export function dataPaths() {
  const directory = resolve(process.env.DATA_DIR || "./data");
  return { directory, database: join(directory, "content.sqlite"), uploads: join(directory, "uploads") };
}

/** The same schema is used by the application and offline migration commands. */
export function openDatabase() {
  const paths = dataPaths();
  if (databases.has(paths.database)) return databases.get(paths.database);
  mkdirSync(paths.uploads, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(paths.database);
  chmodSync(paths.database, 0o600);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS site_content (
      "key" TEXT PRIMARY KEY, content TEXT NOT NULL,
      revision INTEGER NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      size INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS admin_login_limits (
      "key" TEXT PRIMARY KEY, attempts INTEGER NOT NULL, failures INTEGER NOT NULL, reset_at INTEGER NOT NULL
    );
  `);
  databases.set(paths.database, db);
  return db;
}

export function closeDatabases() {
  for (const db of databases.values()) db.close();
  databases.clear();
}
