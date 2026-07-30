/**
 * Purges local pipeline state for a set of test invoices so the SAME emails can
 * be run end to end again from scratch — NOT part of `npm test`.
 *
 * Touches the local SQLite DB only: no Prime call, no Graph call, no mailbox.
 * It does not (and cannot) undo anything already written to Prime — if a live
 * run created AP invoices, those are Builderwest's to clean up in Prime and Xero.
 *
 * WHY THIS EXISTS RATHER THAN JUST DRAGGING THE EMAIL TO Retry.
 *
 * The Retry folder is the right tool for a genuine retry, but it is the WRONG
 * tool for re-running an invoice that was already driven to a terminal stage by a
 * DRY RUN. handleRetryFolderMessage calls resetForRetry, which sees a non-null
 * prime_ap_invoice_id and — correctly, to avoid duplicating a payable — resets to
 * 'ap_created' rather than 'received'. After a dry run that id is a placeholder
 * (`dryrun-ap-invoice-…`). So with PRIME_DRY_RUN=false the next tick would resume
 * at 'ap_created' and try to APPROVE a Prime record that does not exist, having
 * never uploaded the attachment or created the real AP invoice. The invoice looks
 * processed and nothing reached Prime.
 *
 * Deleting the rows outright is what makes the dry-run -> live transition clean:
 * the message becomes an unseen message again, and processMessage starts it at
 * 'received' with no stale Prime ids to resume onto.
 *
 * audit_log is never touched. It is append-only and it is the record of what the
 * earlier runs did; this script adds its own `pipeline.test_state_reset` row so
 * the purge itself is on the trail too.
 *
 * PREVIEW BY DEFAULT. Nothing is deleted without --confirm.
 *
 * Usage:
 *   npm run reset:test-invoices                      # preview the default three POs
 *   npm run reset:test-invoices -- --confirm         # actually purge them
 *   npm run reset:test-invoices -- PO21340 --confirm # specific POs
 *   npm run reset:test-invoices -- --all --confirm   # every invoice row (clean slate)
 *
 * AFTER RUNNING IT, the Outlook side still needs doing: the emails are sitting in
 * Processed/ or Exceptions/ from the last run, and the Inbox poll is
 * checkpoint-filtered, so move them into the Retry folder — that folder is listed
 * in full every tick. This script prints the message ids to look for.
 */
import { runMigrations } from "../src/db/migrate.js";
import { getDb } from "../src/db/client.js";
import { appendAuditLog } from "../src/db/repositories/auditLog.js";
import { purchaseOrderCandidates } from "../src/lib/matching/purchaseOrder.js";

/** The three real-supplier invoices on test claim BWC-WA-6797. */
const DEFAULT_PURCHASE_ORDERS = ["PO21343", "PO21342", "PO21340"] as const;

interface InvoiceStateRow {
  id: number;
  message_id: string;
  stage: string;
  exception_reason: string | null;
  extracted_purchase_order_number: string | null;
  extracted_invoice_number: string | null;
  prime_work_order_id: string | null;
  prime_attachment_id: string | null;
  prime_ap_invoice_id: string | null;
}

/**
 * Selects by PO in every format the PO-prefix bridge accepts, not just the one
 * printed on the invoice — an invoice whose work order resolved via the bare
 * `21343` label still stored whatever the model read, and a reset that missed it
 * would leave the row behind and silently skip that invoice on the re-run.
 */
function findByPurchaseOrders(purchaseOrders: readonly string[]): InvoiceStateRow[] {
  const wanted = new Set<string>();
  for (const po of purchaseOrders) {
    const candidates = purchaseOrderCandidates(po);
    wanted.add(candidates.printed);
    for (const label of candidates.labels) {
      wanted.add(label);
    }
  }

  const placeholders = [...wanted].map(() => "?").join(", ");
  return getDb()
    .prepare<string[], InvoiceStateRow>(
      `SELECT id, message_id, stage, exception_reason, extracted_purchase_order_number,
              extracted_invoice_number, prime_work_order_id, prime_attachment_id,
              prime_ap_invoice_id
         FROM invoices
        WHERE extracted_purchase_order_number IN (${placeholders})
        ORDER BY id`,
    )
    .all(...wanted);
}

function findAll(): InvoiceStateRow[] {
  return getDb()
    .prepare<[], InvoiceStateRow>(
      `SELECT id, message_id, stage, exception_reason, extracted_purchase_order_number,
              extracted_invoice_number, prime_work_order_id, prime_attachment_id,
              prime_ap_invoice_id
         FROM invoices
        ORDER BY id`,
    )
    .all();
}

function main(): void {
  const args = process.argv.slice(2);
  const confirm = args.includes("--confirm");
  const all = args.includes("--all");
  const purchaseOrders = args.filter((arg) => !arg.startsWith("--"));

  runMigrations();

  const rows = all
    ? findAll()
    : findByPurchaseOrders(purchaseOrders.length > 0 ? purchaseOrders : DEFAULT_PURCHASE_ORDERS);

  const scope = all
    ? "ALL invoice rows"
    : `POs: ${(purchaseOrders.length > 0 ? purchaseOrders : DEFAULT_PURCHASE_ORDERS).join(", ")}`;
  console.log(`scope: ${scope}`);

  if (rows.length === 0) {
    console.log("\nNothing to reset — no invoices row matches. Already clean.");
    return;
  }

  const invoiceIds = rows.map((row) => row.id);
  const messageIds = [...new Set(rows.map((row) => row.message_id))];

  console.log(`\n${rows.length} invoice row(s) in scope:\n`);
  for (const row of rows) {
    const dryRunIds = [row.prime_attachment_id, row.prime_ap_invoice_id].filter((id) =>
      id?.startsWith("dryrun-"),
    );
    console.log(
      `  #${row.id}  ${row.extracted_purchase_order_number ?? "(no PO)"}  ` +
        `invoice ${row.extracted_invoice_number ?? "?"}  ` +
        `stage=${row.stage}${row.exception_reason ? `:${row.exception_reason}` : ""}`,
    );
    console.log(`        message ${row.message_id}`);
    if (row.prime_ap_invoice_id) {
      console.log(
        `        prime AP invoice ${row.prime_ap_invoice_id}` +
          (dryRunIds.length > 0
            ? "  <- DRY-RUN PLACEHOLDER (this is what makes a Retry-only reset unsafe)"
            : "  <- REAL PRIME RECORD: cleaning this up in Prime is a separate, manual job"),
      );
    }
  }

  const matchResultCount = getDb()
    .prepare<number[], { c: number }>(
      `SELECT COUNT(*) c FROM match_results WHERE invoice_id IN (${invoiceIds.map(() => "?").join(", ")})`,
    )
    .get(...invoiceIds)!.c;

  console.log(
    `\nwould delete: ${rows.length} invoices, ${matchResultCount} match_results, ` +
      `${messageIds.length} processed_messages  (audit_log untouched)`,
  );

  if (!confirm) {
    console.log("\nPREVIEW ONLY — nothing deleted. Re-run with --confirm to apply.");
    return;
  }

  const db = getDb();
  const purge = db.transaction(() => {
    const invoicePlaceholders = invoiceIds.map(() => "?").join(", ");
    // match_results.invoice_id has a FK to invoices(id) and foreign_keys=ON, so
    // the children go first.
    db.prepare(`DELETE FROM match_results WHERE invoice_id IN (${invoicePlaceholders})`).run(
      ...invoiceIds,
    );
    db.prepare(`DELETE FROM invoices WHERE id IN (${invoicePlaceholders})`).run(...invoiceIds);
    // Removing the row entirely (rather than setting cleared_at) also drops these
    // messages out of the poll checkpoint, which is the safe direction: at worst
    // the Inbox gets re-listed further back.
    db.prepare(
      `DELETE FROM processed_messages WHERE message_id IN (${messageIds.map(() => "?").join(", ")})`,
    ).run(...messageIds);
  });
  purge();

  // invoiceId is deliberately left null — those rows no longer exist, so pointing
  // at them would be a dangling reference. The ids live in the detail instead.
  appendAuditLog({
    eventType: "pipeline.test_state_reset",
    detail: { scope, invoiceIds, messageIds, matchResultCount },
  });

  console.log("\nDone. Local state purged.");
  console.log("\nNEXT, in Outlook — get these messages back where the poll will see them:");
  for (const row of rows) {
    console.log(`  ${row.extracted_purchase_order_number ?? "(no PO)"}  ${row.message_id}`);
  }
  // Two routes, and the trade-off is worth stating rather than picking for the
  // operator. With processed_messages purged there is no checkpoint, so the Inbox
  // poll falls back to a 24h lookback on receivedDateTime — which a MOVE does not
  // change. So the Inbox route is the truer rehearsal of production but expires;
  // the Retry folder is listed in full every tick and never expires.
  console.log("\n  INBOX  — the real production path (checkpoint-filtered poll ->");
  console.log("           processMessage). Truest rehearsal, but only works while the");
  console.log("           messages are inside the 24h first-run lookback: moving a");
  console.log("           message does not change its receivedDateTime. Re-send them as");
  console.log("           fresh mail if the window has passed.");
  console.log("  RETRY  — listed in full every tick, so it always works regardless of age,");
  console.log("           but it exercises handleRetryFolderMessage rather than the plain");
  console.log("           inbox path.");
  console.log("\nThen trigger a run: npm run tick:once");
}

try {
  main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
