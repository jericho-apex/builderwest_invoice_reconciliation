# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Phase 1 pilot automating trade (supplier) invoice reconciliation for Builderwest's
claim lifecycle: polls an invoice mailbox via Microsoft Graph, extracts invoice
fields with an AI PDF-extraction call (OpenRouter, targeting a Claude model),
matches against Prime Ecosystem work orders, auto-approves clean matches, and
routes anything uncertain to reason-specific Outlook folders. **It stops at
approved** — Builderwest's finance process pushes to Xero when it pays, which the
pilot deliberately does not touch (see prime-api-gaps.md Q6). No dashboard, no review UI — accounts staff work
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
npm run pipeline:sample      # the six client PDFs -> decision, vs a fake Prime
npm run discover:prime       # READ-ONLY production Prime lookups (see below)
npm run test:watch
npm run lint                  # eslint .
npm run format                # prettier --write .
```

Run a single test file: `npx vitest run tests/lib/matching/compareCost.test.ts`
Run tests matching a name: `npx vitest run -t "some test name"`

Three manual runners, all deliberately outside `npm test`, all loading
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
  PDFs are read. It also mirrors the two derivations `driveInvoice` applies before
  matching (`choosePurchaseOrder`, `resolveDueDate`) — skip them and two of the six
  invoices route wrongly.
- `npm run discover:prime` asks **production** Prime what a work order or contact
  actually holds — GETs only, no write endpoint, no Graph. This is how a new
  fixture's figures get established, and the reason to reach for it before
  inventing any: it is what revealed that Prime stores contact ABNs ATO-grouped.
  With no arguments it reports the three real test invoices; pass POs to look up
  others.

The first two source their PDF list from `tests/fixtures/clientDummyInvoices.ts`,
which is also what the "client sample invoices" test block asserts against — add a
new client sample there and everything picks it up. Its figures must come from
`discover:prime`, never from a guess.

### What the six client sample invoices prove

Two generations of sample data, testing different things. **All six pass, both
offline and against the live model** (`npm run pipeline:sample`, 2026-07-29).

The original three are **synthetic** — "suppliers" are Builderwest staff
(`contactType: User`, `@builderwest.com.au`) printing the placeholder ABN, so they
exercise name matching and nothing else:

| PDF | Issuer | PO | Total inc | Expected |
|---|---|---|---|---|
| `Dummy_Invoice_1_PO21266_CORRECT` | Ryan Smith | PO21266 | $478.50 | approve → `Processed` |
| `Dummy_Invoice_2_PO21267_INCORRECT_AMOUNT` | Tobey Chan | PO21267 | $775.50 | `Exceptions/Cost mismatch` |
| `Dummy_Invoice_3_INCORRECT_PO` | Brittnii Woods | PO99999 | $852.50 | `Exceptions/No work order` |

The three Builderwest sent on 2026-07-29 are **real invoices from real
subcontractors**, all against test claim `BWC-WA-6797`, and they are the first
data that exercises ABN matching at all:

| PDF | Issuer | PO | Total inc | Work order inc | Expected |
|---|---|---|---|---|---|
| `26.pdf` | Hutchy Ceilings | PO21343 | $1,204.50 | $1,204.50 | approve → `Processed` |
| `369.pdf` | Beale 4 | PO21342 | $396.00 | $275.00 | `Exceptions/Cost mismatch` |
| `invoice_300.pdf` | Rare Electrical | PO21340 | $660.00 | $660.00 | approve → `Processed` |

Every figure above was read from production Prime (`npm run discover:prime`), the
same rule that retired the invented $605.00 placeholder: **discover first, invent
nothing.** PO21266 is `costTotal` $435.00 + `costTaxTotal` $43.50 = $478.50 inc
GST; PO21267 is $405.00 + $40.50 = $445.50 against invoice 2's $775.50.

The traps worth knowing before changing extraction or matching:

- **The Attention line.** Synthetic invoices 2 and 3 print `Attention: Ryan Smith`
  while their real issuers are Tobey Chan and Brittnii Woods. Invoice 2 produces
  `costMismatch` either way, so an outcome-only assertion passes while the
  supplier is wrong — which is why the fixtures pin the resolved contact id.
- **The placeholder ABN.** The synthetic three print `00 000 000 000` under two
  different supplier names, so all three must resolve by name. Any `'abn'.eq(...)`
  query carrying the *placeholder* is a failure — the real three legitimately do
  query by ABN, so the assertion is specifically about the placeholder, in either
  format.
- **The supplier name that does not match.** The real invoices print legal names
  (`Hutchy Ceilings Pty Ltd`, `Rare Electrical PTY LTD`) where Prime holds trading
  names (`Hutchy Ceilings`, `Rare Electrical`). Under an exact `eq` the name lookup
  finds nothing for any of the three, so their expected `matched_by_abn` is not a
  nicety — it is the only route that works, and it only works because of the ABN
  format bridge below.
- **The PO under "WO No".** `369.pdf` labels its PO `WO No: PO21342`. The model
  currently returns it in *both* `purchaseOrderNumber` and `workOrderRef`
  (verified live), so `choosePurchaseOrder` just prefers the PO field — but the
  prompt tells the model those are separate fields, so the fallback stays as
  insurance against a model that honours that literally.
- **The missing due date.** `26.pdf` prints `Due in 30 Days` and no date. `dueDate`
  is required before any Prime write, so without `extraction/dueDate.ts` deriving
  it (`2026-07-28` + 30 → `2026-08-27`) the invoice never reaches the write path.
  The model reads `paymentTermsDays`; the arithmetic is in code, in UTC, and
  audited as `pipeline.due_date_derived`.
- **The two invoice numbers.** `invoice_300.pdf` heads with `Tax Invoice # 300` and
  repeats `# 597` in its How-to-Pay block, and dates itself `29 July 2025` against
  a `30 August 2026` due date. Take the header number; extract the date verbatim —
  second-guessing a supplier's paperwork is not extraction's job. It is also the
  lowest-confidence read of the six (0.85 against the 0.75 threshold).

**The four-way "Ryan Smith".** Production Prime holds four contacts named
`Ryan Smith` (one `User`, one `Client`, two `Customer`), so invoice 1's supplier
cannot resolve by name alone. The **assignment tie-break** (see `matching/`
below) settles it: PO21266 is assigned to `8141089f…`, which is one of the four,
so the supplier resolves as `matched_by_assignment` — verified live. Deduping the
contacts in Prime is still worth asking for, and `ASSUME_SUPPLIER_MATCHED`
remains as a separate escape hatch, but neither is needed for these invoices any
more.

## Critical operational context

**There is no Prime sandbox.** `PRIME_BASE_URL` always points at Prime's
production environment. Two things make development safe without one:

- `PRIME_DRY_RUN=true` (the default) — matching/decision logic runs and logs
  exactly what it *would* do (attachment upload, AP invoice creation, approval,
  `isSynced` poll) without calling any Prime write endpoint. Keep this on until
  dry-run output has been manually reviewed for a batch of synthetic invoices.
- `PRIME_TEST_WORK_ORDER_IDS` — the comma-separated work orders live writes are
  **fenced to**, used once dry-run is off for live write-path testing. Enforced in
  code, not just documented: `advanceApproveFlow` refuses any other work order
  *before* the attachment upload (so nothing is orphaned in Prime), audits
  `pipeline.write_blocked_not_allowlisted`, and routes the invoice to
  `Exceptions/Write blocked`. A procedural agreement was too thin here — there is
  no sandbox and the pilot mailbox is live, so a genuine supplier invoice arriving
  mid-test would otherwise be approved and pushed to Xero. An empty list means
  unrestricted (the go-live setting) and `loadEnv()` warns when that is combined
  with live writes. **Never point this at a real customer work order.**

  Builderwest authorized live write testing on 2026-07-29 against test claim
  `BWC-WA-6797`, whose dummy work orders Tobey Chan created. Cleanup in Prime and
  Xero is theirs to do — **tell Tobey Chan and the client when a run finishes.**

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
  -> attachment_uploaded -> ap_created -> approved     (approved is TERMINAL)
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
  persist the outcome → approve flow or exception routing). Between extraction
  and matching it applies the two **derivations** raw model output needs, in
  `deriveExtraction`: `choosePurchaseOrder` (which field actually holds the PO)
  and `resolveDueDate` (a due date the invoice stated only as terms). Both are
  audited — `purchaseOrderSource` on `pipeline.invoice_identifiers`, and
  `pipeline.due_date_derived` — because a matching key or a payment date that came
  from anywhere other than the obvious field must not be silent.
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
  → create AP invoice → approve → read the record back. **`approved` is terminal**;
  the flow no longer waits for Prime's Xero push, because the push does not follow
  approval (see `prime/apInvoices.ts` and prime-api-gaps.md Q6). The read-back is
  observation, not a gate — one GET whose only job is to confirm `workOrderId`
  survived the create, recorded as `prime.read_back_ap_invoice`.
  Two gates run at the `matched` stage **before** the upload, so a refusal never
  orphans an attachment on the Prime job: the required-fields check
  (→ `Exceptions/Unreadable`) and the live-write fence
  (→ `Exceptions/Write blocked`, see `PRIME_TEST_WORK_ORDER_IDS`).
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

  **`approveApInvoice` will not trigger the Xero push, and that is now known
  rather than suspected.** Read off all 15 production AP invoices on 2026-07-29:
  the one record at `approvalStatus: "Approved"` with its lifecycle status still
  `New` has never synced in two years — which is exactly the state this code
  leaves an invoice in. All 12 synced records are at
  `accountsPayableInvoiceStatus: "Paid"`, and were updated in a *batch* (identical
  `updatedAt` and `version` across records created a day apart), i.e. by a payment
  run rather than by anything approval did. `approvedAt` equals `createdAt` on all
  15, so approval was never a separate transition at all.

  The mechanism to change the lifecycle status is
  `PATCH /accounts-payable-invoices/{id}/relationships/accountsPayableInvoiceStatus`
  — a `GET` there returns **405, not 404**, which is how we know the route is real
  and PATCH-only. It needs the resource's current `version`, so a GET first.
  **Deliberately not implemented, and Builderwest have now chosen not to:**
  reaching a synced state means marking the invoice `Paid`, which asserts payment
  before payment. The decision (2026-07-29) is that **the pipeline stops at
  approved** and Builderwest's finance process keeps pushing to Xero when it pays,
  as it always did. So the sync poll, `MAX_SYNC_POLL_ATTEMPTS` and the
  `Exceptions/Xero sync failed` folder are all gone rather than left to time out
  into an exception that means nothing. **Do not "fix" this by setting `Paid`
  without written sign-off.**

  `readBackApInvoice` reads the record from `data.attributes` with flatter shapes
  as fallbacks. Reading only the top level (as it once did) sees `undefined` for
  every field, which would report a correctly-created AP invoice as carrying no
  work-order link at all — the wrong answer to the one question it exists to
  settle. A record that comes back without `workOrderId` is audited as an error;
  it does not fail the invoice, which is already approved by then.

  **`workOrderId` on AP-invoice create is effectively confirmed.** Prime's docs
  list it as optional and nobody answered whether it is retained — but **15/15**
  production AP invoices carry a `workOrderId` (and a `workOrderAssignedId`), so
  the field is stored on the resource. All that is left is confirming *our* create
  persists it, which the first live write's read-back shows. Whether a proper
  purchase-order concept exists in the API (no `/purchase-orders` endpoint, no PO
  field — the PO lives in the work order's `label`) is still open, but blocks
  nothing: the `label` route is verified working.
- `extraction/` — OpenRouter chat completion sending the PDF inline, strict
  JSON-only system prompt, `parseModelJson` validates against a Zod schema
  (`schemas.ts`). Low-confidence or unparseable extraction routes to
  `Exceptions/Unreadable` rather than being trusted. The model is asked only to
  *read*, never to compute: `paymentTermsDays` is the number of days a supplier's
  terms state, and `dueDate.ts` does the date arithmetic in UTC. Asking the model
  for a computed due date would put an unauditable payment date on a payable.
- `matching/` — pure functions layered over the Prime clients.
  `resolveWorkOrder` keys **only** off the invoice's purchase order number and
  has deliberately no job-number fallback: a job carries many work orders (the
  client's two dummy invoices are Stage 1 and Stage 2 of job `BWC-5126`,
  differing only by PO; the three real ones are all on claim `BWC-WA-6797`), so
  falling back to it would let an invoice be approved against a sibling work
  order. `resolveSupplier` tries ABN then name, but only
  uses an ABN that passes `matching/abn.ts`'s checksum validation — the dummy
  invoices print the placeholder `00 000 000 000` under two different supplier
  names, so trusting it would resolve both to the same contact. **Across both,
  the rule is exactly-one-match: zero matches and several matches are equally
  unresolved, never `data[0]`** — which is why the Prime finders return arrays.

  **Two format bridges, same shape and same justification.** Prime's `q=` is an
  exact `eq`, so a lookup whose value is formatted differently from the stored one
  misses silently. Both bridges enumerate the (at most two) canonical forms, query
  each, and **union the results by id** before the exactly-one rule runs. Neither
  widens what can match — an invoice that resolves to X today still has X in its
  union, so the only reachable changes are `not_found → matched` (the fix) and
  `→ ambiguous` (fail-safe, to a human). Neither short-circuits on the first
  non-empty result, because that would be `data[0]` one layer up: where both forms
  exist as different records, our own candidate ordering — not the invoice — would
  decide which one got the money. The union dedupe is equally load-bearing in the
  other direction: one record returned by both queries must count once, or a
  resolvable invoice looks ambiguous.

  - `matching/purchaseOrder.ts` — the **PO-prefix bridge**
    (`PO21343` ⇄ `21343`). The client confirmed POs always start with `PO` but
    suppliers sometimes omit it; Prime's labels are split the same way. Digits are
    never altered — leading zeros are kept and separators *inside* the digits are
    not stripped, since `PO 21 343 → 21343` invents a number. Anything that is not
    *optional prefix + digits* is queried verbatim. A bridged match emits
    `pipeline.work_order_matched_by_bridge`, so approving against a label that is
    not literally what the invoice printed is never silent. The same module's
    `choosePurchaseOrder` recovers a PO the model returned under `workOrderRef`
    (369.pdf prints `WO No: PO21342`), requiring the `PO` prefix so a bare
    work-order reference is never read as a PO, and never overriding a real
    `purchaseOrderNumber`.
  - `matching/abn.ts`'s `abnQueryCandidates` — the **ABN format bridge**.
    Verified live 2026-07-29: production stores contact ABNs **ATO-grouped**
    (`68 628 819 741`), so the digits-only query this used to send could never
    hit. That mattered more than it sounds: the real invoices print legal names
    (`Hutchy Ceilings Pty Ltd`) where Prime holds trading names
    (`Hutchy Ceilings`), so the name lookup misses too and all three routed to
    `Exceptions/Supplier not found`. The ABN is the only key that resolves a real
    supplier.
  The one narrowing allowed is the **assignment tie-break**: where several
  contacts share the invoice's supplier name and exactly one of them is the
  contact the matched work order is assigned to (`assignedId`), that one wins,
  recorded as `matched_by_assignment`. It is not `data[0]` in disguise — the
  candidate set is already restricted to contacts the invoice itself names, so it
  can never introduce an unrelated party, and it never fires when the name
  matched nobody. This is what makes Builderwest's four-way "Ryan Smith"
  ambiguity resolvable. `ASSUME_SUPPLIER_MATCHED` is the separate test-run
  bypass; neither changes which lookups run, nor overrides a genuine match.
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
`PRIME_TEST_WORK_ORDER_IDS` are run separately and manually, requiring the
sign-off/cleanup steps in the implementation plan — do not wire these into the
automated suite.

**Keep the Prime stubs keyed, not blanket.** Both format bridges are invisible to
a stub that ignores its argument: an unkeyed `findContactsByAbn` makes the
digits-only query appear to work offline while missing in production, which is the
exact defect `abnQueryCandidates` exists to fix. The `tests/fixtures/` contacts
therefore store ABNs the way production does — grouped — and the sample block's
stubs compare exactly.

`tests/pipeline/approve.writeFence.test.ts` is the one suite that runs with
`PRIME_DRY_RUN=false`, because the write fence only exists on the live path. It
mocks Prime's write clients for that reason: with dry-run off, a fence that failed
to hold would otherwise POST to production.
