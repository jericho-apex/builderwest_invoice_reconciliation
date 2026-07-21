import { getDb } from "../client.js";

/**
 * Returns true if this Graph message id has not yet been processed, or was
 * processed but then cleared for retry (moved back to Inbox/Retry by a
 * human). This is the dedupe check that runs before classification even
 * starts — a message a human explicitly retries must be eligible again.
 */
export function isEligibleForProcessing(messageId: string): boolean {
  const row = getDb()
    .prepare<[string], { cleared_at: string | null }>(
      "SELECT cleared_at FROM processed_messages WHERE message_id = ?",
    )
    .get(messageId);

  return row === undefined || row.cleared_at !== null;
}

/** Marks a message as processed (or re-processed after a retry). */
export function markProcessed(messageId: string): void {
  getDb()
    .prepare(
      `INSERT INTO processed_messages (message_id, first_seen_at, cleared_at)
       VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
       ON CONFLICT (message_id) DO UPDATE SET cleared_at = NULL`,
    )
    .run(messageId);
}

/** Marks a message as cleared for retry — the next poll will treat it as eligible again. */
export function clearForRetry(messageId: string): void {
  getDb()
    .prepare(
      `UPDATE processed_messages
       SET cleared_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE message_id = ?`,
    )
    .run(messageId);
}

/**
 * The most recent first_seen_at across every processed message — used as
 * the Inbox poll checkpoint (see lib/graph/mailbox.ts) so a growing mailbox
 * is never re-listed in full. Returns undefined if nothing has been
 * processed yet (first run).
 */
export function getLatestProcessedTimestamp(): string | undefined {
  const row = getDb()
    .prepare<[], { max_ts: string | null }>(
      "SELECT MAX(first_seen_at) AS max_ts FROM processed_messages",
    )
    .get();
  return row?.max_ts ?? undefined;
}
