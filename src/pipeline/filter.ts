import { isEligibleForProcessing } from "../db/repositories/processedMessages.js";
import { getPdfAttachments } from "../lib/graph/mailbox.js";
import type { GraphMessageSummary, GraphFileAttachment } from "../lib/graph/mailbox.js";

export type StructuralFilterResult =
  | { eligible: true; pdfAttachments: GraphFileAttachment[] }
  | { eligible: false; reason: "already_processed" | "no_attachments" | "no_pdf_attachments" };

/**
 * Structural pre-filters (PRD §4.7 layer 1) — free, no AI call. Dedupe by
 * message ID, then skip anything with no PDF attachment. Deliberately does
 * NOT include a sender-allowlist or subject-pattern job-note filter: those
 * would need Builderwest to confirm real patterns from actual invoice/
 * job-note subject lines first (still open per the PRD's §9 questions) —
 * guessing a wrong pattern risks silently skipping a real invoice, whereas
 * skipping this optimization only costs an unnecessary but harmless
 * classification call. Extend here once concrete patterns are confirmed.
 */
export async function passesStructuralPreFilter(
  message: GraphMessageSummary,
): Promise<StructuralFilterResult> {
  if (!isEligibleForProcessing(message.id)) {
    return { eligible: false, reason: "already_processed" };
  }

  if (!message.hasAttachments) {
    return { eligible: false, reason: "no_attachments" };
  }

  const pdfAttachments = await getPdfAttachments(message.id);
  if (pdfAttachments.length === 0) {
    return { eligible: false, reason: "no_pdf_attachments" };
  }

  return { eligible: true, pdfAttachments };
}
