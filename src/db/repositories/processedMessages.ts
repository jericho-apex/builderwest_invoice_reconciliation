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

/**
 * Marks a message as processed (or re-processed after a retry).
 *
 * `receivedAt` is the message's own Graph `receivedDateTime`, and it is what the
 * poll checkpoint is built from — see getLatestProcessedTimestamp for why it
 * cannot be a wall-clock stamp. It is optional only so a caller that genuinely
 * does not have the summary to hand can still record the dedupe entry; when it is
 * absent the row simply does not contribute to the checkpoint, which is the safe
 * direction (a message gets re-listed, and dedupe skips it).
 */
export function markProcessed(messageId: string, receivedAt?: string): void {
  getDb()
    .prepare(
      `INSERT INTO processed_messages (message_id, first_seen_at, received_at, cleared_at)
       VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, NULL)
       ON CONFLICT (message_id) DO UPDATE SET
         cleared_at = NULL,
         received_at = COALESCE(excluded.received_at, processed_messages.received_at)`,
    )
    .run(messageId, receivedAt ?? null);
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
 * The newest `receivedDateTime` we have already processed — the Inbox poll
 * checkpoint (see lib/graph/mailbox.ts), so a growing mailbox is never re-listed in
 * full. Returns undefined when no processed message carries one, which the poll
 * treats as a first run and answers with its lookback window.
 *
 * IT MUST BE received_at, NOT first_seen_at. `first_seen_at` is wall-clock time at
 * the moment we processed the message, and the poll feeds this value into a Graph
 * filter as `receivedDateTime gt <checkpoint>` — two different clocks. Comparing
 * them silently loses invoices: if one message throws and is deliberately left
 * unmarked for retry while a later one succeeds, the checkpoint jumps to NOW and the
 * failed message's receivedDateTime is already behind it, so it is never polled
 * again. No invoices row, no exception folder, no supplier chasing it. That is the
 * exact outcome the "leave it unmarked so the next poll retries it" reasoning in
 * pipeline/orchestrator.ts exists to prevent (migration 004).
 */
export function getLatestProcessedTimestamp(): string | undefined {
  const row = getDb()
    .prepare<[], { max_ts: string | null }>(
      "SELECT MAX(received_at) AS max_ts FROM processed_messages",
    )
    .get();
  return row?.max_ts ?? undefined;
}
