import { EXTRACTION_CONFIDENCE_THRESHOLD } from "../config/constants.js";
import {
  getInvoiceById,
  getOrCreateInvoice,
  setExtraction,
  setResolvedMatch,
  type ExtractedFields,
} from "../db/repositories/invoices.js";
import { recordMatchResult } from "../db/repositories/matchResults.js";
import { appendAuditLog } from "../db/repositories/auditLog.js";
import { logger } from "../log/logger.js";
import { dollarsToCents } from "../lib/money.js";
import { getPdfAttachments } from "../lib/graph/mailbox.js";
import type { GraphMessageSummary } from "../lib/graph/mailbox.js";
import { classifyMessage } from "../lib/extraction/classifyMessage.js";
import { extractInvoiceFields } from "../lib/extraction/extractInvoice.js";
import type { InvoiceExtraction } from "../lib/extraction/schemas.js";
import { decideMatch } from "./decide.js";
import { passesStructuralPreFilter } from "./filter.js";
import { routeToException } from "./exception.js";
import { advanceApproveFlow } from "./approve.js";
import { markProcessed } from "../db/repositories/processedMessages.js";

function toCents(dollars: number | null): number | undefined {
  return dollars === null ? undefined : dollarsToCents(dollars);
}

function mapExtractionToFields(extraction: InvoiceExtraction): ExtractedFields {
  return {
    supplierName: extraction.supplierName ?? undefined,
    supplierAbn: extraction.supplierAbn ?? undefined,
    invoiceNumber: extraction.invoiceNumber ?? undefined,
    invoiceDate: extraction.invoiceDate ?? undefined,
    dueDate: extraction.dueDate ?? undefined,
    exTaxAmountCents: toCents(extraction.exTaxAmount),
    taxAmountCents: toCents(extraction.taxAmount),
    totalAmountCents: toCents(extraction.totalAmount),
    purchaseOrderNumber: extraction.purchaseOrderNumber ?? undefined,
    jobNumber: extraction.jobNumber ?? undefined,
    workOrderRef: extraction.workOrderRef ?? undefined,
    confidence: extraction.confidence,
  };
}

/**
 * Entry point for a message returned by a mailbox poll (fresh Inbox item or
 * a retry-folder reappearance already handled by pipeline/retry.ts). Runs
 * the structural pre-filter, then the cheap AI classification pass —
 * BEFORE any invoices row exists, since a message that isn't actually an
 * invoice should never get one. Only once classified as "invoice" does an
 * invoice row (one per PDF attachment) get created and driven through the
 * rest of the pipeline.
 */
export async function processMessage(message: GraphMessageSummary): Promise<void> {
  const filterResult = await passesStructuralPreFilter(message);
  if (!filterResult.eligible) {
    if (filterResult.reason !== "already_processed") {
      // Not an invoice candidate at all (no PDF) — mark processed so we
      // don't keep re-fetching and re-checking it on every future poll.
      markProcessed(message.id);
    }
    return;
  }

  const classificationContext = { messageId: message.id };
  const classification = await classifyMessage(
    { subject: message.subject, senderEmail: message.from?.emailAddress.address },
    classificationContext,
  );

  if (!classification || classification.category !== "invoice") {
    // Classifier returned a verdict (or unparseable output) — safe to mark
    // processed now so we don't re-classify this message on every future poll.
    markProcessed(message.id);
    appendAuditLog({
      ...classificationContext,
      eventType: "pipeline.not_invoice",
      detail: { classification },
    });
    return; // Not our concern — leave the message wherever it is.
  }

  // Create the durable invoices row(s) FIRST, then mark the message processed.
  // markProcessed deliberately does NOT run before classifyMessage above: if
  // that AI call throws (e.g. OpenRouter down after its retries exhaust), the
  // message must stay un-marked so the next poll retries it — otherwise it
  // would be permanently skipped with no invoices row ever created, i.e. a
  // silently lost invoice. Creating the row before marking also means a crash
  // in the tiny window between the two still leaves a resumable row for the
  // next tick's in-flight scan to pick up.
  const invoiceIds = filterResult.pdfAttachments.map((_, attachmentIndex) =>
    getOrCreateInvoice(message.id, attachmentIndex),
  );
  markProcessed(message.id);

  for (const invoiceId of invoiceIds) {
    await driveInvoice(invoiceId);
  }
}

/**
 * Drives a single invoice forward from wherever its persisted `stage`
 * currently is. Called both right after creation and by the worker loop's
 * in-flight resume-scan on every tick — the SAME function handles fresh
 * processing and crash recovery, because both cases reduce to "continue
 * from this invoice's stage."
 */
export async function driveInvoice(invoiceId: number): Promise<void> {
  const invoice = getInvoiceById(invoiceId);
  if (!invoice || invoice.stage === "synced" || invoice.stage === "exception") {
    return; // Terminal — nothing to do.
  }

  const context = { invoiceId, messageId: invoice.messageId };

  try {
    if (invoice.stage === "received") {
      const pdfAttachments = await getPdfAttachments(invoice.messageId);
      const attachment = pdfAttachments[invoice.attachmentIndex];
      if (!attachment) {
        await routeToException(invoiceId, invoice.messageId, "unreadable", context);
        return;
      }

      const pdfBuffer = Buffer.from(attachment.contentBytes, "base64");
      const extraction = await extractInvoiceFields(pdfBuffer, attachment.name, context);

      if (!extraction || extraction.confidence < EXTRACTION_CONFIDENCE_THRESHOLD) {
        if (extraction) {
          // Still record what we got, even though it's below threshold —
          // useful for a human reviewing Exceptions/Unreadable, and for
          // later confidence-threshold calibration.
          setExtraction(invoiceId, mapExtractionToFields(extraction));
        }
        await routeToException(invoiceId, invoice.messageId, "unreadable", context);
        return;
      }

      setExtraction(invoiceId, mapExtractionToFields(extraction));

      // The identifiers, recorded explicitly rather than left implicit in the
      // extraction blob: the PO is the sole matching key, and the job number
      // is the evidence we need to answer how a `jobId` is obtained for
      // attachment upload / AP-invoice create (prime-api-gaps.md Q3).
      appendAuditLog({
        ...context,
        eventType: "pipeline.invoice_identifiers",
        detail: {
          purchaseOrderNumber: extraction.purchaseOrderNumber,
          jobNumber: extraction.jobNumber,
          workOrderRef: extraction.workOrderRef,
        },
      });
    }

    const afterExtraction = getInvoiceById(invoiceId)!;

    if (afterExtraction.stage === "extracted") {
      // decide.ts computes; this function owns every persisted consequence.
      const decision = await decideMatch(
        {
          purchaseOrderNumber: afterExtraction.extractedPurchaseOrderNumber,
          supplierAbn: afterExtraction.extractedSupplierAbn,
          supplierName: afterExtraction.extractedSupplierName,
          totalAmountCents: afterExtraction.extractedTotalAmountCents ?? 0,
        },
        context,
      );

      recordMatchResult({ invoiceId, ...decision.matchResult });
      for (const event of decision.auditEvents) {
        appendAuditLog({ ...context, ...event });
      }

      if (decision.outcome === "exception") {
        await routeToException(invoiceId, invoice.messageId, decision.reason, context);
        return;
      }

      setResolvedMatch(invoiceId, {
        primeWorkOrderId: decision.workOrder.id,
        // Undefined under ASSUME_SUPPLIER_MATCHED — no contact was verified, and
        // recording a guessed one would misrepresent the run. setResolvedMatch
        // COALESCEs, so the column simply stays null.
        primeContactId: decision.contact?.id,
      });
    }

    await advanceApproveFlow(invoiceId, context);
  } catch (error) {
    logger.error("unhandled error driving invoice", { invoiceId, error: String(error) });
    appendAuditLog({
      ...context,
      eventType: "pipeline.unhandled_error",
      detail: { error: String(error) },
      isError: true,
    });
    // Leave the invoice at its current stage — the next tick's in-flight
    // resume-scan will retry it rather than losing it silently.
  }
}
