import { loadEnv } from "../../config/env.js";
import { logger } from "../../log/logger.js";
import { graphRequest } from "./httpClient.js";
import { appendAuditLog, type AuditLogInput } from "../../db/repositories/auditLog.js";

type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

export interface MissingDataReplyInput {
  toEmail: string;
  subject: string;
  bodyText: string;
}

/**
 * The ONE auto-reply case this pilot supports: a detected invoice with
 * missing/incomplete extracted data gets a reply asking the sender to
 * resend/complete it (PRD §4/§8.3 — auto-email enabled narrowly, not for
 * general mismatches). No-ops if GRAPH_SEND_MAIL_ENABLED is false (the
 * default) — Mail.Send + admin consent are required before this can ever
 * fire for real.
 *
 * GRAPH_TEST_RECIPIENT is a value for supervised manual test runs (the
 * client's IT-provided safe address — PRD §8.2) to pass as `toEmail`
 * instead of a real trade contact. It is intentionally NOT auto-substituted
 * here — callers decide the recipient, so production code always replies to
 * the real sender once this is confirmed working.
 */
export async function sendMissingDataReply(
  input: MissingDataReplyInput,
  context: AuditContext,
): Promise<void> {
  const env = loadEnv();

  if (!env.GRAPH_SEND_MAIL_ENABLED) {
    logger.info("auto-reply disabled (GRAPH_SEND_MAIL_ENABLED=false) — skipping", {
      toEmail: input.toEmail,
    });
    appendAuditLog({
      ...context,
      eventType: "graph.send_mail.skipped_disabled",
      detail: { toEmail: input.toEmail, subject: input.subject },
    });
    return;
  }

  await graphRequest<void>({
    method: "POST",
    path: `/users/${env.GRAPH_MAILBOX_ADDRESS}/sendMail`,
    body: {
      message: {
        subject: input.subject,
        body: { contentType: "Text", content: input.bodyText },
        toRecipients: [{ emailAddress: { address: input.toEmail } }],
      },
      saveToSentItems: true,
    },
  });

  appendAuditLog({
    ...context,
    eventType: "graph.send_mail",
    detail: { toEmail: input.toEmail, subject: input.subject },
  });
}
