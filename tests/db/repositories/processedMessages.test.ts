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
    markProcessed("msg-processed-1", "2026-07-29T10:16:45Z");
    expect(isEligibleForProcessing("msg-processed-1")).toBe(false);
    // The checkpoint is the MESSAGE's receivedDateTime, verbatim — not the wall
    // clock. It is fed straight into a Graph `receivedDateTime gt ...` filter, so
    // the two have to be the same clock. See getLatestProcessedTimestamp.
    expect(getLatestProcessedTimestamp()).toBe("2026-07-29T10:16:45Z");
  });

  it("keeps the newest receivedDateTime as the checkpoint, whatever order messages arrive in", () => {
    markProcessed("msg-order-older", "2026-07-29T09:00:00Z");
    markProcessed("msg-order-newer", "2026-07-29T11:00:00Z");
    markProcessed("msg-order-older-again", "2026-07-29T08:00:00Z");

    expect(getLatestProcessedTimestamp()).toBe("2026-07-29T11:00:00Z");
  });

  // The defect migration 004 fixes. A message processed WITHOUT its received time
  // must not push the checkpoint forward at all — the old code stamped 'now', which
  // is a different clock from the one Graph filters on, so any un-marked message
  // older than that (one deliberately left for retry, say) fell behind the
  // checkpoint and was never polled again. A silently lost supplier invoice.
  it("a message recorded with no received time does not move the checkpoint", () => {
    markProcessed("msg-no-received-time");

    expect(isEligibleForProcessing("msg-no-received-time")).toBe(false);
    expect(getLatestProcessedTimestamp()).toBe("2026-07-29T11:00:00Z");
  });

  it("fills in a received time later rather than losing one already recorded", () => {
    markProcessed("msg-late-time");
    expect(getLatestProcessedTimestamp()).toBe("2026-07-29T11:00:00Z");

    // A retry supplies it.
    markProcessed("msg-late-time", "2026-07-29T12:00:00Z");
    expect(getLatestProcessedTimestamp()).toBe("2026-07-29T12:00:00Z");

    // And a later call without one must not wipe it back out.
    markProcessed("msg-late-time");
    expect(getLatestProcessedTimestamp()).toBe("2026-07-29T12:00:00Z");
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
