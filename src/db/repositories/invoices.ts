import { getDb } from "../client.js";
import type { ExceptionReason } from "../../config/constants.js";

// Note: classification (invoice / claim-instruction / job-note / other)
// happens BEFORE an invoices row is created at all — every row that exists
// has, by construction, already passed classification as "invoice", so
// there is no separate "classified" stage to persist.
// `approved` is the TERMINAL SUCCESS stage: the pipeline stops at approval and
// does not wait for Prime's Xero push — see the note above
// EXTRACTION_CONFIDENCE_THRESHOLD in config/constants.ts for why. The earlier
// `approved_pending_sync` and `synced` stages are gone with it.
export const STAGES = [
  "received",
  "extracted",
  "matched",
  "attachment_uploaded",
  "ap_created",
  "approved",
  "exception",
] as const;

export type Stage = (typeof STAGES)[number];

/** Stages reached only after at least one Prime write has already happened. */
const POST_WRITE_STAGES: ReadonlySet<Stage> = new Set([
  "attachment_uploaded",
  "ap_created",
  "approved",
]);

export interface ExtractedFields {
  supplierName?: string;
  supplierAbn?: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  dueDate?: string;
  exTaxAmountCents?: number;
  taxAmountCents?: number;
  totalAmountCents?: number;
  /** The only identifier work-order matching keys off — see matching/resolveWorkOrder.ts. */
  purchaseOrderNumber?: string;
  /** Captured for context and for the open `jobId` question; never used to match. */
  jobNumber?: string;
  workOrderRef?: string;
  confidence: number;
}

export interface InvoiceRecord {
  id: number;
  messageId: string;
  attachmentIndex: number;
  stage: Stage;
  extractedSupplierName: string | null;
  extractedSupplierAbn: string | null;
  extractedInvoiceNumber: string | null;
  extractedInvoiceDate: string | null;
  extractedDueDate: string | null;
  extractedExTaxAmountCents: number | null;
  extractedTaxAmountCents: number | null;
  extractedTotalAmountCents: number | null;
  extractedPurchaseOrderNumber: string | null;
  extractedJobNumber: string | null;
  extractedWorkOrderRef: string | null;
  extractionConfidence: number | null;
  primeWorkOrderId: string | null;
  /** The job the work order belongs to — required by both Prime write steps. */
  primeJobId: string | null;
  primeContactId: string | null;
  primeAttachmentId: string | null;
  primeApInvoiceId: string | null;
  isSynced: boolean;
  syncedFinanceSystemName: string | null;
  syncedFinanceSystemReference: string | null;
  syncAttemptCount: number;
  lastSyncCheckAt: string | null;
  exceptionReason: ExceptionReason | null;
  createdAt: string;
  updatedAt: string;
}

interface InvoiceRow {
  id: number;
  message_id: string;
  attachment_index: number;
  stage: string;
  extracted_supplier_name: string | null;
  extracted_supplier_abn: string | null;
  extracted_invoice_number: string | null;
  extracted_invoice_date: string | null;
  extracted_due_date: string | null;
  extracted_ex_tax_amount_cents: number | null;
  extracted_tax_amount_cents: number | null;
  extracted_total_amount_cents: number | null;
  extracted_purchase_order_number: string | null;
  extracted_job_number: string | null;
  extracted_work_order_ref: string | null;
  extraction_confidence: number | null;
  prime_work_order_id: string | null;
  prime_job_id: string | null;
  prime_contact_id: string | null;
  prime_attachment_id: string | null;
  prime_ap_invoice_id: string | null;
  is_synced: number;
  synced_finance_system_name: string | null;
  synced_finance_system_reference: string | null;
  sync_attempt_count: number;
  last_sync_check_at: string | null;
  exception_reason: string | null;
  created_at: string;
  updated_at: string;
}

function mapRow(row: InvoiceRow): InvoiceRecord {
  return {
    id: row.id,
    messageId: row.message_id,
    attachmentIndex: row.attachment_index,
    stage: row.stage as Stage,
    extractedSupplierName: row.extracted_supplier_name,
    extractedSupplierAbn: row.extracted_supplier_abn,
    extractedInvoiceNumber: row.extracted_invoice_number,
    extractedInvoiceDate: row.extracted_invoice_date,
    extractedDueDate: row.extracted_due_date,
    extractedExTaxAmountCents: row.extracted_ex_tax_amount_cents,
    extractedTaxAmountCents: row.extracted_tax_amount_cents,
    extractedTotalAmountCents: row.extracted_total_amount_cents,
    extractedPurchaseOrderNumber: row.extracted_purchase_order_number,
    extractedJobNumber: row.extracted_job_number,
    extractedWorkOrderRef: row.extracted_work_order_ref,
    extractionConfidence: row.extraction_confidence,
    primeWorkOrderId: row.prime_work_order_id,
    primeJobId: row.prime_job_id,
    primeContactId: row.prime_contact_id,
    primeAttachmentId: row.prime_attachment_id,
    primeApInvoiceId: row.prime_ap_invoice_id,
    isSynced: row.is_synced === 1,
    syncedFinanceSystemName: row.synced_finance_system_name,
    syncedFinanceSystemReference: row.synced_finance_system_reference,
    syncAttemptCount: row.sync_attempt_count,
    lastSyncCheckAt: row.last_sync_check_at,
    exceptionReason: row.exception_reason as ExceptionReason | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function touch(id: number): void {
  getDb()
    .prepare("UPDATE invoices SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?")
    .run(id);
}

/** Creates the invoice row for a new message/attachment pair, at stage 'received'. */
export function createInvoice(messageId: string, attachmentIndex = 0): number {
  const result = getDb()
    .prepare("INSERT INTO invoices (message_id, attachment_index) VALUES (?, ?)")
    .run(messageId, attachmentIndex);
  return Number(result.lastInsertRowid);
}

export function getInvoiceById(id: number): InvoiceRecord | undefined {
  const row = getDb()
    .prepare<[number], InvoiceRow>("SELECT * FROM invoices WHERE id = ?")
    .get(id);
  return row ? mapRow(row) : undefined;
}

export function getInvoiceByMessage(
  messageId: string,
  attachmentIndex = 0,
): InvoiceRecord | undefined {
  const row = getDb()
    .prepare<[string, number], InvoiceRow>(
      "SELECT * FROM invoices WHERE message_id = ? AND attachment_index = ?",
    )
    .get(messageId, attachmentIndex);
  return row ? mapRow(row) : undefined;
}

/** All invoice rows for a message (normally one per PDF attachment). */
export function getInvoicesByMessage(messageId: string): InvoiceRecord[] {
  const rows = getDb()
    .prepare<[string], InvoiceRow>(
      "SELECT * FROM invoices WHERE message_id = ? ORDER BY attachment_index ASC",
    )
    .all(messageId);
  return rows.map(mapRow);
}

/** Returns the existing row for this message/attachment pair, or creates a fresh one — makes per-attachment processing idempotent whether the message is brand new or reappearing after a retry. */
export function getOrCreateInvoice(messageId: string, attachmentIndex = 0): number {
  const existing = getInvoiceByMessage(messageId, attachmentIndex);
  return existing ? existing.id : createInvoice(messageId, attachmentIndex);
}

/**
 * Every invoice not yet at a terminal stage (synced or exception). Driven
 * once per worker tick, before polling for new messages — this is what
 * makes a crash mid-pipeline (at any stage) resumable: normal single-
 * threaded processing always drives an invoice to a terminal stage before
 * the tick ends, so anything found here on the next tick was orphaned by a
 * crash and needs to be re-driven from its persisted stage.
 */
export function getInFlightInvoices(): InvoiceRecord[] {
  const rows = getDb()
    .prepare<[], InvoiceRow>("SELECT * FROM invoices WHERE stage NOT IN ('approved', 'exception')")
    .all();
  return rows.map(mapRow);
}

export function setStage(id: number, stage: Stage): void {
  getDb().prepare("UPDATE invoices SET stage = ? WHERE id = ?").run(stage, id);
  touch(id);
}

export function setExtraction(id: number, fields: ExtractedFields): void {
  getDb()
    .prepare(
      `UPDATE invoices SET
         stage = 'extracted',
         extracted_supplier_name = @supplierName,
         extracted_supplier_abn = @supplierAbn,
         extracted_invoice_number = @invoiceNumber,
         extracted_invoice_date = @invoiceDate,
         extracted_due_date = @dueDate,
         extracted_ex_tax_amount_cents = @exTaxAmountCents,
         extracted_tax_amount_cents = @taxAmountCents,
         extracted_total_amount_cents = @totalAmountCents,
         extracted_purchase_order_number = @purchaseOrderNumber,
         extracted_job_number = @jobNumber,
         extracted_work_order_ref = @workOrderRef,
         extraction_confidence = @confidence
       WHERE id = @id`,
    )
    .run({
      id,
      supplierName: fields.supplierName ?? null,
      supplierAbn: fields.supplierAbn ?? null,
      invoiceNumber: fields.invoiceNumber ?? null,
      invoiceDate: fields.invoiceDate ?? null,
      dueDate: fields.dueDate ?? null,
      exTaxAmountCents: fields.exTaxAmountCents ?? null,
      taxAmountCents: fields.taxAmountCents ?? null,
      totalAmountCents: fields.totalAmountCents ?? null,
      purchaseOrderNumber: fields.purchaseOrderNumber ?? null,
      jobNumber: fields.jobNumber ?? null,
      workOrderRef: fields.workOrderRef ?? null,
      confidence: fields.confidence,
    });
  touch(id);
}

export function setResolvedMatch(
  id: number,
  match: { primeWorkOrderId?: string; primeJobId?: string; primeContactId?: string },
): void {
  getDb()
    .prepare(
      `UPDATE invoices SET
         stage = 'matched',
         prime_work_order_id = COALESCE(@primeWorkOrderId, prime_work_order_id),
         prime_job_id = COALESCE(@primeJobId, prime_job_id),
         prime_contact_id = COALESCE(@primeContactId, prime_contact_id)
       WHERE id = @id`,
    )
    .run({
      id,
      primeWorkOrderId: match.primeWorkOrderId ?? null,
      primeJobId: match.primeJobId ?? null,
      primeContactId: match.primeContactId ?? null,
    });
  touch(id);
}

export function setAttachmentUploaded(id: number, primeAttachmentId: string): void {
  getDb()
    .prepare(
      "UPDATE invoices SET stage = 'attachment_uploaded', prime_attachment_id = ? WHERE id = ?",
    )
    .run(primeAttachmentId, id);
  touch(id);
}

export function setApInvoiceCreated(id: number, primeApInvoiceId: string): void {
  getDb()
    .prepare("UPDATE invoices SET stage = 'ap_created', prime_ap_invoice_id = ? WHERE id = ?")
    .run(primeApInvoiceId, id);
  touch(id);
}

/**
 * Terminal success. The invoice is approved in Prime and the pipeline's work is
 * finished — Builderwest's finance process owns the Xero push from here.
 *
 * The `is_synced`, `sync_attempt_count`, `last_sync_check_at` and
 * `synced_finance_system_*` columns are left in place but are no longer written:
 * dropping columns in SQLite means rebuilding the table, and an unused column is
 * cheaper than that. What Prime reported when the AP invoice was read back after
 * approval lives in the `prime.read_back_ap_invoice` audit row instead.
 */
export function setApproved(id: number): void {
  setStage(id, "approved");
}

export function setException(id: number, reason: ExceptionReason): void {
  getDb()
    .prepare("UPDATE invoices SET stage = 'exception', exception_reason = ? WHERE id = ?")
    .run(reason, id);
  touch(id);
}

/**
 * Resets an invoice for reprocessing after a human moves the message back to
 * Inbox/Retry.
 *
 * If Prime already holds a real attachment or AP invoice for this invoice, resume
 * from `ap_created` rather than restarting the pipeline — a restart from 'received'
 * would upload a second attachment and create a DUPLICATE AP invoice in Prime.
 * Re-running the approve step from there is safe because it PATCHes
 * `approvalStatus` to the value it already has.
 *
 * Otherwise (an exception before any Prime write — no work order, cost mismatch,
 * supplier not found, unreadable, write blocked) it is safe to restart the whole
 * pipeline from 'received', since the human's fix (correcting Prime or Outlook
 * data) needs a fresh extraction and match pass to take effect.
 *
 * Every exception the pipeline can now produce is raised BEFORE the first Prime
 * write, so the post-write branch is unreachable in normal operation. It stays as
 * a guard: the cost of being wrong is a duplicate payable.
 */
export function resetForRetry(id: number): void {
  const invoice = getInvoiceById(id);
  if (!invoice) {
    throw new Error(`Cannot reset invoice ${id} for retry: no such invoice`);
  }

  const hasPrimeWrites =
    invoice.primeApInvoiceId !== null || POST_WRITE_STAGES.has(invoice.stage);

  if (hasPrimeWrites) {
    getDb()
      .prepare("UPDATE invoices SET stage = 'ap_created', exception_reason = NULL WHERE id = ?")
      .run(id);
  } else {
    getDb()
      .prepare("UPDATE invoices SET stage = 'received', exception_reason = NULL WHERE id = ?")
      .run(id);
  }
  touch(id);
}
