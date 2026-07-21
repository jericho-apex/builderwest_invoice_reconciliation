import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { loadEnv } from "../config/env.js";

let db: Database.Database | undefined;

/**
 * Single shared better-sqlite3 connection, WAL mode. SQLite is single-writer
 * by design here — this project deliberately runs as one long-lived process
 * (Render Background Worker, numInstances: 1), so a single connection is the
 * correct model, not a pool.
 */
export function getDb(): Database.Database {
  if (db) {
    return db;
  }

  const { DB_PATH } = loadEnv();
  mkdirSync(dirname(DB_PATH), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}
