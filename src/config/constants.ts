/**
 * Reason-specific Outlook subfolders that exception routing moves messages
 * into (PRD §4.5). The app creates these via Graph if they don't already
 * exist — see lib/graph/folders.ts.
 */
export const EXCEPTION_FOLDERS = {
  noWorkOrder: "Exceptions/No work order",
  costMismatch: "Exceptions/Cost mismatch",
  supplierNotFound: "Exceptions/Supplier not found",
  unreadable: "Exceptions/Unreadable",
  /**
   * The invoice matched cleanly, but its work order is outside
   * PRIME_TEST_WORK_ORDER_IDS while live writes are enabled — so nothing was
   * written. Distinct from every other reason here: the others say the invoice
   * needs a decision, this one says the SYSTEM was deliberately fenced in. It
   * only ever appears during pilot write-path testing, and an invoice landing
   * here is a signal that the fence did its job.
   */
  writeBlocked: "Exceptions/Write blocked",
} as const;

export type ExceptionReason = keyof typeof EXCEPTION_FOLDERS;

export const PROCESSED_FOLDER = "Processed";
export const RETRY_FOLDER = "Retry";

/**
 * Prime Ecosystem rate limits (PRD §5.1): 60 calls/minute, 5 concurrent,
 * 5,000 calls/24h. A 150-200 invoice storm-day burst is ~1,000-1,400 calls,
 * which clears in ~15-20 minutes at the per-minute ceiling — the queue's
 * token-bucket limiter is tuned to these numbers, not to be adjusted without
 * confirming the new figures against Prime's published limits.
 */
export const PRIME_RATE_LIMITS = {
  callsPerMinute: 60,
  maxConcurrent: 5,
  callsPerDay: 5000,
} as const;

/**
 * How many times to retry a transient Prime/Graph failure (e.g. a 429 or 5xx)
 * before treating it as persistent and routing to an exception folder.
 */
export const MAX_TRANSIENT_RETRIES = 5;

/**
 * Attachment upload fields that are business rules rather than per-environment
 * config. Both read off real production attachments on 2026-07-28: every
 * attachment carried by an existing AP invoice uses status "Published" (the only
 * other value in use is "Obsolete") and hangs off the Job — `objectType: "Job"`
 * with `objectId` equal to that invoice's own jobId, without exception.
 *
 * The third field, attachmentTypeId, is tenant data rather than a rule, so it
 * lives in env (PRIME_ATTACHMENT_TYPE_ID).
 */
export const PRIME_ATTACHMENT_STATUS = "Published";
export const PRIME_ATTACHMENT_OBJECT_TYPE = "Job";

/**
 * THE PIPELINE STOPS AT APPROVED. It does not wait for, or verify, Prime's push
 * to Xero — decided with Builderwest on 2026-07-29 after reading all 15 of their
 * production AP invoices.
 *
 * Why: the push does not follow approval. One production invoice has sat at
 * `approvalStatus: "Approved"` with its lifecycle status still `New` and unsynced
 * since December 2023 — exactly the state this pipeline leaves an invoice in. The
 * 12 that did sync are all `accountsPayableInvoiceStatus: "Paid"` and were updated
 * in a batch, i.e. by a payment run. Reaching a synced state would mean marking
 * invoices Paid, which asserts payment before payment has happened.
 *
 * So approval is the handover point: Builderwest's existing finance process pushes
 * to Xero when it pays, exactly as it did before this pilot. There is deliberately
 * no MAX_SYNC_POLL_ATTEMPTS and no Exceptions/Xero sync failed folder — an invoice
 * that cannot complete must not be left to time out into an exception that means
 * nothing. See prime-api-gaps.md Q6 for the evidence and what Option B would need.
 */

/**
 * Extraction confidence below this threshold is treated as a failure and
 * routed to Exceptions/Unreadable rather than trusted. PLACEHOLDER — the
 * implementation plan flags this as needing calibration against real (or
 * realistic synthetic) sample invoice PDFs before relying on it; an
 * arbitrary threshold either dumps too much into Exceptions/Unreadable or
 * lets bad extractions through to matching.
 */
export const EXTRACTION_CONFIDENCE_THRESHOLD = 0.75;
