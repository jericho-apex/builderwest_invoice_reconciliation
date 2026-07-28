import { randomUUID } from "node:crypto";
import { loadEnv } from "../../config/env.js";
import { logger } from "../../log/logger.js";
import { primeRequest } from "./httpClient.js";
import { appendAuditLog } from "../../db/repositories/auditLog.js";
import { DRY_RUN_ID_PREFIX } from "./attachments.js";
import type { AuditContext } from "./workOrders.js";

export interface CreateApInvoiceInput {
  /** Required by Prime — the supplier's own invoice number, off the PDF. */
  invoiceNumber: string;
  /** Required by Prime. Comes from the matched work order, never from the PDF. */
  jobId: string;
  /** Optional to Prime, but the whole point of matching — always sent. */
  workOrderId: string;
  attachmentId: string;
  /** Tax-INCLUSIVE total. See createApInvoice for why this and nothing else. */
  totalAmountCents: number;
  /** ISO date (YYYY-MM-DD) — Prime's `invoicedDate`. */
  invoicedDate: string;
  /** ISO date (YYYY-MM-DD). */
  dueDate: string;
}

export interface ApInvoiceSyncStatus {
  isSynced: boolean;
  syncedFinanceSystemName?: string;
  syncedFinanceSystemReference?: string;
}

// JSON:API — created id at data.id, as with attachments.
interface PrimeApInvoiceApiResponse {
  data: { id: string };
}

interface PrimeApInvoiceSyncApiResponse {
  isSynced: boolean;
  syncedFinanceSystemName?: string;
  syncedFinanceSystemReference?: string;
}

function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

function isDryRunId(id: string): boolean {
  return id.startsWith(DRY_RUN_ID_PREFIX);
}

/**
 * Creates the accounts-payable invoice record referencing an already-uploaded
 * attachment (PRD §5.1 — approve-flow ordering requires the attachment to exist
 * first). Dry-run gated the same way as attachments.uploadAttachment.
 *
 * THE AMOUNT MODEL, verified against 15 production AP invoices on 2026-07-28:
 * `amount` is the tax-INCLUSIVE total, `tax` is the RATE (0.1000, not a dollar
 * figure), and `taxTotal` is the GST amount Prime calculates itself. Every
 * record checked is exact — e.g. amount 968.0000 with taxTotal 88, i.e.
 * 968 / 1.1 = 880 ex-GST. So create sends one `amount` and nothing else about
 * tax; sending a `taxTotal` (as this did) both invented a value Prime derives
 * and, worse, passed the ex-GST figure as `amount`, which would have created
 * every AP invoice ~9% short.
 *
 * The same convention holds on work orders (`tax` a rate, `costTaxTotal` the GST
 * amount), which is why cost matching compares inc-GST to inc-GST.
 */
export async function createApInvoice(
  input: CreateApInvoiceInput,
  context: AuditContext,
): Promise<string> {
  const env = loadEnv();

  const body = {
    invoiceNumber: input.invoiceNumber,
    jobId: input.jobId,
    workOrderId: input.workOrderId,
    attachmentId: input.attachmentId,
    amount: fromCents(input.totalAmountCents),
    invoicedDate: input.invoicedDate,
    dueDate: input.dueDate,
  };

  if (env.PRIME_DRY_RUN) {
    const fakeId = `${DRY_RUN_ID_PREFIX}ap-invoice-${randomUUID()}`;
    logger.info("[dry-run] would create AP invoice in Prime", { body, fakeId });
    appendAuditLog({
      ...context,
      eventType: "prime.create_ap_invoice.dry_run",
      detail: { body, fakeId },
    });
    return fakeId;
  }

  const response = await primeRequest<PrimeApInvoiceApiResponse>({
    method: "POST",
    path: "/accounts-payable-invoices",
    body,
  });

  appendAuditLog({
    ...context,
    eventType: "prime.create_ap_invoice",
    detail: { body, apInvoiceId: response.data.id },
  });

  return response.data.id;
}

/**
 * Sets the AP invoice's approval status to Approved, which triggers Prime's
 * existing hook to push the invoice to Xero (PRD §4.1/§4.3 — Apex never
 * calls Xero directly).
 *
 * ASSUMPTION FLAGGED FOR VERIFICATION: the PATCH field name below
 * (`approvalStatus`) is a placeholder — the PRD documents that
 * `accountsPayableInvoiceStatus` and `approvalStatus` both exist on this
 * object but doesn't specify which one "Approved" is written to. Confirm
 * against Prime's API reference before this is used against real data.
 */
export async function approveApInvoice(apInvoiceId: string, context: AuditContext): Promise<void> {
  if (isDryRunId(apInvoiceId)) {
    logger.info("[dry-run] would approve AP invoice in Prime", { apInvoiceId });
    appendAuditLog({
      ...context,
      eventType: "prime.approve_ap_invoice.dry_run",
      detail: { apInvoiceId },
    });
    return;
  }

  await primeRequest<void>({
    method: "PATCH",
    path: `/accounts-payable-invoices/${apInvoiceId}`,
    body: { approvalStatus: "Approved" },
  });

  appendAuditLog({
    ...context,
    eventType: "prime.approve_ap_invoice",
    detail: { apInvoiceId },
  });
}

/**
 * Polls the AP invoice's isSynced / syncedFinanceSystemName /
 * syncedFinanceSystemReference fields (PRD §4.3) — how the pipeline detects
 * that Prime's own Xero push succeeded, without calling Xero directly.
 */
export async function getApInvoiceSyncStatus(
  apInvoiceId: string,
  context: AuditContext,
): Promise<ApInvoiceSyncStatus> {
  if (isDryRunId(apInvoiceId)) {
    const status: ApInvoiceSyncStatus = {
      isSynced: true,
      syncedFinanceSystemName: "Xero (dry-run)",
      syncedFinanceSystemReference: `dryrun-xero-ref-${randomUUID()}`,
    };
    logger.info("[dry-run] simulated isSynced poll", { apInvoiceId, status });
    appendAuditLog({
      ...context,
      eventType: "prime.poll_sync.dry_run",
      detail: { apInvoiceId, status },
    });
    return status;
  }

  const response = await primeRequest<PrimeApInvoiceSyncApiResponse>({
    method: "GET",
    path: `/accounts-payable-invoices/${apInvoiceId}`,
  });

  const status: ApInvoiceSyncStatus = {
    isSynced: response.isSynced,
    syncedFinanceSystemName: response.syncedFinanceSystemName,
    syncedFinanceSystemReference: response.syncedFinanceSystemReference,
  };

  appendAuditLog({ ...context, eventType: "prime.poll_sync", detail: { apInvoiceId, status } });

  return status;
}
