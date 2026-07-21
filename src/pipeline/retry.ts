import { getInvoicesByMessage, resetForRetry } from "../db/repositories/invoices.js";
import { isEligibleForProcessing, clearForRetry } from "../db/repositories/processedMessages.js";
import { appendAuditLog } from "../db/repositories/auditLog.js";
import type { GraphMessageSummary } from "../lib/graph/mailbox.js";
import { processMessage } from "./orchestrator.js";

/**
 * Handles a message found sitting in the dedicated Retry folder. A message
 * that was already processed (and not yet cleared) reappearing here IS the
 * human's retry signal — PRD §4.5: "reprocess = move it back." Detecting
 * that reappearance and resetting state is this function's only job;
 * afterwards it hands off to the normal processMessage() pipeline, which
 * (via getOrCreateInvoice) is naturally idempotent whether the message is
 * brand new or a genuine retry.
 */
export async function handleRetryFolderMessage(message: GraphMessageSummary): Promise<void> {
  const existingInvoices = getInvoicesByMessage(message.id);
  const isReappearance = existingInvoices.length > 0 && !isEligibleForProcessing(message.id);

  if (isReappearance) {
    clearForRetry(message.id);
    for (const invoice of existingInvoices) {
      resetForRetry(invoice.id);
    }
    appendAuditLog({
      messageId: message.id,
      eventType: "pipeline.retry_detected",
      detail: { invoiceCount: existingInvoices.length },
    });
  }

  await processMessage(message);
}
