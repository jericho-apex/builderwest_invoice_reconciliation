-- Two changes, both found by running the pipeline end to end against the real
-- test mailbox on 2026-07-29.

-- 1. THE PIPELINE STOPS AT APPROVED.
--
-- Decided with Builderwest: setting `approvalStatus: "Approved"` does not trigger
-- Prime's Xero push (one production AP invoice has sat Approved-but-unsynced since
-- December 2023, and the 12 that did sync are all "Paid", updated in a batch by
-- what looks like a payment run). Waiting on the sync only ever produced a
-- meaningless timeout, so `approved` is now the terminal success stage and the
-- `approved_pending_sync` and `synced` stages are gone.
--
-- Existing rows have to move with it. A row left at 'synced' is no longer a
-- terminal stage as far as getInFlightInvoices is concerned, so the worker would
-- pick it up on every tick and advanceApproveFlow would throw on a stage it no
-- longer handles — an invoice that is genuinely finished, failing forever.
UPDATE invoices SET stage = 'approved' WHERE stage IN ('synced', 'approved_pending_sync');

-- The columns behind the retired sync check (is_synced, sync_attempt_count,
-- last_sync_check_at, synced_finance_system_name, synced_finance_system_reference)
-- are deliberately left in place and simply no longer written. Dropping a column in
-- SQLite means rebuilding the table, which is not worth it for dead space, and
-- keeping them means the historical rows above still say what Prime reported at the
-- time. What Prime holds after an approval now goes to the
-- `prime.read_back_ap_invoice` audit row instead.

-- 2. THE POLL CHECKPOINT WAS COMPARING THE WRONG TWO THINGS.
--
-- `processed_messages.first_seen_at` is wall-clock time at the moment we processed
-- a message ('now'), but the Inbox poll fed it into a Graph filter as
-- `receivedDateTime gt <checkpoint>`. Those are not the same clock, and the gap
-- silently loses invoices:
--
--   tick 1 fetches message A (older) and B (newer); A throws and is deliberately
--   left unmarked so it can be retried, B succeeds and sets the checkpoint to NOW.
--   tick 2 asks for receivedDateTime > now-15min. A's receivedDateTime is older
--   than that, so A is never polled again — no invoices row, no exception folder,
--   no trace beyond an audit line. A silently lost supplier invoice.
--
-- This is exactly the outcome pipeline/orchestrator.ts's "leave it unmarked so the
-- next poll retries it" comment is written to prevent, so the checkpoint has to be
-- measured in the same units it is compared against: the message's own
-- receivedDateTime.
ALTER TABLE processed_messages ADD COLUMN received_at TEXT;

-- Existing rows are left NULL, because nothing in the old schema recorded a
-- message's receivedDateTime — there is nothing to backfill from, and inventing a
-- value would be inventing a checkpoint.
--
-- NULL is the safe answer rather than a gap: getLatestProcessedTimestamp ignores
-- NULLs, so a database whose rows all predate this migration reports no checkpoint
-- and the poll falls back to its first-run lookback window. That re-lists recent
-- Inbox mail once, which costs one wasted listing and nothing else — every message
-- already in processed_messages is skipped by the dedupe pre-filter. It also
-- happens to recover any message the old checkpoint had stranded.

