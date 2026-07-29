import { PROCESSED_FOLDER } from "../config/constants.js";
import { loadEnv } from "../config/env.js";
import {
  getInvoiceById,
  setAttachmentUploaded,
  setApInvoiceCreated,
  setApproved,
} from "../db/repositories/invoices.js";
import type { InvoiceRecord } from "../db/repositories/invoices.js";
import { appendAuditLog, type AuditLogInput } from "../db/repositories/auditLog.js";
import { getPdfAttachments } from "../lib/graph/mailbox.js";
import { moveMessage } from "../lib/graph/folders.js";
import { uploadAttachment } from "../lib/prime/attachments.js";
import { createApInvoice, approveApInvoice, readBackApInvoice } from "../lib/prime/apInvoices.js";
import { routeToException } from "./exception.js";

type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

// No "pending_sync": the flow reaches a terminal state in one call now. It used to
// return early while waiting on Prime's Xero push, which no longer happens.
export type ApproveFlowResult = "completed" | "exception";

/**
 * Everything Prime requires across the attachment upload and the AP-invoice
 * create, checked in one place. `jobId` and `workOrderId` come from matching;
 * the rest are extracted off the PDF and are all nullable in the extraction
 * schema, so any of them can genuinely be absent.
 *
 * Returns the names of whatever is missing, so the audit row says which field
 * stopped the invoice rather than just that something did.
 */
function missingRequiredFields(invoice: InvoiceRecord): string[] {
  const required: Array<[string, unknown]> = [
    ["primeJobId", invoice.primeJobId],
    ["primeWorkOrderId", invoice.primeWorkOrderId],
    ["invoiceNumber", invoice.extractedInvoiceNumber],
    ["invoiceDate", invoice.extractedInvoiceDate],
    ["dueDate", invoice.extractedDueDate],
    ["totalAmountCents", invoice.extractedTotalAmountCents],
  ];
  return required.filter(([, value]) => value === null || value === undefined).map(([name]) => name);
}

/**
 * Whether live writes are enabled but this invoice's work order sits outside the
 * fence (PRIME_TEST_WORK_ORDER_IDS).
 *
 * Only consulted when PRIME_DRY_RUN is off — under dry-run nothing reaches Prime
 * anyway, and fencing the dry run would stop it exercising the very flow it
 * exists to rehearse. An empty allowlist means unrestricted, which is the
 * production configuration; loadEnv warns when that is combined with live writes.
 */
function isWriteFencedOut(invoice: InvoiceRecord): boolean {
  const { PRIME_DRY_RUN, PRIME_TEST_WORK_ORDER_IDS } = loadEnv();

  if (PRIME_DRY_RUN || PRIME_TEST_WORK_ORDER_IDS.length === 0) {
    return false;
  }

  return !PRIME_TEST_WORK_ORDER_IDS.includes(invoice.primeWorkOrderId ?? "");
}

/**
 * Drives an invoice through the approve flow (PRD §4.1 step 5 / §5.1 approve-flow
 * ordering: upload attachment -> create AP invoice -> approve), one
 * persisted-stage step at a time. Resumable by design: every step reads the
 * invoice's current `stage` and persists the Prime ID it just acquired before
 * moving to the next step, so a worker restart (or the next tick's in-flight
 * resume-scan) picks up exactly where it left off instead of re-running completed
 * Prime writes.
 *
 * APPROVAL IS THE END OF THE LINE. The flow used to go on to poll Prime's
 * `isSynced` field until its Xero push landed, and to route to
 * Exceptions/Xero sync failed when it never did. Both are gone: the push does not
 * follow approval (see approveApInvoice for the production evidence), so waiting on
 * it only ever produced a timeout that meant nothing. Builderwest's finance process
 * owns the push from here.
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
        // Prime requires all of these on the two writes ahead. Check them BEFORE
        // the upload, so a missing field costs nothing rather than leaving an
        // orphaned attachment on the job that no AP invoice ever references.
        //
        // Routing to "unreadable" is deliberate: the field is missing because
        // extraction could not read it off the PDF, which is exactly the case
        // that folder — and the one auto-reply asking the supplier to resend —
        // exists for. Defaulting any of them would put a made-up invoice number
        // or payment date on a real payable.
        const missing = missingRequiredFields(invoice);
        if (missing.length > 0) {
          appendAuditLog({
            ...context,
            eventType: "pipeline.ap_invoice_fields_missing",
            detail: { missing },
            isError: true,
          });
          await routeToException(invoiceId, invoice.messageId, "unreadable", context);
          return "exception";
        }

        // THE WRITE FENCE. Checked here, before the upload, for the same reason
        // as the field check above: a blocked invoice must leave nothing behind
        // in Prime. See PRIME_TEST_WORK_ORDER_IDS in config/env.ts for why a
        // procedural "only write against the dummy work order" agreement isn't
        // enough — there is no Prime sandbox, and the pilot mailbox is live.
        if (isWriteFencedOut(invoice)) {
          appendAuditLog({
            ...context,
            eventType: "pipeline.write_blocked_not_allowlisted",
            detail: {
              primeWorkOrderId: invoice.primeWorkOrderId,
              allowedWorkOrderIds: loadEnv().PRIME_TEST_WORK_ORDER_IDS,
            },
            isError: true,
          });
          await routeToException(invoiceId, invoice.messageId, "writeBlocked", context);
          return "exception";
        }

        const pdfAttachments = await getPdfAttachments(invoice.messageId);
        const attachment = pdfAttachments[invoice.attachmentIndex];
        if (!attachment) {
          await routeToException(invoiceId, invoice.messageId, "unreadable", context);
          return "exception";
        }

        const attachmentId = await uploadAttachment(
          {
            pdf: Buffer.from(attachment.contentBytes, "base64"),
            filename: attachment.name,
            jobId: invoice.primeJobId!,
          },
          context,
        );
        setAttachmentUploaded(invoiceId, attachmentId);
        continue;
      }

      case "attachment_uploaded": {
        if (!invoice.primeAttachmentId || missingRequiredFields(invoice).length > 0) {
          throw new Error(
            `advanceApproveFlow: invoice ${invoiceId} missing Prime IDs or required fields at stage attachment_uploaded`,
          );
        }

        const apInvoiceId = await createApInvoice(
          {
            invoiceNumber: invoice.extractedInvoiceNumber!,
            jobId: invoice.primeJobId!,
            workOrderId: invoice.primeWorkOrderId!,
            attachmentId: invoice.primeAttachmentId,
            // The tax-inclusive total — Prime derives the GST itself. See
            // createApInvoice for the evidence behind that.
            totalAmountCents: invoice.extractedTotalAmountCents!,
            invoicedDate: invoice.extractedInvoiceDate!,
            dueDate: invoice.extractedDueDate!,
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

        // Read the record back before finishing. Not a gate — whatever it says,
        // the invoice is approved and the pipeline is done — but it is the only
        // confirmation that the work-order link survived the create, and it costs
        // one GET. See readBackApInvoice.
        await readBackApInvoice(invoice.primeApInvoiceId, context);

        setApproved(invoiceId);
        continue;
      }

      case "approved": {
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
