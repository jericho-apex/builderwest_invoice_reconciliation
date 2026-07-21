import { loadEnv } from "../config/env.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Operational logging (structured, to stdout/stderr) — distinct from the
 * SQLite audit_log table, which is the durable, queryable record of every
 * Prime/Graph/OpenRouter call and folder move. This logger is for humans
 * watching Render logs in real time, not for the audit trail.
 */
function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const { LOG_LEVEL } = loadEnv();
  if (LEVEL_ORDER[level] < LEVEL_ORDER[LOG_LEVEL]) {
    return;
  }

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields,
  };

  const target = level === "error" || level === "warn" ? console.error : console.log;
  target(JSON.stringify(entry));
}

export const logger = {
  debug: (message: string, fields?: Record<string, unknown>) => log("debug", message, fields),
  info: (message: string, fields?: Record<string, unknown>) => log("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => log("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) => log("error", message, fields),
};
