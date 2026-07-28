import { chatCompletion } from "./client.js";
import { parseModelJson } from "./parseModelJson.js";
import { ClassificationSchema, type Classification } from "./schemas.js";
import { appendAuditLog, type AuditLogInput } from "../../db/repositories/auditLog.js";

type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

export interface MessageSummaryForClassification {
  subject: string;
  senderEmail?: string;
  bodyPreview?: string;
  /** Names of the PDF attachments the pre-filter already fetched. */
  attachmentFilenames?: string[];
}

// Every email reaching this prompt has already passed the structural
// pre-filter, so it definitely carries at least one PDF. That context matters:
// the model is deciding which KIND of PDF-bearing email this is, not whether an
// attachment exists.
//
// The last paragraph encodes the asymmetry that makes this pipeline safe. A
// false "invoice" costs one extraction call and, at worst, lands the email in
// an exception folder a human already works. A false "other" marks the message
// processed and leaves it in the Inbox forever with no invoices row — a
// silently lost invoice, the one outcome this system exists to prevent.
const SYSTEM_PROMPT = `You classify incoming emails for Builderwest, an insurance building-repair company. The inbox is mixed — it also receives claim instructions and job notes, not just invoices.

Every email you see has at least one PDF attached. Weigh all the evidence given: the attachment filenames, the subject, the sender, and the body preview. Subjects in this mailbox are often terse — a bare purchase order number like "PO21266" with an attached PDF is characteristic of a supplier invoice, not of a job note.

Categorize the email as exactly one of:
- "invoice": a trade/supplier invoice for work performed, expecting payment
- "claim_instruction": an insurer's instructions about a new or existing claim
- "job_note": a note related to a job or work order that is not an invoice
- "other": anything else

When the evidence is thin or ambiguous, answer "invoice". A wrongly-included invoice is caught downstream by a human; a wrongly-excluded one is lost silently. Use the confidence figure to express your uncertainty instead of downgrading the category.

Respond with ONLY a JSON object matching exactly this shape, no other text, no markdown formatting:
{"category": "invoice" | "claim_instruction" | "job_note" | "other", "confidence": <number 0-1>}`;

/** Cheap classification pass (PRD §4.7 layer 2) — only "invoice" proceeds to extraction. */
export async function classifyMessage(
  input: MessageSummaryForClassification,
  context: AuditContext,
): Promise<Classification | undefined> {
  const userText = [
    `Subject: ${input.subject}`,
    `From: ${input.senderEmail ?? "unknown"}`,
    input.attachmentFilenames?.length
      ? `PDF attachments: ${input.attachmentFilenames.join(", ")}`
      : undefined,
    input.bodyPreview ? `Preview: ${input.bodyPreview}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await chatCompletion([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userText },
  ]);

  const parsed = parseModelJson(raw, ClassificationSchema);

  appendAuditLog({
    ...context,
    eventType: "openrouter.classify",
    detail: { subject: input.subject, result: parsed },
    isError: parsed === undefined,
  });

  return parsed;
}
