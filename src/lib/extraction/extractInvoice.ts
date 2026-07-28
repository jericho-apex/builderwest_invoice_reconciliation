import { chatCompletion } from "./client.js";
import { parseModelJson } from "./parseModelJson.js";
import { InvoiceExtractionSchema, type InvoiceExtraction } from "./schemas.js";
import { appendAuditLog, type AuditLogInput } from "../../db/repositories/auditLog.js";

type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

const SYSTEM_PROMPT = `You extract structured invoice data from PDF trade/supplier invoices for Builderwest, an insurance building-repair company operating in Australia (GST-registered suppliers).

Extract exactly these fields from the attached PDF invoice:
- supplierName: the party ISSUING the invoice — the name in the document header, at the top. This is NOT the "Bill to" party (that is Builderwest, the recipient) and NOT any "Attention:" or "Attn:" contact person. The issuer is often a company but may be an individual trader's personal name.
- supplierAbn: the ISSUING party's Australian Business Number, digits only with all spaces removed, or null if not present
- invoiceNumber: the invoice's own reference/number
- invoiceDate: the invoice date, ISO 8601 (YYYY-MM-DD), or null
- dueDate: the payment due date, ISO 8601 (YYYY-MM-DD), or null
- exTaxAmount: the amount excluding GST/tax, as a plain number with no currency symbol, or null
- taxAmount: the GST/tax amount, as a plain number, or null
- totalAmount: the total amount including tax, as a plain number, or null
- purchaseOrderNumber: the purchase order this invoice is raised against, labelled "Purchase order", "PO", "PO #", "Order number", or similar. Return the identifier ONLY (e.g. "PO21266"), with no label and no surrounding description. Null if not present.
- jobNumber: the job identifier, labelled "Job", "Job No", "Job number", or similar. Return the identifier code ONLY, stripping any trailing site/property description — e.g. from "BWC-5126 - Wem Lane Office" return "BWC-5126". Null if not present.
- workOrderRef: an explicit work order reference, labelled "Work Order", "WO#", "Work Order Reference", or similar. This is a SEPARATE field from purchaseOrderNumber and jobNumber — do not copy either of those into it. Null if not present.
- confidence: your confidence (0-1) that every field above was read correctly and unambiguously from a clear, legible document

Do not invent a value for a field that is genuinely absent — return null. A field being null is expected and is not itself a reason to lower confidence.

If the document is unreadable, scanned poorly, or any field is genuinely ambiguous, reflect that with a LOW confidence score rather than guessing at a value.

Respond with ONLY a JSON object matching exactly this shape, no other text, no markdown formatting:
{"supplierName": string|null, "supplierAbn": string|null, "invoiceNumber": string|null, "invoiceDate": string|null, "dueDate": string|null, "exTaxAmount": number|null, "taxAmount": number|null, "totalAmount": number|null, "purchaseOrderNumber": string|null, "jobNumber": string|null, "workOrderRef": string|null, "confidence": number}`;

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
