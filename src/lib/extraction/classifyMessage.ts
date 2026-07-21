import { chatCompletion } from "./client.js";
import { parseModelJson } from "./parseModelJson.js";
import { ClassificationSchema, type Classification } from "./schemas.js";
import { appendAuditLog, type AuditLogInput } from "../../db/repositories/auditLog.js";

type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

export interface MessageSummaryForClassification {
  subject: string;
  senderEmail?: string;
  bodyPreview?: string;
}

const SYSTEM_PROMPT = `You classify incoming emails for Builderwest, an insurance building-repair company. The inbox is mixed — it also receives claim instructions and job notes, not just invoices.

Categorize the email as exactly one of:
- "invoice": a trade/supplier invoice for work performed, expecting payment
- "claim_instruction": an insurer's instructions about a new or existing claim
- "job_note": a note related to a job or work order that is not an invoice
- "other": anything else

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
