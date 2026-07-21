import { randomUUID } from "node:crypto";
import { loadEnv } from "../../config/env.js";
import { logger } from "../../log/logger.js";
import { primeRequest } from "./httpClient.js";
import { appendAuditLog } from "../../db/repositories/auditLog.js";
import { DRY_RUN_ID_PREFIX } from "./attachments.js";
import type { AuditContext } from "./workOrders.js";

export interface CreateApInvoiceInput {
  workOrderId: string;
  attachmentId: string;
  exTaxAmountCents: number;
  taxAmountCents: number;
  totalAmountCents: number;
}

export interface ApInvoiceSyncStatus {
  isSynced: boolean;
  syncedFinanceSystemName?: string;
  syncedFinanceSystemReference?: string;
}

interface PrimeApInvoiceApiResponse {
  id: string;
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
 * Creates the accounts-payable invoice record referencing an already-
 * uploaded attachment (PRD §5.1 — approve-flow ordering requires the
 * attachment to exist first). Dry-run gated the same way as
 * attachments.uploadAttachment — see that file's docstring for why.
 */
export async function createApInvoice(
  input: CreateApInvoiceInput,
  context: AuditContext,
): Promise<string> {
  const env = loadEnv();

  if (env.PRIME_DRY_RUN) {
    const fakeId = `${DRY_RUN_ID_PREFIX}ap-invoice-${randomUUID()}`;
    logger.info("[dry-run] would create AP invoice in Prime", { input, fakeId });
    appendAuditLog({
      ...context,
      eventType: "prime.create_ap_invoice.dry_run",
      detail: { input, fakeId },
    });
    return fakeId;
  }

  const response = await primeRequest<PrimeApInvoiceApiResponse>({
    method: "POST",
    path: "/accounts-payable-invoices",
    body: {
      workOrderId: input.workOrderId,
      attachmentId: input.attachmentId,
      amount: fromCents(input.exTaxAmountCents),
      tax: fromCents(input.taxAmountCents),
      taxTotal: fromCents(input.totalAmountCents),
    },
  });

  appendAuditLog({
    ...context,
    eventType: "prime.create_ap_invoice",
    detail: { input, apInvoiceId: response.id },
  });

  return response.id;
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
