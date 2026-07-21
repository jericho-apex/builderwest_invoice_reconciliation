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
  workOrderRef: z.string().nullable(),
  confidence: z.number().min(0).max(1),
});

export type InvoiceExtraction = z.infer<typeof InvoiceExtractionSchema>;
