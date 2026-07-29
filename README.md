# Builderwest Invoice Matching & Reconciliation (Phase 1)

Automates the trade (supplier) invoice reconciliation stage of Builderwest's claim
lifecycle: polls an invoice mailbox, extracts invoice fields, matches them against
Prime Ecosystem work orders, auto-approves clean matches, and routes anything
uncertain to reason-specific Outlook folders. No dashboard, no review UI — accounts
staff work the Outlook folders directly.

It **stops at approved**. Pushing to Xero stays with Builderwest's existing finance
process, which does it when an invoice is paid — the pilot does not touch that step
(see `docs/prime-api-gaps.md` Q6 for the production evidence behind that boundary).

Full design and rationale: see the project's implementation plan (shared separately
with the team) or `Builderwest_Phase1_PRD.md.pdf`.

## Prerequisites

- Node.js >= 20
- npm
- Access to: the Prime Ecosystem OAuth credentials for the dedicated integration
  user, a Microsoft Graph app registration scoped to the invoice mailbox, and an
  OpenRouter API key

## Setup

```bash
npm install
cp .env.example .env
# fill in .env with real credentials — never commit this file
npm run db:migrate
npm run dev
```

`npm run dev` runs the worker with hot-reload via `tsx watch`. `npm run build`
compiles to `dist/`; `npm start` runs the compiled worker (this is what Render
runs in production).

## ⚠️ There is no Prime sandbox for this pilot

`PRIME_BASE_URL` always points at Prime's production environment. Two things exist
specifically to make development safe without a sandbox:

- **`PRIME_DRY_RUN=true`** (the default) — the pipeline runs matching and decision
  logic and logs exactly what it *would* do (attachment upload, AP invoice
  creation, approval, `isSynced` poll) without calling any Prime write endpoint.
  Keep this on until you've manually reviewed dry-run output for a batch of
  synthetic test invoices.
- **`PRIME_TEST_WORK_ORDER_IDS`** — the comma-separated list of production Prime
  work orders that live writes are **fenced to**, used once dry-run is turned off
  for live write-path testing. This is enforced in code, not just documented: an
  invoice matching any other work order is refused *before* the attachment upload
  and routed to `Exceptions/Write blocked`, so it leaves nothing behind in Prime.
  Empty means unrestricted (the go-live setting), and the worker logs a warning
  when that is combined with live writes.

  Builderwest authorized live write testing on 2026-07-29 against test claim
  `BWC-WA-6797`, whose dummy work orders Tobey Chan created; cleanup in Prime and
  Xero is theirs to do, so **tell them when a run has finished**. **Never point
  this at a real customer work order.**

## Data & audit trail

State lives in a single SQLite database (`better-sqlite3`, WAL mode) at the path
set by `DB_PATH` — no external database. Four tables: `processed_messages`
(dedupe), `invoices` (per-invoice state machine — this is what makes a worker
restart mid-approval resumable instead of re-creating a duplicate AP invoice in
Prime), `match_results`, and an append-only `audit_log`. See
`src/db/migrations/001_init.sql` for the schema.

## Hosting

Deploys as a Render **Background Worker** (a single long-running Node process with
an internal poll loop — not Render's Cron Job type) with a persistent disk
attached for the SQLite file. Pin the service to a single instance; never enable
autoscaling (the disk attaches to exactly one instance, and SQLite is
single-writer). See the implementation plan for the full rationale.

## Testing

```bash
npm test
```

Unit tests (Vitest) cover the matching engine and database repositories. Dry-run
pipeline tests exercise the full flow without ever calling a Prime write endpoint.
Live write-path tests against the dedicated Prime test work order are run
separately and manually — see the plan's build sequence for the required
sign-off and cleanup steps before those are ever run.
