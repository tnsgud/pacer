import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { config } from "./config.js";
import * as schema from "./schema.js";

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });

const sqlite = new Database(config.DATABASE_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

export const db = drizzle(sqlite, { schema });

// 시작할 때 적용. drizzle/ 폴더는 Docker 이미지에 포함돼야 한다.
export function runMigrations() {
  migrate(db, { migrationsFolder: "drizzle" });
}
