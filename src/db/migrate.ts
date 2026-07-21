import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "./client.js";
import { logger } from "../log/logger.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * Applies every .sql file in migrations/ that hasn't already run, in
 * filename order (001_, 002_, ...), tracked in a schema_migrations table.
 * Safe to run repeatedly — already-applied migrations are skipped.
 */
export function runMigrations(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const applied = new Set(
    db
      .prepare<[], { name: string }>("SELECT name FROM schema_migrations")
      .all()
      .map((row) => row.name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
    });

    applyMigration();
    logger.info("applied migration", { file });
  }
}

// Allow `npm run db:migrate` (tsx src/db/migrate.ts) to run this directly.
// Compare filesystem paths (via fileURLToPath), not raw strings — import.meta.url
// percent-encodes characters like spaces, which a raw `file://${argv[1]}` does not.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runMigrations();
}
