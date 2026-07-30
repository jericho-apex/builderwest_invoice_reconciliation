/**
 * READ-ONLY production Prime discovery — NOT part of `npm test`.
 *
 * There is no Prime sandbox, so the only way to learn what a work order or
 * contact actually holds is to ask production. This script does that and nothing
 * else: it issues GETs, prints what came back, and writes no Prime record. It is
 * the tool that retired the invented $605.00 placeholder from the fixtures, and
 * the same rule applies to every new fixture — discover first, invent nothing.
 *
 * What it answers, for a set of purchase orders and supplier names:
 *
 *   1. Does a work order exist for each PO, and under which LABEL FORMAT
 *      (`PO21343` vs a bare `21343`)? That is the live check on the PO-prefix
 *      bridge in matching/purchaseOrder.ts.
 *   2. What are its `costTotal` / `costTaxTotal`? Their sum is the inc-GST figure
 *      cost matching compares an invoice total against, so this — not the PDF —
 *      decides approve vs costMismatch.
 *   3. Its `jobId` and `assignedId`, the latter feeding the supplier tie-break.
 *   4. Do the suppliers exist as contacts, and is `abn` stored digits-only or
 *      formatted? resolveSupplier normalizes to digits before querying, so a
 *      formatted value in Prime means the ABN lookup misses and the name lookup
 *      carries the match instead. Either is fine — the fixture must pin whichever
 *      is true.
 *
 * Usage:
 *   npm run discover:prime                      # the three new test invoices
 *   npm run discover:prime -- PO21340 PO21342   # specific POs
 *   npm run discover:prime -- --ap-invoices     # the AP-invoice status model
 *   npm run discover:prime -- --ap <id>         # one AP invoice, every field
 *   npm run discover:prime -- --verify          # AFTER a run: did the writes land?
 *
 * It runs migrations first because the Prime finders append audit_log rows.
 */
import { runMigrations } from "../src/db/migrate.js";
import { getDb } from "../src/db/client.js";
import { loadEnv } from "../src/config/env.js";
import { primeRequest } from "../src/lib/prime/httpClient.js";
import { buildEqQuery } from "../src/lib/prime/query.js";
import { purchaseOrderCandidates } from "../src/lib/matching/purchaseOrder.js";
import { normalizeAbn, isValidAbn } from "../src/lib/matching/abn.js";

/** The three real-supplier invoices Builderwest sent on 2026-07-29, all on claim BWC-WA-6797. */
const NEW_TEST_INVOICES = [
  { pdf: "26.pdf", po: "PO21343", supplier: "Hutchy Ceilings Pty Ltd", abn: "68 628 819 741" },
  { pdf: "369.pdf", po: "PO21342", supplier: "Beale4", abn: "3910 8785 824" },
  { pdf: "invoice_300.pdf", po: "PO21340", supplier: "Rare Electrical PTY LTD", abn: "23 676 709 185" },
] as const;

interface ApiRow {
  id: string;
  attributes?: Record<string, unknown>;
}

async function findBy(resource: string, field: string, value: string): Promise<ApiRow[]> {
  const q = buildEqQuery(field, value);
  try {
    const response = await primeRequest<{ data?: ApiRow[] }>({
      method: "GET",
      path: resource,
      query: { q },
    });
    return response.data ?? [];
  } catch (error) {
    console.log(`      ! ${resource}?q=${q} failed: ${String(error)}`);
    return [];
  }
}

/** Only the fields any of this project's decisions actually turn on. */
function summarizeWorkOrder(row: ApiRow) {
  const a = row.attributes ?? {};
  const costTotal = Number(a.costTotal ?? 0);
  const costTaxTotal = Number(a.costTaxTotal ?? 0);
  return {
    id: row.id,
    label: a.label,
    costTotal: a.costTotal,
    costTaxTotal: a.costTaxTotal,
    incGstTotal: (Math.round(costTotal * 100) + Math.round(costTaxTotal * 100)) / 100,
    jobId: a.jobId,
    assignedId: a.assignedId,
  };
}

function summarizeContact(row: ApiRow) {
  const a = row.attributes ?? {};
  return { id: row.id, name: a.name, abn: a.abn, contactType: a.contactType, email: a.email };
}

async function reportPurchaseOrder(po: string, poField: string): Promise<void> {
  const { labels } = purchaseOrderCandidates(po);
  console.log(`\n  PO ${po}  (candidate labels: ${labels.join(", ")})`);

  const seen = new Map<string, ApiRow>();
  for (const label of labels) {
    const rows = await findBy("/work-orders", poField, label);
    console.log(`    '${poField}'.eq('${label}') -> ${rows.length} row(s)`);
    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.set(row.id, row);
      }
    }
  }

  if (seen.size === 0) {
    console.log("    => NOT FOUND — this invoice would route to Exceptions/No work order");
    return;
  }
  if (seen.size > 1) {
    console.log(`    => AMBIGUOUS (${seen.size} distinct work orders) — routes to a human`);
  }
  for (const row of seen.values()) {
    console.log(`    => ${JSON.stringify(summarizeWorkOrder(row))}`);
  }
}

async function reportSupplier(name: string, printedAbn: string): Promise<void> {
  console.log(`\n  Supplier "${name}"  (ABN as printed: ${printedAbn})`);

  const digits = normalizeAbn(printedAbn);
  if (!isValidAbn(digits)) {
    console.log(`    ABN ${digits} fails the checksum — resolveSupplier would skip the ABN lookup`);
  } else {
    // Both spellings, because which one Prime stores decides whether the ABN
    // lookup can ever hit. resolveSupplier only ever sends the digits form.
    for (const candidate of [digits, printedAbn.trim()]) {
      const rows = await findBy("/contacts", "abn", candidate);
      console.log(`    'abn'.eq('${candidate}') -> ${rows.length} row(s)`);
      for (const row of rows) {
        console.log(`      ${JSON.stringify(summarizeContact(row))}`);
      }
    }
  }

  const byName = await findBy("/contacts", "name", name);
  console.log(`    'name'.eq('${name}') -> ${byName.length} row(s)`);
  for (const row of byName) {
    console.log(`      ${JSON.stringify(summarizeContact(row))}`);
  }
  if (byName.length > 1) {
    console.log("      NOTE: several — the name lookup alone cannot resolve this supplier");
  }
}

/**
 * The AP-invoice status model, which is the last unproven thing on the live path
 * (prime-api-gaps Q6): does reaching `approvalStatus: "Approved"` drive Prime's
 * Xero push, or does it only fire at `accountsPayableInvoiceStatus: "Paid"`?
 *
 * Read-only. Prints the status/sync combinations that actually exist in
 * production, which is the strongest evidence available without writing: if any
 * record is `isSynced: true` while short of "Paid", then Approved is enough.
 */
async function reportApInvoiceStatuses(): Promise<void> {
  const response = await primeRequest<{ data?: ApiRow[] }>({
    method: "GET",
    path: "/accounts-payable-invoices",
    query: { limit: "50" },
  });
  const rows = response.data ?? [];
  console.log(`\n  ${rows.length} AP invoice(s) read.\n`);

  // What a status field is called matters less than which combinations exist.
  const combos = new Map<string, number>();
  for (const row of rows) {
    const a = row.attributes ?? {};
    const key = JSON.stringify({
      approvalStatus: a.approvalStatus ?? null,
      accountsPayableInvoiceStatus: a.accountsPayableInvoiceStatus ?? null,
      isSynced: a.isSynced ?? null,
      syncedFinanceSystemName: a.syncedFinanceSystemName ?? null,
    });
    combos.set(key, (combos.get(key) ?? 0) + 1);
  }

  console.log("  status combinations present in production:");
  for (const [key, count] of [...combos.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${count.toString().padStart(3)} x  ${key}`);
  }

  const synced = rows.filter((r) => r.attributes?.isSynced === true);
  const syncedNotPaid = synced.filter(
    (r) => r.attributes?.accountsPayableInvoiceStatus !== "Paid",
  );
  console.log(
    `\n  synced: ${synced.length}/${rows.length}; of those, ${syncedNotPaid.length} are NOT "Paid".`,
  );
  console.log(
    syncedNotPaid.length > 0
      ? '  => a record can be synced without reaching "Paid", so Approved is enough.'
      : '  => every synced record is "Paid" — Approved alone may not drive the push.',
  );

  // Whether workOrderId survives a create is the other open question (Q9), and
  // existing records are the read-only way to see whether it is stored at all.
  const withWorkOrder = rows.filter((r) => r.attributes?.workOrderId);
  console.log(
    `\n  carry a workOrderId: ${withWorkOrder.length}/${rows.length}` +
      (withWorkOrder.length > 0 ? " => the field IS stored on this resource." : ""),
  );

  const sample = rows[0];
  if (sample) {
    console.log(`\n  field names on a sample record (${sample.id}):`);
    console.log(`    ${Object.keys(sample.attributes ?? {}).sort().join(", ")}`);
  }
}

interface LocalInvoiceRow {
  id: number;
  stage: string;
  exception_reason: string | null;
  extracted_purchase_order_number: string | null;
  extracted_invoice_number: string | null;
  extracted_total_amount_cents: number | null;
  prime_work_order_id: string | null;
  prime_job_id: string | null;
  prime_contact_id: string | null;
  prime_attachment_id: string | null;
  prime_ap_invoice_id: string | null;
}

/**
 * POST-RUN VERIFICATION: did what the pipeline THINKS it wrote actually land in
 * Prime, and land correctly?
 *
 * Every other mode in this script asks Prime what it holds. This one starts from
 * the local `invoices` rows — the pipeline's own claims — and checks each against
 * production. That direction matters: reading Prime alone cannot tell you an
 * invoice was skipped, and reading SQLite alone cannot tell you a write silently
 * didn't take. Only the comparison answers "did it work".
 *
 * Still GETs only. It never cleans anything up — deleting or voiding a test AP
 * invoice in Prime is Builderwest's job, not this script's.
 */
async function verifyAgainstLocalState(): Promise<void> {
  const rows = getDb()
    .prepare<[], LocalInvoiceRow>(
      `SELECT id, stage, exception_reason, extracted_purchase_order_number,
              extracted_invoice_number, extracted_total_amount_cents, prime_work_order_id,
              prime_job_id, prime_contact_id, prime_attachment_id, prime_ap_invoice_id
         FROM invoices ORDER BY id`,
    )
    .all();

  if (rows.length === 0) {
    console.log("\n  No local invoices rows — nothing has run yet.");
    return;
  }

  let checked = 0;
  let passed = 0;

  for (const row of rows) {
    const label = `#${row.id} ${row.extracted_purchase_order_number ?? "(no PO)"} invoice ${row.extracted_invoice_number ?? "?"}`;
    const stage = `${row.stage}${row.exception_reason ? `:${row.exception_reason}` : ""}`;
    console.log(`\n  ${label}  local stage=${stage}`);

    if (!row.prime_ap_invoice_id) {
      console.log("    no AP invoice recorded — stopped before the write path. Nothing to verify.");
      console.log(`    (expected for an exception; this one is ${stage})`);
      continue;
    }

    if (row.prime_ap_invoice_id.startsWith("dryrun-")) {
      console.log(`    ${row.prime_ap_invoice_id}`);
      console.log("    DRY-RUN PLACEHOLDER — nothing was written to Prime, so nothing to check.");
      continue;
    }

    checked += 1;
    let record: ApiRow | undefined;
    try {
      const response = await primeRequest<{ data?: ApiRow }>({
        method: "GET",
        path: `/accounts-payable-invoices/${row.prime_ap_invoice_id}`,
      });
      record = response.data;
    } catch (error) {
      console.log(`    GET /accounts-payable-invoices/${row.prime_ap_invoice_id} FAILED:`);
      console.log(`      ${String(error)}`);
      console.log("    => the id we persisted does not resolve in Prime. Investigate before rerunning.");
      continue;
    }

    const a = record?.attributes ?? {};
    console.log(`    prime record ${row.prime_ap_invoice_id}`);
    console.log(
      `      ${JSON.stringify({
        invoiceNumber: a.invoiceNumber,
        amount: a.amount,
        taxTotal: a.taxTotal,
        approvalStatus: a.approvalStatus,
        accountsPayableInvoiceStatus: a.accountsPayableInvoiceStatus,
        isSynced: a.isSynced,
        workOrderId: a.workOrderId,
        jobId: a.jobId,
        version: a.version,
        createdAt: a.createdAt,
      })}`,
    );

    // The four things a live write has to get right. Checked explicitly rather
    // than left to the reader, because "a record came back" is not the question.
    const expectedAmount = row.extracted_total_amount_cents;
    const actualAmountCents =
      a.amount === undefined || a.amount === null ? null : Math.round(Number(a.amount) * 100);

    const checks: Array<[string, boolean, string]> = [
      [
        "amount is the inc-GST invoice total",
        expectedAmount !== null && actualAmountCents === expectedAmount,
        `expected ${expectedAmount === null ? "?" : (expectedAmount / 100).toFixed(2)}, got ${String(a.amount)}`,
      ],
      [
        "workOrderId survived the create (prime-api-gaps Q9)",
        typeof a.workOrderId === "string" && a.workOrderId === row.prime_work_order_id,
        `expected ${row.prime_work_order_id}, got ${String(a.workOrderId)}`,
      ],
      [
        "jobId matches the matched work order's job",
        typeof a.jobId === "string" && a.jobId === row.prime_job_id,
        `expected ${row.prime_job_id}, got ${String(a.jobId)}`,
      ],
      [
        "approvalStatus is Approved",
        a.approvalStatus === "Approved",
        `got ${String(a.approvalStatus)}`,
      ],
    ];

    let allPassed = true;
    for (const [what, ok, detail] of checks) {
      console.log(`      ${ok ? "PASS" : "FAIL"}  ${what}${ok ? "" : ` — ${detail}`}`);
      allPassed = allPassed && ok;
    }
    if (allPassed) {
      passed += 1;
    }

    // Not a failure: the pipeline deliberately stops at approved and Builderwest's
    // finance process owns the Xero push (prime-api-gaps Q6). Printed so an
    // unsynced record is never mistaken for a broken run.
    if (a.isSynced !== true) {
      console.log(
        "      note  not synced to Xero — EXPECTED. The pipeline stops at approved by design.",
      );
    }

    console.log(`      attachment ${row.prime_attachment_id ?? "(none)"} — check it on Prime job ${row.prime_job_id ?? "?"}`);
  }

  console.log(`\n  ${passed}/${checked} live AP invoice(s) fully verified.`);
  if (checked === 0) {
    console.log("  (nothing live to verify — the last run was a dry run)");
  }
}

/**
 * Cross-check from Prime's side: every AP invoice currently attached to the test
 * work orders. This is what catches DUPLICATES — two records for one invoice
 * because a run was repeated without resetting local state — which the
 * local-state check above cannot see, since SQLite only remembers the last id.
 */
async function reportApInvoicesForWorkOrder(po: string, poField: string): Promise<void> {
  const { labels } = purchaseOrderCandidates(po);
  const workOrders = new Map<string, ApiRow>();
  for (const label of labels) {
    for (const row of await findBy("/work-orders", poField, label)) {
      workOrders.set(row.id, row);
    }
  }

  for (const workOrder of workOrders.values()) {
    const apInvoices = await findBy("/accounts-payable-invoices", "workOrderId", workOrder.id);
    console.log(`\n  ${po} -> work order ${workOrder.id}: ${apInvoices.length} AP invoice(s)`);
    for (const row of apInvoices) {
      const a = row.attributes ?? {};
      console.log(
        `    ${JSON.stringify({
          id: row.id,
          invoiceNumber: a.invoiceNumber,
          amount: a.amount,
          approvalStatus: a.approvalStatus,
          accountsPayableInvoiceStatus: a.accountsPayableInvoiceStatus,
          isSynced: a.isSynced,
          createdAt: a.createdAt,
        })}`,
      );
    }
    if (apInvoices.length > 1) {
      console.log("    WARNING: more than one — check for a duplicate from a repeated run.");
    }
  }
}

/** Every field of one AP invoice — used to verify a live write round-tripped. */
async function reportOneApInvoice(id: string): Promise<void> {
  const response = await primeRequest<{ data?: ApiRow }>({
    method: "GET",
    path: `/accounts-payable-invoices/${id}`,
  });
  console.log(`\n  ${id}:\n${JSON.stringify(response.data, null, 2)}`);
}

async function main(): Promise<void> {
  runMigrations();
  const env = loadEnv();

  console.log("Prime discovery — READ ONLY, no write endpoint is called.");
  console.log(`  base url: ${env.PRIME_BASE_URL}`);
  console.log(`  PO field: ${env.PRIME_WORK_ORDER_PO_FIELD}`);
  console.log(`  dry run:  ${env.PRIME_DRY_RUN} (irrelevant here — every call below is a GET)`);

  const args = process.argv.slice(2);
  const explicitPos = args.filter((arg) => !arg.startsWith("--"));

  if (args.includes("--ap-invoices")) {
    console.log("\n=== AP-invoice status model (prime-api-gaps Q6/Q9) ===");
    await reportApInvoiceStatuses();
    console.log("\nDone. Nothing was written to Prime.");
    return;
  }

  const apIndex = args.indexOf("--ap");
  if (apIndex !== -1 && args[apIndex + 1]) {
    await reportOneApInvoice(args[apIndex + 1]!);
    console.log("\nDone. Nothing was written to Prime.");
    return;
  }

  if (args.includes("--verify")) {
    console.log("\n=== Local pipeline state vs. what Prime actually holds ===");
    await verifyAgainstLocalState();

    console.log("\n=== AP invoices attached to the test work orders (duplicate check) ===");
    const pos = explicitPos.length > 0 ? explicitPos : NEW_TEST_INVOICES.map((i) => i.po);
    for (const po of pos) {
      await reportApInvoicesForWorkOrder(po, env.PRIME_WORK_ORDER_PO_FIELD);
    }

    console.log("\nDone. Nothing was written to Prime — cleanup in Prime remains manual.");
    return;
  }

  if (explicitPos.length > 0) {
    for (const po of explicitPos) {
      await reportPurchaseOrder(po, env.PRIME_WORK_ORDER_PO_FIELD);
    }
    return;
  }

  console.log("\n=== Work orders for the three new test invoices ===");
  for (const invoice of NEW_TEST_INVOICES) {
    await reportPurchaseOrder(invoice.po, env.PRIME_WORK_ORDER_PO_FIELD);
  }

  console.log("\n=== Supplier contacts ===");
  for (const invoice of NEW_TEST_INVOICES) {
    await reportSupplier(invoice.supplier, invoice.abn);
  }

  console.log("\nDone. Nothing was written to Prime.");
}

await main();
