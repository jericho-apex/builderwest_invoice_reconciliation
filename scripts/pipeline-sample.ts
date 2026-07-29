/**
 * Proof that the pipeline separates the client's good invoice from the bad ones
 * — NOT part of `npm test`.
 *
 * Runs the three real PDFs in docs/ through the REAL extraction model and then
 * the SAME decideMatch the worker calls, against a fake Prime on loopback, and
 * prints what each invoice would do. Exits non-zero if any invoice lands
 * somewhere other than tests/fixtures/clientDummyInvoices.ts says it should.
 *
 * It stops at the decision and never runs the approve flow or exception
 * routing, because GRAPH_BASE_URL is a hardcoded const (lib/graph/httpClient.ts)
 * — anything past the decision can only talk to the live mailbox. So: real
 * OpenRouter call, stubbed Prime, zero Graph calls, zero Prime writes.
 *
 * The offline counterpart is the "three client dummy invoices" block in
 * tests/pipeline/orchestrator.dryrun.test.ts, which shares these fixtures and
 * covers the half this script cannot (folder moves, approve flow).
 *
 * A red row means investigate, not necessarily regression: this is a live model
 * call and temperature 0 is not a determinism guarantee.
 *
 * Usage:
 *   npm run pipeline:sample                # needs OPENROUTER_API_KEY + credits
 *   npm run pipeline:sample -- --offline   # skip the model, use fixture extraction
 *
 * --offline substitutes the known-correct extraction from the fixtures instead
 * of calling OpenRouter. It still exercises the whole matching stack for real —
 * buildEqQuery, primeRequest, mapWorkOrder's dollars->cents, decideMatch — which
 * is more than the vitest suite covers, since that mocks the Prime finders
 * wholesale. What it CANNOT tell you is whether the model reads the PDFs
 * correctly; that is the live run's job, and the Attention-line trap on invoices
 * 2 and 3 is exactly what it exists to catch.
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Env overrides MUST precede the first loadEnv() call. ESM hoists the imports
// below above this block, so this is only safe because no module in src/ calls
// loadEnv() at module scope — they all call it lazily inside functions. Keep it
// that way, or move these into a separate module imported first.
//
// The cost config is pinned rather than inherited: a developer with
// COST_FIELD=costTotal in their environment would otherwise see invoice 1
// mismatch by exactly its GST and conclude the pipeline is broken.
//
// ASSUME_SUPPLIER_MATCHED is pinned OFF for the same reason in reverse — this
// script's whole point is proving the supplier resolves by NAME, which the flag
// would paper over. The real duplicate-contact problem lives in production
// Prime, not in the fake, so the fixtures resolve cleanly either way.
// ---------------------------------------------------------------------------
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bw-pipeline-sample-")), "app.db");
process.env.PRIME_DRY_RUN = "true";
process.env.COST_FIELD = "costTotalIncTax";
process.env.COST_TOLERANCE_MODE = "exact";
process.env.COST_TOLERANCE_VALUE = "0";
process.env.PRIME_WORK_ORDER_PO_FIELD = "purchaseOrderNumber";
process.env.ASSUME_SUPPLIER_MATCHED = "false";

import { loadEnv } from "../src/config/env.js";
import { EXTRACTION_CONFIDENCE_THRESHOLD, EXCEPTION_FOLDERS } from "../src/config/constants.js";
import { runMigrations } from "../src/db/migrate.js";
import { extractInvoiceFields } from "../src/lib/extraction/extractInvoice.js";
import { dollarsToCents } from "../src/lib/money.js";
import { decideMatch } from "../src/pipeline/decide.js";
import { choosePurchaseOrder } from "../src/lib/matching/purchaseOrder.js";
import { resolveDueDate } from "../src/lib/extraction/dueDate.js";
import {
  CLIENT_DUMMY_INVOICES,
  PRIME_CONTACTS,
  PRIME_WORK_ORDERS,
  type ClientDummyInvoice,
} from "../tests/fixtures/clientDummyInvoices.js";
import { startFakePrime } from "./lib/fake-prime-server.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

interface Row {
  label: string;
  supplierRead: string;
  poRead: string;
  invoiceTotal: string;
  workOrderCost: string;
  expected: string;
  actual: string;
  pass: boolean;
  notes: string[];
}

function money(cents: number | undefined): string {
  return cents === undefined ? "—" : `$${(cents / 100).toFixed(2)}`;
}

/** How an outcome reads in the table — the folder it lands in, or "approve". */
function describeOutcome(outcome: string, reason?: string): string {
  if (outcome === "approve") return "approve";
  if (outcome === "unreadable") return `flag: ${EXCEPTION_FOLDERS.unreadable}`;
  return reason ? `flag: ${EXCEPTION_FOLDERS[reason as keyof typeof EXCEPTION_FOLDERS]}` : outcome;
}

/** The placeholder the synthetic invoices print, which abn.ts must reject. */
const PLACEHOLDER_ABN = "00 000 000 000";

/** What --offline feeds in place of a model call: the fixture's known-correct read. */
function fixtureExtraction(invoiceCase: ClientDummyInvoice) {
  const { extraction } = invoiceCase;
  return {
    supplierName: extraction.supplierName,
    // The synthetic three print the placeholder; the real ones print valid ABNs,
    // and those are the only key that resolves them (Prime holds trading names).
    supplierAbn: extraction.supplierAbn ?? PLACEHOLDER_ABN,
    purchaseOrderNumber: extraction.purchaseOrderNumber,
    workOrderRef: extraction.workOrderRef ?? null,
    invoiceDate: extraction.invoiceDate ?? null,
    dueDate: extraction.dueDate ?? null,
    paymentTermsDays: extraction.paymentTermsDays ?? null,
    totalAmount: extraction.totalAmount,
    confidence: 1,
  };
}

async function runOne(invoiceCase: ClientDummyInvoice, offline: boolean): Promise<Row> {
  const path = join(REPO_ROOT, invoiceCase.pdf);
  const filename = basename(path);
  const context = { messageId: `sample:${filename}` };
  const expected = invoiceCase.expected;
  const notes: string[] = [];

  const row: Row = {
    label: invoiceCase.label,
    supplierRead: "—",
    poRead: "—",
    invoiceTotal: "—",
    workOrderCost: "—",
    expected: describeOutcome(expected.outcome, expected.reason),
    actual: "—",
    pass: false,
    notes,
  };

  const extraction = offline
    ? fixtureExtraction(invoiceCase)
    : await extractInvoiceFields(readFileSync(path), filename, context);
  if (!extraction) {
    row.actual = "extraction did not parse";
    return row;
  }

  // The same two interpretations driveInvoice applies before matching. Mirrored
  // here rather than skipped, because they are exactly what decides two of these
  // six: 369.pdf prints its PO under "WO No:" so the model returns it in
  // workOrderRef, and 26.pdf prints terms instead of a due date.
  const purchaseOrder = choosePurchaseOrder(
    extraction.purchaseOrderNumber,
    extraction.workOrderRef ?? null,
  );
  const dueDate = resolveDueDate(
    extraction.invoiceDate ?? null,
    extraction.dueDate ?? null,
    extraction.paymentTermsDays ?? null,
  );

  row.supplierRead = extraction.supplierName ?? "null";
  row.poRead =
    purchaseOrder.source === "work_order_ref"
      ? `${purchaseOrder.value} (from WO ref)`
      : (purchaseOrder.value ?? "null");
  row.invoiceTotal =
    extraction.totalAmount === null ? "null" : money(dollarsToCents(extraction.totalAmount));

  // The same gate driveInvoice applies before matching. Worth mirroring: these
  // PDFs carry a "DUMMY INVOICE - FOR SYSTEM TESTING ONLY" banner, which could
  // plausibly depress the model's confidence below the threshold.
  if (extraction.confidence < EXTRACTION_CONFIDENCE_THRESHOLD) {
    row.actual = describeOutcome("unreadable");
    notes.push(
      `confidence ${extraction.confidence} < EXTRACTION_CONFIDENCE_THRESHOLD ${EXTRACTION_CONFIDENCE_THRESHOLD}`,
    );
    return row;
  }

  // Extraction is what the model read; these are what it SHOULD have read.
  if (extraction.supplierName !== invoiceCase.extraction.supplierName) {
    notes.push(
      `supplier misread: got "${extraction.supplierName}", expected "${invoiceCase.extraction.supplierName}"` +
        ` (the "Attention:" line on this invoice is a decoy)`,
    );
  }
  // Compared against the PO the pipeline ends up USING, so an invoice whose PO
  // legitimately arrives via workOrderRef is not reported as a misread.
  const expectedPo =
    invoiceCase.expected.purchaseOrderUsed ?? invoiceCase.extraction.purchaseOrderNumber;
  if (purchaseOrder.value !== expectedPo) {
    notes.push(`PO misread: got "${purchaseOrder.value}", expected "${expectedPo}"`);
  }
  if (extraction.totalAmount !== invoiceCase.extraction.totalAmount) {
    notes.push(
      `total misread: got ${extraction.totalAmount}, expected ${invoiceCase.extraction.totalAmount}`,
    );
  }
  // Not used by decideMatch, but this script is the only place a real model read
  // of paymentTermsDays gets checked — and without a due date the invoice cannot
  // be written to Prime at all.
  if (invoiceCase.expected.dueDate && dueDate.value !== invoiceCase.expected.dueDate) {
    notes.push(
      `due date resolved to "${dueDate.value}" (${dueDate.source}), expected "${invoiceCase.expected.dueDate}"`,
    );
  }

  const decision = await decideMatch(
    {
      purchaseOrderNumber: purchaseOrder.value,
      supplierAbn: extraction.supplierAbn,
      supplierName: extraction.supplierName,
      totalAmountCents:
        extraction.totalAmount === null ? 0 : dollarsToCents(extraction.totalAmount),
    },
    context,
  );

  row.workOrderCost = money(decision.matchResult.workOrderCostCents);
  row.actual = describeOutcome(
    decision.outcome,
    decision.outcome === "exception" ? decision.reason : undefined,
  );

  if (decision.outcome !== expected.outcome) {
    notes.push(`outcome mismatch`);
  } else if (decision.outcome === "exception" && decision.reason !== expected.reason) {
    notes.push(`flagged for "${decision.reason}", expected "${expected.reason}"`);
  }

  // The decisive assertion for invoice 2: costMismatch is produced whether the
  // model read "Tobey Chan" or the "Ryan Smith" on its Attention line, so only
  // the resolved contact tells the two apart.
  const contactId = decision.matchResult.supplierContactId ?? null;
  if (contactId !== (expected.contactId ?? null)) {
    notes.push(`resolved contact "${contactId}", expected "${expected.contactId ?? null}"`);
  }
  if ((decision.matchResult.workOrderId ?? null) !== (expected.workOrderId ?? null)) {
    notes.push(
      `resolved work order "${decision.matchResult.workOrderId ?? null}", expected "${expected.workOrderId ?? null}"`,
    );
  }
  if (decision.matchResult.supplierMatchStatus !== expected.supplierMatchStatus) {
    notes.push(
      `supplier match status "${decision.matchResult.supplierMatchStatus}", expected "${expected.supplierMatchStatus}"`,
    );
  }

  row.pass = notes.length === 0;
  return row;
}

function printTable(rows: Row[]): void {
  const headers = [
    "invoice",
    "supplier read",
    "PO read",
    "invoice total",
    "WO cost",
    "expected",
    "actual",
    "result",
  ];
  const body = rows.map((r) => [
    r.label,
    r.supplierRead,
    r.poRead,
    r.invoiceTotal,
    r.workOrderCost,
    r.expected,
    r.actual,
    r.pass ? "PASS" : "FAIL",
  ]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((cells) => cells[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd();

  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const cells of body) {
    console.log(line(cells));
  }
}

async function main(): Promise<void> {
  const offline = process.argv.slice(2).includes("--offline");

  const fake = await startFakePrime({
    workOrders: PRIME_WORK_ORDERS,
    contacts: PRIME_CONTACTS,
    purchaseOrderField: process.env.PRIME_WORK_ORDER_PO_FIELD!,
  });
  process.env.PRIME_BASE_URL = fake.baseUrl;

  try {
    const env = loadEnv();

    // PRIME_DRY_RUN gates writes only — reads go straight out. If the override
    // above ever fails to land (a stale cached env, a future module-scope
    // loadEnv), this script would search PRODUCTION Prime for PO99999. Refuse.
    const { hostname } = new URL(env.PRIME_BASE_URL);
    if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) {
      throw new Error(
        `refusing to run: PRIME_BASE_URL must be loopback for this script, got "${hostname}"`,
      );
    }

    // docs/ is gitignored, so the client's PDFs are not in a fresh clone. Say so
    // plainly rather than dying on an ENOENT three frames deep.
    const missing = CLIENT_DUMMY_INVOICES.map((i) => i.pdf).filter(
      (pdf) => !existsSync(join(REPO_ROOT, pdf)),
    );
    if (missing.length > 0) {
      throw new Error(
        `missing sample PDF(s):\n  ${missing.join("\n  ")}\n` +
          `docs/ is gitignored — get these from the client / shared drive and drop them in docs/.`,
      );
    }

    runMigrations();

    console.log(
      `extraction:   ${offline ? "OFFLINE — fixture values, model NOT called" : `live via OpenRouter (${env.OPENROUTER_MODEL})`}`,
    );
    console.log(`cost field:   ${env.COST_FIELD}`);
    console.log(`tolerance:    ${env.COST_TOLERANCE_MODE} ${env.COST_TOLERANCE_VALUE}`);
    console.log(`prime:        ${env.PRIME_BASE_URL} (fake, in-process)`);
    console.log(`graph:        not called at all\n`);
    if (offline) {
      console.log(
        "NOTE: --offline proves the matching/decision half only. It cannot tell you\n" +
          "      whether the model reads the PDFs correctly — run without the flag for that.\n",
      );
    }

    const rows: Row[] = [];
    for (const invoiceCase of CLIENT_DUMMY_INVOICES) {
      rows.push(await runOne(invoiceCase, offline));
    }

    printTable(rows);

    const failures = rows.filter((r) => !r.pass);
    for (const row of rows) {
      if (row.notes.length > 0) {
        console.log(`\n${row.label}:`);
        for (const note of row.notes) {
          console.log(`  - ${note}`);
        }
      }
    }

    // The synthetic three print the placeholder ABN "00 000 000 000" under two
    // DIFFERENT supplier names. If it were ever used as a key they would all
    // resolve to whichever contact carries it. The real three do query by ABN —
    // that is the only thing that resolves them — so the check is specifically
    // that the PLACEHOLDER never became a key, in any format.
    const abnQueries = fake.requests.filter((r) => {
      if (!r.q?.startsWith("'abn'.eq(")) return false;
      const value = /^'abn'\.eq\('(.*)'\)$/.exec(r.q)?.[1] ?? "";
      return value.replace(/\D/g, "") === "00000000000";
    });
    console.log(`\nPrime queries sent (${fake.requests.length}):`);
    for (const request of fake.requests) {
      console.log(`  ${request.method} ${request.path}${request.q ? `  q=${request.q}` : ""}` +
        (request.q ? `  -> ${request.matchCount} match(es)` : ""));
    }
    if (abnQueries.length > 0) {
      console.log(
        `\nFAIL: ${abnQueries.length} query used the placeholder ABN as a key — abn.ts should have rejected it.`,
      );
    }

    const ok = failures.length === 0 && abnQueries.length === 0;
    console.log(
      `\n${ok ? "PASS" : "FAIL"}: ${rows.length - failures.length}/${rows.length} invoices routed as expected.`,
    );
    if (!ok) {
      process.exitCode = 1;
    }
  } finally {
    await fake.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
