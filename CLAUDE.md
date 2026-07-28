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
npm run pipeline:sample      # the three client PDFs -> decision, vs a fake Prime
npm run test:watch
npm run lint                  # eslint .
npm run format                # prettier --write .
```

Run a single test file: `npx vitest run tests/lib/matching/compareCost.test.ts`
Run tests matching a name: `npx vitest run -t "some test name"`

Two manual sample runners, both deliberately outside `npm test`, both loading
`.env.local` if present:

- `npm run extract:sample` runs the real extraction prompt against the dummy
  invoice PDFs in `docs/` and prints the JSON — the way to check a prompt change
  against the client's actual invoice layout and to calibrate
  `EXTRACTION_CONFIDENCE_THRESHOLD`. Calls OpenRouter only.
- `npm run pipeline:sample` carries on from there into the decision: same PDFs,
  real extraction, then the same `decideMatch` the worker runs, against a fake
  Prime on loopback (`scripts/lib/fake-prime-server.ts`). Prints per invoice what
  the model read, which work order and contact resolved, and which folder it
  would land in, exiting non-zero on any deviation from
  `tests/fixtures/clientDummyInvoices.ts`. **No Graph call at all** — it stops at
  the decision. `-- --offline` skips the model and uses fixture extraction, which
  still exercises the real Prime client stack but proves nothing about how the
  PDFs are read.

Both source their PDF list from `tests/fixtures/clientDummyInvoices.ts`, which is
also what the "three client dummy invoices" test block asserts against — add a
new client sample there and everything picks it up.

### What the three client dummy invoices prove

| PDF | Issuer | PO | Total inc | Expected |
|---|---|---|---|---|
| `Dummy_Invoice_1_PO21266_CORRECT` | Ryan Smith | PO21266 | $478.50 | approve → `Processed` |
| `Dummy_Invoice_2_PO21267_INCORRECT_AMOUNT` | Tobey Chan | PO21267 | $775.50 | `Exceptions/Cost mismatch` |
| `Dummy_Invoice_3_INCORRECT_PO` | Brittnii Woods | PO99999 | $852.50 | `Exceptions/No work order` |

Two traps worth knowing before changing extraction or matching:

- **The Attention line.** Invoices 2 and 3 print `Attention: Ryan Smith` while
  their real issuers are Tobey Chan and Brittnii Woods. Invoice 2 produces
  `costMismatch` either way, so an outcome-only assertion passes while the
  supplier is wrong — which is why the fixtures pin the resolved contact id.
- **The placeholder ABN.** All three print `00 000 000 000`, so all three must
  resolve by name. Any `'abn'.eq(...)` query reaching Prime is a failure, and
  both the test block and `pipeline:sample` assert none is sent.

Both work orders' figures are now the real ones, read from production Prime on
2026-07-28: PO21266 is `costTotal` $435.00 + `costTaxTotal` $43.50 = **$478.50**
inc GST (invoice 1 matches to the cent), PO21267 is $405.00 + $40.50 =
**$445.50** against invoice 2's $775.50. The invented $605.00 placeholder is
retired.

**What blocks a live E2E run today.** Production Prime holds **four** contacts
named `Ryan Smith` (one `User`, one `Client`, two `Customer`), so invoice 1's
supplier cannot resolve under the exactly-one-match rule and it exits at
`supplierNotFound` before cost is ever checked. `ASSUME_SUPPLIER_MATCHED=true`
(see below) is the test-run device for getting past that; the real fix is the
client deduping, or resolving the supplier from the work order's `assignedId`,
which already points at the right contact on both dummy work orders. Note also
that all three dummy "suppliers" are Builderwest staff (`contactType: User`,
`@builderwest.com.au`), so this data does not exercise supplier matching the way
production will.

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

`ASSUME_SUPPLIER_MATCHED=true` is a **test-run-only** third switch: an invoice
whose supplier does not resolve to exactly one Prime contact continues to the
cost check as `"assumed"` instead of routing to `Exceptions/Supplier not found`.
It records a `pipeline.supplier_assumed` audit row, persists no
`prime_contact_id` (there is no verified contact to persist), and `loadEnv()`
**refuses to start** if it is combined with `PRIME_DRY_RUN=false` — the one
combination that could approve a real AP invoice against an unverified supplier.
It must never be set on Render.

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
  per PDF attachment → drive) and `driveInvoice` (extract → `decideMatch` →
  persist the outcome → approve flow or exception routing).
- `decide.ts` — `decideMatch`, the matching decision core: work order →
  supplier → cost, stopping at the first failing check. It computes and
  `driveInvoice` persists — no `match_results` row, no `invoices` update, and
  crucially **no Graph call**, which is what makes it the largest slice of
  pipeline runnable outside the worker (`GRAPH_BASE_URL` is a hardcoded const,
  so anything that moves a message can only hit the live mailbox). Audit rows
  come back as data rather than being written, because
  `pipeline.work_order_unresolved` carries a `matchCount` the caller can't
  reconstruct. Not side-effect free though: the Prime finders write their own
  `audit_log` rows, so a migrated DB is still required.
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

  **Prime's money model** (read off 15 production AP invoices on 2026-07-28, and
  the same convention on work orders): `tax` is a **rate** (`0.1000`), `taxTotal`
  is the GST **amount** Prime calculates itself, and `amount` is the
  **tax-inclusive total** — 968.00 with taxTotal 88 is 880 ex-GST. So AP-invoice
  create sends a single inc-GST `amount` and nothing else about tax, and cost
  matching compares inc-GST to inc-GST. Both writes also require `jobId`, which
  comes off the matched work order (`prime_job_id`, migration 003) and never from
  the job number printed on the PDF. Created resources return their id at
  `data.id`, JSON:API style; every resource carries an integer `version` for
  optimistic concurrency.

  `approveApInvoice` is the one write still built on a guess, and it is known
  wrong rather than merely unverified: production holds records with
  `approvalStatus: "Approved"` and `isSynced: false`, so setting that field alone
  — exactly what the code does — does **not** trigger Prime's Xero push. Every
  synced record instead sits at `accountsPayableInvoiceStatus: "Paid"`. Whether
  the push fires on reaching `"Approved"` or only `"Paid"` is the last real
  blocker on the live path (prime-api-gaps.md Q6). Live, an invoice would
  approve, poll `isSynced` `MAX_SYNC_POLL_ATTEMPTS` times, and land in
  `Exceptions/Xero sync failed`.
- `extraction/` — OpenRouter chat completion sending the PDF inline, strict
  JSON-only system prompt, `parseModelJson` validates against a Zod schema
  (`schemas.ts`). Low-confidence or unparseable extraction routes to
  `Exceptions/Unreadable` rather than being trusted.
- `matching/` — pure functions layered over the Prime clients.
  `resolveWorkOrder` keys **only** off the invoice's purchase order number and
  has deliberately no job-number fallback: a job carries many work orders (the
  client's two dummy invoices are Stage 1 and Stage 2 of job `BWC-5126`,
  differing only by PO), so falling back to it would let an invoice be approved
  against a sibling work order. `resolveSupplier` tries ABN then name, but only
  uses an ABN that passes `matching/abn.ts`'s checksum validation — the dummy
  invoices print the placeholder `00 000 000 000` under two different supplier
  names, so trusting it would resolve both to the same contact. **Across both,
  the rule is exactly-one-match: zero matches and several matches are equally
  unresolved, never `data[0]`** — which is why the Prime finders return arrays.
  The single exception is `ASSUME_SUPPLIER_MATCHED`, which converts an unresolved
  supplier into `"assumed"` for a test run; it never changes which lookups run,
  and never overrides a genuine match.
  `compareCost` (integer-cents
  comparison against `COST_FIELD`/`COST_TOLERANCE_MODE`/`COST_TOLERANCE_VALUE`
  from env — a tighter tolerance only ever sends more items to review, never
  widens what counts as a match). A Prime work order carries `costTotal` (ex-GST)
  and `costTaxTotal` (**the GST amount alone**, despite the name) and no `cost`
  field at all, so `COST_FIELD` defaults to `costTotalIncTax`, which sums the two
  in cents to get the inc-GST figure an invoice actually prints. That settles
  PRD §9.6 — the API answered it, not the client.
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
calling a Prime write endpoint. Shared fixtures live in `tests/fixtures/`; the
sample scripts import from there too, so the offline suite and the live proof
run can't drift.

The suite is hermetic and offline: extraction is mocked, and the Prime finders
are `vi.mock`ed. That last part means `buildEqQuery`, `primeRequest`, the
JSON:API `Accept` header and `mapWorkOrder`'s dollars→cents conversion are
covered by **no test** — `npm run pipeline:sample` is the only thing that
exercises them, which is part of why it exists. Live write-path tests against
`PRIME_TEST_WORK_ORDER_ID` are run separately and manually, requiring the
sign-off/cleanup steps in the implementation plan — do not wire these into the
automated suite.
