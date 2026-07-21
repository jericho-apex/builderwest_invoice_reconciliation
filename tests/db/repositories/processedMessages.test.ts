import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, it, expect } from "vitest";
import { runMigrations } from "../../../src/db/migrate.js";
import {
  isEligibleForProcessing,
  markProcessed,
  clearForRetry,
  getLatestProcessedTimestamp,
} from "../../../src/db/repositories/processedMessages.js";

// NOTE: db/client.ts caches its connection in a module-level singleton on
// first use, bound to whatever DB_PATH was set at that moment — so DB_PATH
// must be set once, before anything in this file touches the database, not
// reassigned mid-file expecting a fresh connection.
beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "bw-processed-messages-test-"));
  process.env.DB_PATH = join(dir, "app.db");
  process.env.PRIME_BASE_URL = "https://www.primeeco.tech/api/prime/v2";
  process.env.PRIME_CLIENT_ID = "test";
  process.env.PRIME_CLIENT_SECRET = "test";
  process.env.PRIME_USERNAME = "test";
  process.env.PRIME_PASSWORD = "test";
  process.env.GRAPH_TENANT_ID = "test";
  process.env.GRAPH_CLIENT_ID = "test";
  process.env.GRAPH_CLIENT_SECRET = "test";
  process.env.GRAPH_MAILBOX_ADDRESS = "test@example.com";
  process.env.OPENROUTER_API_KEY = "test";

  runMigrations();
});

describe("processedMessages repository", () => {
  // Runs first, deliberately, while the database is still empty.
  it("getLatestProcessedTimestamp returns undefined before anything has ever been processed", () => {
    expect(getLatestProcessedTimestamp()).toBeUndefined();
  });

  it("a never-seen message is eligible for processing", () => {
    expect(isEligibleForProcessing("msg-fresh-1")).toBe(true);
  });

  it("markProcessed makes the message ineligible for reprocessing, and sets the checkpoint", () => {
    markProcessed("msg-processed-1");
    expect(isEligibleForProcessing("msg-processed-1")).toBe(false);
    expect(getLatestProcessedTimestamp()).not.toBeUndefined();
  });

  it("clearForRetry makes a previously-processed message eligible again", () => {
    markProcessed("msg-retry-1");
    expect(isEligibleForProcessing("msg-retry-1")).toBe(false);

    clearForRetry("msg-retry-1");
    expect(isEligibleForProcessing("msg-retry-1")).toBe(true);
  });

  it("markProcessed after a retry clears cleared_at again, so it isn't reprocessed a third time", () => {
    markProcessed("msg-retry-cycle-1");
    clearForRetry("msg-retry-cycle-1");
    expect(isEligibleForProcessing("msg-retry-cycle-1")).toBe(true);

    markProcessed("msg-retry-cycle-1");
    expect(isEligibleForProcessing("msg-retry-cycle-1")).toBe(false);
  });
});
