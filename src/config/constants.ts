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
  xeroSyncFailed: "Exceptions/Xero sync failed",
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
 * How many times to poll Prime's isSynced field after approval before giving
 * up and routing to Exceptions/Xero sync failed as a persistent failure. One
 * check happens per worker tick (not a tight in-call loop), so this many
 * attempts spans roughly this-many-ticks worth of wall-clock time at the
 * default 10-15 minute poll interval.
 */
export const MAX_SYNC_POLL_ATTEMPTS = 10;

/**
 * Extraction confidence below this threshold is treated as a failure and
 * routed to Exceptions/Unreadable rather than trusted. PLACEHOLDER — the
 * implementation plan flags this as needing calibration against real (or
 * realistic synthetic) sample invoice PDFs before relying on it; an
 * arbitrary threshold either dumps too much into Exceptions/Unreadable or
 * lets bad extractions through to matching.
 */
export const EXTRACTION_CONFIDENCE_THRESHOLD = 0.75;
