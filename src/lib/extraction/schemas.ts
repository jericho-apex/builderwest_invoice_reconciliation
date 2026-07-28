import { z } from "zod";

/** Cheap classification pass (PRD §4.7) — only "invoice" proceeds to extraction. */
export const ClassificationSchema = z.object({
  category: z.enum(["invoice", "claim_instruction", "job_note", "other"]),
  confidence: z.number().min(0).max(1),
});

export type Classification = z.infer<typeof ClassificationSchema>;

/** Invoice field extraction (PRD §4.1 step 3). Amounts are in dollars as extracted — converted to cents at the repository boundary. */
export const InvoiceExtractionSchema = z.object({
  supplierName: z.string().nullable(),
  supplierAbn: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  invoiceDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  exTaxAmount: z.number().nullable(),
  taxAmount: z.number().nullable(),
  totalAmount: z.number().nullable(),
  // The purchase order number is the ONLY identifier work-order matching keys
  // off (see matching/resolveWorkOrder.ts) — the client's invoices print a PO
  // per work order, whereas the job number is shared across every work order
  // on the same job and so cannot identify one.
  purchaseOrderNumber: z.string().nullable(),
  // Extracted and persisted but deliberately NOT used for matching: it's the
  // most likely route to the `jobId` that attachment upload and AP-invoice
  // create both require (prime-api-gaps.md Q3).
  jobNumber: z.string().nullable(),
  // Kept for invoices that print an explicit work-order reference. Audit data
  // only — it does not drive resolution.
  workOrderRef: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export type InvoiceExtraction = z.infer<typeof InvoiceExtractionSchema>;
