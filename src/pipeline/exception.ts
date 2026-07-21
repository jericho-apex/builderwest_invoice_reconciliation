import { EXCEPTION_FOLDERS, type ExceptionReason } from "../config/constants.js";
import { setException } from "../db/repositories/invoices.js";
import { appendAuditLog, type AuditLogInput } from "../db/repositories/auditLog.js";
import { moveMessage } from "../lib/graph/folders.js";
import { getMessageById } from "../lib/graph/mailbox.js";
import { sendMissingDataReply } from "../lib/graph/sendMail.js";

type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

/**
 * Routes an invoice to its reason-specific Outlook subfolder (PRD §4.5) —
 * never auto-approved on a guess. "unreadable" is also the ONE trigger for
 * the narrow auto-reply case (PRD's "missing/incomplete extracted data"):
 * low-confidence extraction is the closest available signal for that,
 * since the exception taxonomy doesn't have a separate "incomplete data"
 * bucket — this mapping is a deliberate interpretive choice, not a literal
 * PRD field.
 */
export async function routeToException(
  invoiceId: number,
  messageId: string,
  reason: ExceptionReason,
  context: AuditContext,
): Promise<void> {
  setException(invoiceId, reason);

  const folderPath = EXCEPTION_FOLDERS[reason];
  await moveMessage(messageId, folderPath, context);

  appendAuditLog({
    ...context,
    eventType: "pipeline.routed_to_exception",
    detail: { reason, folderPath },
  });

  if (reason === "unreadable") {
    const message = await getMessageById(messageId);
    const senderEmail = message.from?.emailAddress.address;
    if (senderEmail) {
      await sendMissingDataReply(
        {
          toEmail: senderEmail,
          subject: `RE: ${message.subject} — additional information needed`,
          bodyText:
            "Hi,\n\n" +
            "We received your invoice but were unable to read some required details from the " +
            "attached PDF. Could you please resend a clearer copy, or reply confirming the " +
            "invoice number, total amount, and the work order / job reference it relates to?\n\n" +
            "Thanks,\nBuilderwest Accounts",
        },
        context,
      );
    }
  }
}
