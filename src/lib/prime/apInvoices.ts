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

/** What Prime holds for an AP invoice after we approved it. Observation, not a gate. */
export interface ApInvoiceReadBack {
  approvalStatus?: string;
  accountsPayableInvoiceStatus?: string;
  /**
   * The link this whole project exists to create. Prime's docs list `workOrderId`
   * as OPTIONAL on create and never confirmed it is retained; all 15 production AP
   * invoices carry one, and this is what proves OUR create persisted it
   * (prime-api-gaps.md Q9).
   */
  workOrderId?: string;
  jobId?: string;
  /**
   * Recorded, never acted on. The pipeline stops at approved and does not wait for
   * Prime's Xero push, so this is expected to be false at read-back time.
   */
  isSynced: boolean;
  syncedFinanceSystemName?: string;
  syncedFinanceSystemReference?: string;
}

// JSON:API — created id at data.id, as with attachments.
interface PrimeApInvoiceApiResponse {
  data: { id: string };
}

type ApInvoiceFields = Omit<ApInvoiceReadBack, "isSynced"> & { isSynced?: boolean };

/**
 * Prime v2 is JSON:API — everything else in this client reads resource fields
 * from `data.attributes` (see workOrders.ts's mapWorkOrder). This response is
 * typed to accept EITHER shape because reading the wrong one is silently
 * expensive: every field would come back undefined, and the read-back would
 * report a correctly-created AP invoice as carrying no work-order link.
 */
interface PrimeApInvoiceApiRecord extends ApInvoiceFields {
  data?: ({ id?: string; attributes?: ApInvoiceFields } & ApInvoiceFields) | null;
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
 * THIS IS THE PIPELINE'S LAST PRIME WRITE, and it deliberately does not chase the
 * Xero push any further. Decided with Builderwest 2026-07-29.
 *
 * Setting `approvalStatus` does NOT trigger Prime's push to Xero — read off all 15
 * production AP invoices: one has sat at `approvalStatus: "Approved"` with its
 * lifecycle status still `New`, unsynced, since December 2023, which is exactly the
 * state this call leaves an invoice in. The 12 that did sync are all
 * `accountsPayableInvoiceStatus: "Paid"` and were updated in a batch, i.e. by a
 * payment run.
 *
 * Reaching a synced state would mean PATCHing
 * `/accounts-payable-invoices/{id}/relationships/accountsPayableInvoiceStatus` to
 * "Paid" (that route exists — a GET returns 405, not 404 — and needs the record's
 * `version`). That asserts payment before payment has happened, so it is NOT done
 * here and must not be added without written sign-off from Builderwest. Their
 * finance process pushes to Xero when it pays, as it always did.
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
 * Reads the AP invoice back after approving it. OBSERVATION, NOT A GATE — the
 * pipeline finishes whatever this returns, and only records it.
 *
 * It is worth one GET because it is the only confirmation that the write actually
 * landed the way we think: whether `workOrderId` survived the create (the link this
 * project exists to make, and the last unanswered Prime question — Q9), and what
 * Prime's two status fields hold, which is the evidence for the Xero-push question
 * if it is ever revisited. `isSynced` is expected to be false here and is not
 * treated as a failure.
 */
export async function readBackApInvoice(
  apInvoiceId: string,
  context: AuditContext,
): Promise<ApInvoiceReadBack> {
  if (isDryRunId(apInvoiceId)) {
    const record: ApInvoiceReadBack = {
      approvalStatus: "Approved",
      accountsPayableInvoiceStatus: "New (dry-run)",
      isSynced: false,
    };
    logger.info("[dry-run] would read the AP invoice back", { apInvoiceId, record });
    appendAuditLog({
      ...context,
      eventType: "prime.read_back_ap_invoice.dry_run",
      detail: { apInvoiceId, record },
    });
    return record;
  }

  const response = await primeRequest<PrimeApInvoiceApiRecord>({
    method: "GET",
    path: `/accounts-payable-invoices/${apInvoiceId}`,
  });

  // JSON:API `data.attributes` first, since that is where every other resource
  // in this client carries its fields, then the flatter shapes. Reading only the
  // top level (as this once did) sees `undefined` for everything and would report a
  // correctly-created AP invoice as carrying no work-order link at all.
  const fields: ApInvoiceFields = {
    ...response,
    ...(response.data ?? {}),
    ...(response.data?.attributes ?? {}),
  };

  const status: ApInvoiceReadBack = {
    approvalStatus: fields.approvalStatus,
    accountsPayableInvoiceStatus: fields.accountsPayableInvoiceStatus,
    workOrderId: fields.workOrderId,
    jobId: fields.jobId,
    isSynced: fields.isSynced === true,
    syncedFinanceSystemName: fields.syncedFinanceSystemName,
    syncedFinanceSystemReference: fields.syncedFinanceSystemReference,
  };

  // The whole record, because this row is the only durable evidence of what Prime
  // actually stored: the work-order link (Q9) and both status fields, which is what
  // any future conversation about the Xero push will be argued from.
  appendAuditLog({
    ...context,
    eventType: "prime.read_back_ap_invoice",
    detail: { apInvoiceId, record: status },
    // A missing work-order link is not worth failing the invoice over — it is
    // already approved in Prime by this point — but it IS wrong, so flag it.
    isError: status.workOrderId === undefined,
  });

  return status;
}
