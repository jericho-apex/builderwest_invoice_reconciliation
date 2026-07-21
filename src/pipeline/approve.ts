import { MAX_SYNC_POLL_ATTEMPTS, PROCESSED_FOLDER } from "../config/constants.js";
import {
  getInvoiceById,
  setAttachmentUploaded,
  setApInvoiceCreated,
  setApprovedPendingSync,
  setSynced,
  recordSyncCheckAttempt,
} from "../db/repositories/invoices.js";
import type { AuditLogInput } from "../db/repositories/auditLog.js";
import { getPdfAttachments } from "../lib/graph/mailbox.js";
import { moveMessage } from "../lib/graph/folders.js";
import { uploadAttachment } from "../lib/prime/attachments.js";
import { createApInvoice, approveApInvoice, getApInvoiceSyncStatus } from "../lib/prime/apInvoices.js";
import { routeToException } from "./exception.js";

type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

export type ApproveFlowResult = "completed" | "pending_sync" | "exception";

/**
 * Drives an invoice through the approve flow (PRD §4.1 step 5 / §5.1
 * approve-flow ordering: upload attachment -> create AP invoice -> approve
 * -> poll isSynced), one persisted-stage step at a time. Resumable by
 * design: every step reads the invoice's current `stage` and persists the
 * Prime ID it just acquired before moving to the next step, so a worker
 * restart (or the next tick's in-flight resume-scan) picks up exactly
 * where it left off instead of re-running completed Prime writes.
 *
 * The isSynced poll deliberately checks ONCE per call and returns
 * "pending_sync" rather than looping with a sleep — polling is spread
 * across worker ticks (see MAX_SYNC_POLL_ATTEMPTS), which paces it against
 * Prime's rate limits instead of holding a slot in a tight loop.
 */
export async function advanceApproveFlow(
  invoiceId: number,
  context: AuditContext,
): Promise<ApproveFlowResult> {
  for (;;) {
    const invoice = getInvoiceById(invoiceId);
    if (!invoice) {
      throw new Error(`advanceApproveFlow: invoice ${invoiceId} not found`);
    }

    switch (invoice.stage) {
      case "matched": {
        const pdfAttachments = await getPdfAttachments(invoice.messageId);
        const attachment = pdfAttachments[invoice.attachmentIndex];
        if (!attachment) {
          await routeToException(invoiceId, invoice.messageId, "unreadable", context);
          return "exception";
        }

        const pdfBuffer = Buffer.from(attachment.contentBytes, "base64");
        const attachmentId = await uploadAttachment(pdfBuffer, attachment.name, context);
        setAttachmentUploaded(invoiceId, attachmentId);
        continue;
      }

      case "attachment_uploaded": {
        if (!invoice.primeWorkOrderId || !invoice.primeAttachmentId) {
          throw new Error(
            `advanceApproveFlow: invoice ${invoiceId} missing Prime IDs at stage attachment_uploaded`,
          );
        }

        const apInvoiceId = await createApInvoice(
          {
            workOrderId: invoice.primeWorkOrderId,
            attachmentId: invoice.primeAttachmentId,
            exTaxAmountCents: invoice.extractedExTaxAmountCents ?? 0,
            taxAmountCents: invoice.extractedTaxAmountCents ?? 0,
            totalAmountCents: invoice.extractedTotalAmountCents ?? 0,
          },
          context,
        );
        setApInvoiceCreated(invoiceId, apInvoiceId);
        continue;
      }

      case "ap_created": {
        if (!invoice.primeApInvoiceId) {
          throw new Error(`advanceApproveFlow: invoice ${invoiceId} missing AP invoice ID at stage ap_created`);
        }
        await approveApInvoice(invoice.primeApInvoiceId, context);
        setApprovedPendingSync(invoiceId);
        continue;
      }

      case "approved_pending_sync": {
        if (!invoice.primeApInvoiceId) {
          throw new Error(
            `advanceApproveFlow: invoice ${invoiceId} missing AP invoice ID at stage approved_pending_sync`,
          );
        }

        const status = await getApInvoiceSyncStatus(invoice.primeApInvoiceId, context);
        recordSyncCheckAttempt(invoiceId);

        if (status.isSynced) {
          setSynced(invoiceId, {
            financeSystemName: status.syncedFinanceSystemName ?? "unknown",
            financeSystemReference: status.syncedFinanceSystemReference ?? "unknown",
          });
          continue;
        }

        const refreshed = getInvoiceById(invoiceId)!;
        if (refreshed.syncAttemptCount >= MAX_SYNC_POLL_ATTEMPTS) {
          await routeToException(invoiceId, invoice.messageId, "xeroSyncFailed", context);
          return "exception";
        }

        return "pending_sync";
      }

      case "synced": {
        await moveMessage(invoice.messageId, PROCESSED_FOLDER, context);
        return "completed";
      }

      default:
        throw new Error(
          `advanceApproveFlow called with a stage it doesn't handle: ${invoice.stage}`,
        );
    }
  }
}
