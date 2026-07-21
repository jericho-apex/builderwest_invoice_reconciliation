import { loadEnv } from "../config/env.js";
import { runMigrations } from "../db/migrate.js";
import { logger } from "../log/logger.js";
import { startWorkerLoop } from "./loop.js";

/** Process entrypoint — this is what Render's Background Worker service runs. */
function main(): void {
  const env = loadEnv();
  logger.info("worker starting", {
    dryRun: env.PRIME_DRY_RUN,
    pollIntervalMinutes: env.POLL_INTERVAL_MINUTES,
  });

  runMigrations();

  const { stop } = startWorkerLoop();

  const shutdown = (signal: string): void => {
    logger.info("received shutdown signal, stopping after the current tick", { signal });
    stop();
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

main();
