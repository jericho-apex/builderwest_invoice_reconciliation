import { chatCompletion } from "./client.js";
import { parseModelJson } from "./parseModelJson.js";
import { InvoiceExtractionSchema, type InvoiceExtraction } from "./schemas.js";
import { appendAuditLog, type AuditLogInput } from "../../db/repositories/auditLog.js";

type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

const SYSTEM_PROMPT = `You extract structured invoice data from PDF trade/supplier invoices for Builderwest, an insurance building-repair company operating in Australia (GST-registered suppliers).

Extract exactly these fields from the attached PDF invoice:
- supplierName: the invoice-issuing company's name
- supplierAbn: the supplier's Australian Business Number (digits only, no spaces), or null if not present
- invoiceNumber: the invoice's own reference/number
- invoiceDate: the invoice date, ISO 8601 (YYYY-MM-DD), or null
- dueDate: the payment due date, ISO 8601 (YYYY-MM-DD), or null
- exTaxAmount: the amount excluding GST/tax, as a plain number with no currency symbol, or null
- taxAmount: the GST/tax amount, as a plain number, or null
- totalAmount: the total amount including tax, as a plain number, or null
- workOrderRef: the work order or job number this invoice references (may be labelled "Job No", "WO#", "Reference", or similar), or null if not present
- confidence: your confidence (0-1) that every field above was read correctly and unambiguously from a clear, legible document

If the document is unreadable, scanned poorly, or any field is genuinely ambiguous, reflect that with a LOW confidence score rather than guessing at a value.

Respond with ONLY a JSON object matching exactly this shape, no other text, no markdown formatting:
{"supplierName": string|null, "supplierAbn": string|null, "invoiceNumber": string|null, "invoiceDate": string|null, "dueDate": string|null, "exTaxAmount": number|null, "taxAmount": number|null, "totalAmount": number|null, "workOrderRef": string|null, "confidence": number}`;

/** PDF -> strict JSON extraction with a confidence score (PRD §4.1 step 3). */
export async function extractInvoiceFields(
  pdfBuffer: Buffer,
  filename: string,
  context: AuditContext,
): Promise<InvoiceExtraction | undefined> {
  const base64 = pdfBuffer.toString("base64");

  const raw = await chatCompletion([
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        { type: "file", file: { filename, file_data: `data:application/pdf;base64,${base64}` } },
        { type: "text", text: "Extract the invoice fields as instructed." },
      ],
    },
  ]);

  const parsed = parseModelJson(raw, InvoiceExtractionSchema);

  appendAuditLog({
    ...context,
    eventType: "openrouter.extract",
    detail: { filename, confidence: parsed?.confidence, parsedSuccessfully: parsed !== undefined },
    isError: parsed === undefined,
  });

  return parsed;
}
