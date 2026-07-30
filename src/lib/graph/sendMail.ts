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
 * THE REDIRECT IS THE SAFETY CONTROL, and it lives here rather than in the
 * caller. `routeToException` passes the invoice sender's own address, which is
 * correct at go-live and wrong during the pilot: the sample invoices are from real
 * subcontractors, so an unreadable one would email a real trade business asking it
 * to resend paperwork that was never actually a problem. With
 * GRAPH_SEND_MAIL_REDIRECT_TO_TEST on (the default), the send goes to
 * GRAPH_TEST_RECIPIENT instead, and the intended recipient is preserved in both
 * the audit row and the email body so the test inbox still shows who it was for.
 *
 * Doing it in this function rather than at the call site is deliberate: a fence a
 * caller has to remember to apply is not a fence. Every current and future caller
 * inherits it, and the only way to reach a real supplier is the explicit
 * go-live config change.
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

  const redirected = env.GRAPH_SEND_MAIL_REDIRECT_TO_TEST;

  // loadEnv requires GRAPH_TEST_RECIPIENT whenever send-mail is on, so this should
  // be unreachable. It FAILS CLOSED anyway: a redirect that cannot resolve an
  // address must not quietly fall through to the supplier, which is the one
  // outcome the redirect exists to prevent. Dropping the reply is recoverable —
  // the invoice is already in Exceptions/Unreadable for a human — and emailing a
  // real subcontractor by accident is not.
  if (redirected && !env.GRAPH_TEST_RECIPIENT) {
    logger.error("auto-reply NOT sent: redirect is on but GRAPH_TEST_RECIPIENT is unset", {
      intendedRecipient: input.toEmail,
    });
    appendAuditLog({
      ...context,
      eventType: "graph.send_mail.skipped_no_test_recipient",
      detail: { intendedRecipient: input.toEmail, subject: input.subject },
      isError: true,
    });
    return;
  }

  const actualRecipient = redirected ? env.GRAPH_TEST_RECIPIENT! : input.toEmail;

  // Marked in the subject as well as the body: someone scanning the test inbox
  // must be able to tell at a glance that this never went to the supplier.
  const subject = redirected ? `[TEST — not sent to supplier] ${input.subject}` : input.subject;
  const bodyText = redirected
    ? `[TEST RUN — redirected. This reply would have been sent to ${input.toEmail}.]\n\n` +
      input.bodyText
    : input.bodyText;

  await graphRequest<void>({
    method: "POST",
    path: `/users/${env.GRAPH_MAILBOX_ADDRESS}/sendMail`,
    body: {
      message: {
        subject,
        body: { contentType: "Text", content: bodyText },
        toRecipients: [{ emailAddress: { address: actualRecipient } }],
      },
      saveToSentItems: true,
    },
  });

  if (redirected) {
    logger.info("auto-reply REDIRECTED to the test recipient", {
      intendedRecipient: input.toEmail,
      actualRecipient,
    });
  }

  // Both addresses are recorded either way, so the audit trail answers "who did
  // this actually reach" without the reader having to know what the config was at
  // the time.
  appendAuditLog({
    ...context,
    eventType: "graph.send_mail",
    detail: {
      toEmail: actualRecipient,
      intendedRecipient: input.toEmail,
      redirected,
      subject,
    },
  });
}
