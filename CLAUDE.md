# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Phase 1 pilot automating trade (supplier) invoice reconciliation for Builderwest's
claim lifecycle: polls an invoice mailbox via Microsoft Graph, extracts invoice
fields with an AI PDF-extraction call (OpenRouter, targeting a Claude model),
matches against Prime Ecosystem work orders, auto-approves clean matches, verifies
Prime's existing Xero push succeeded, and routes anything uncertain to
reason-specific Outlook folders. No dashboard, no review UI — accounts staff work
the Outlook folders directly. Full design/rationale lives in the implementation
plan (shared separately) / `Builderwest_Phase1_PRD.md.pdf`.

## Commands

```bash
npm install
cp .env.example .env        # fill in real credentials, never commit .env
npm run db:migrate          # applies src/db/migrations/*.sql via better-sqlite3
npm run dev                 # tsx watch src/worker/index.ts — hot reload
npm run build                # tsc -p tsconfig.json -> dist/
npm start                    # node dist/worker/index.js (what Render runs)
npm test                     # vitest run
npm run test:watch
npm run lint                  # eslint .
npm run format                # prettier --write .
```

Run a single test file: `npx vitest run tests/lib/matching/compareCost.test.ts`
Run tests matching a name: `npx vitest run -t "some test name"`

## Critical operational context

**There is no Prime sandbox.** `PRIME_BASE_URL` always points at Prime's
production environment. Two things make development safe without one:

- `PRIME_DRY_RUN=true` (the default) — matching/decision logic runs and logs
  exactly what it *would* do (attachment upload, AP invoice creation, approval,
  `isSynced` poll) without calling any Prime write endpoint. Keep this on until
  dry-run output has been manually reviewed for a batch of synthetic invoices.
- `PRIME_TEST_WORK_ORDER_ID` — a dedicated dummy work order in production Prime,
  used only once dry-run is off for live write-path testing, and only with
  written authorization and an agreed cleanup process. **Never point this at a
  real customer work order.**

Deploys as a Render **Background Worker** (long-running Node process with an
internal poll loop, not a Cron Job) with a persistent disk for the SQLite file.
Pinned to a single instance, never autoscaled — the disk attaches to one
instance and SQLite here is single-writer.

## Architecture

### Process shape

`worker/index.ts` is the entrypoint: loads env, runs migrations, starts
`worker/loop.ts`'s `startWorkerLoop()`. That loop runs `runTick()` on a
`POLL_INTERVAL_MINUTES` interval (interruptible sleep so SIGTERM/SIGINT stop
between ticks, not mid-tick):

1. Resume any `invoices` rows left in a non-terminal stage by a prior crash
   (`getInFlightInvoices` → `driveInvoice`).
2. Poll Graph for new Inbox messages and Retry-folder reappearances.
3. Drain retry messages, then inbox messages — both bounded by
   `PRIME_RATE_LIMITS.maxConcurrent` via `lib/queue/taskQueue.ts`'s
   `runWithConcurrency`.

### The invoice state machine (the core design)

Everything hinges on `invoices.stage` in the SQLite DB (WAL mode,
`better-sqlite3`, path from `DB_PATH`, schema in
`src/db/migrations/001_init.sql`):

```
received -> classified -> extracted -> matched
  -> attachment_uploaded -> ap_created -> approved_pending_sync -> synced
or: exception:<reason>  (reason keys match EXCEPTION_FOLDERS in config/constants.ts)
```

`pipeline/orchestrator.ts`'s `driveInvoice(invoiceId)` reads the invoice's
current stage and continues from there — it is the **same function** used for
fresh processing right after creation and for crash-recovery resume on the next
tick. Every Prime write persists its returned ID immediately (one write at a
time, never batched — see `pipeline/approve.ts`'s `advanceApproveFlow`) so a
restart resumes from the last completed step instead of re-creating a duplicate
AP invoice in Prime. When adding a new pipeline step, follow this pattern:
persist the stage/ID transition before doing the next side-effecting call, not
after.

Other tables: `processed_messages` (message-level dedupe — a non-invoice
message never gets an `invoices` row, this table is its only trace),
`match_results` (one row per matching attempt, latest is authoritative), and
`audit_log` (append-only, one row per Prime/Graph/OpenRouter call and folder
move — never derive "current state" from it, that's `invoices.stage`'s job).

### Pipeline flow (`src/pipeline/`)

- `filter.ts` — free structural pre-filter (dedupe, has-PDF-attachment check)
  before any AI call. Deliberately has no sender-allowlist/subject-pattern
  filter yet (needs real patterns from Builderwest first).
- `orchestrator.ts` — `processMessage` (classify → create one `invoices` row
  per PDF attachment → drive) and `driveInvoice` (extract → resolve work order →
  resolve supplier → compare cost → approve flow).
- `approve.ts` — `advanceApproveFlow`, a stage-by-stage loop: upload attachment
  → create AP invoice → approve → poll `isSynced`. The sync poll checks once per
  call and returns `"pending_sync"` rather than looping with a sleep — polling
  is paced across ticks via `MAX_SYNC_POLL_ATTEMPTS`, not held in a tight loop.
- `exception.ts` — routes to a reason-specific Outlook subfolder
  (`EXCEPTION_FOLDERS`), never auto-approves on a guess. `"unreadable"` is also
  the one trigger for the missing-data auto-reply email.
- `retry.ts` — a message reappearing in the dedicated Retry folder (not
  dragged back to Inbox — Graph's `receivedDateTime` doesn't change on move, so
  the checkpoint-filtered Inbox poll would never see it again) is the human's
  retry signal; resets invoice state then hands off to `processMessage`, which
  is naturally idempotent either way.

### Integration clients (`src/lib/`)

- `graph/` — Microsoft Graph: mailbox polling (checkpoint-filtered Inbox +
  fully-listed Retry folder every tick), folder moves/creation, attachment
  fetch, send-mail. Attachments come back as inline base64 — large attachments
  beyond Graph's inline threshold are a known unhandled gap.
- `prime/` — Prime Ecosystem v2 REST client. `httpClient.ts`'s `primeRequest`
  is transport-only (auth, rate limiting via `rateLimiter.ts`'s sliding-window +
  concurrency limiter, retry-with-backoff on 429/5xx/network errors); callers
  (`workOrders.ts`, `contacts.ts`, `apInvoices.ts`, `attachments.ts`) own audit
  logging and dry-run gating for writes. `PRIME_RATE_LIMITS` in
  `config/constants.ts` is tuned to Prime's published limits (60/min, 5
  concurrent, 5000/day) — don't adjust without confirming new figures against
  Prime's docs.
- `extraction/` — OpenRouter chat completion sending the PDF inline, strict
  JSON-only system prompt, `parseModelJson` validates against a Zod schema
  (`schemas.ts`). Low-confidence or unparseable extraction routes to
  `Exceptions/Unreadable` rather than being trusted.
- `matching/` — pure functions layered over the Prime clients:
  `resolveWorkOrder` (by reference, falls back to job number),
  `resolveSupplier` (by ABN, falls back to name), `compareCost` (integer-cents
  comparison against `COST_FIELD`/`COST_TOLERANCE_MODE`/`COST_TOLERANCE_VALUE`
  from env — a tighter tolerance only ever sends more items to review, never
  widens what counts as a match).
- `queue/` — `taskQueue.ts`'s `runWithConcurrency` (app-level concurrency,
  independent of Prime's own limiter) and `backoff.ts`'s retry helper.

### Config

`config/env.ts` parses and validates `process.env` once via Zod
(`loadEnv()`, cached) and fails fast listing every missing/malformed variable.
`config/constants.ts` holds values that are business rules, not per-environment
config (exception folder names, rate limits, retry/poll-attempt counts,
extraction confidence threshold) — several are explicitly flagged inline as
placeholders pending client calibration; check the comment above a constant
before assuming it's finalized.

Money is always integer cents end-to-end (`*_cents` columns and fields) —
never floats — since GST math is exactly where floating-point rounding
produces false mismatches.

## Testing

Vitest, `tests/` mirrors `src/` structure, config in `vitest.config.ts`
(`environment: "node"`). Current coverage is the matching engine and DB
repositories — dry-run pipeline tests exercise the full flow without ever
calling a Prime write endpoint. Live write-path tests against
`PRIME_TEST_WORK_ORDER_ID` are run separately and manually, requiring the
sign-off/cleanup steps in the implementation plan — do not wire these into the
automated suite.
