import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const siteContent = sqliteTable("site_content", {
  key: text("key").primaryKey(),
  content: text("content").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const media = sqliteTable("media", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  size: integer("size").notNull(),
  createdAt: text("created_at").notNull(),
});

export const adminLoginLimits = sqliteTable("admin_login_limits", {
  key: text("key").primaryKey(),
  attempts: integer("attempts").notNull(),
  failures: integer("failures").notNull(),
  resetAt: integer("reset_at").notNull(),
});
