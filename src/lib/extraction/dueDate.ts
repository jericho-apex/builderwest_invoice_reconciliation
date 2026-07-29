/**
 * Due-date resolution for invoices that state payment TERMS instead of a date.
 *
 * The AP-invoice create call requires a due date, and approve.ts's pre-flight
 * refuses to write without one — so an invoice with no due date routes to
 * Exceptions/Unreadable before any Prime call. That is the correct default, but
 * it fails a whole class of real invoices: 26.pdf (Hutchy Ceilings) prints
 * "Due in 30 Days" in its terms column and leaves the due-date cell empty.
 *
 * So the model is asked for the NUMBER of days only and the arithmetic happens
 * here. Deliberately not in the prompt: date arithmetic is a known weak spot for
 * language models, and a derived due date on a money path has to be reproducible
 * from the invoice by anyone auditing it.
 *
 * Nothing here ever overrides a printed due date, and every refusal falls back to
 * null — which routes to a human rather than inventing a payment date.
 */

/** ISO 8601 calendar dates only — the shape the extraction prompt demands. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MS_PER_DAY = 86_400_000;

/**
 * Terms beyond this are treated as a misread rather than a real arrangement.
 * Australian trade terms run to 7/14/30/60/90 days; a four-digit figure is far
 * more likely to be a wrongly-read invoice number than an agreement to pay in
 * three years. Refusing sends the invoice to a human, which is the safe side.
 */
const MAX_PAYMENT_TERMS_DAYS = 365;

export type DueDateSource = "extracted" | "payment_terms" | "absent";

export interface ResolvedDueDate {
  /** ISO 8601 (YYYY-MM-DD), or null when no due date could be established. */
  readonly value: string | null;
  readonly source: DueDateSource;
}

/** Parses an ISO date to a UTC timestamp, rejecting anything that doesn't round-trip. */
function parseIsoDateUtc(value: string): number | undefined {
  const match = ISO_DATE.exec(value.trim());
  if (!match) {
    return undefined;
  }

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const timestamp = Date.UTC(year, month - 1, day);
  const parsed = new Date(timestamp);

  // Date.UTC silently rolls over out-of-range components — 2026-02-31 becomes
  // 2026-03-03. Requiring the round-trip means an impossible printed date is
  // refused rather than quietly shifted.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return undefined;
  }

  return timestamp;
}

/**
 * The due date to persist: the printed one if there is one, otherwise the invoice
 * date advanced by the stated payment terms.
 *
 * All arithmetic is UTC, so the result cannot shift by a day depending on where
 * the worker happens to run.
 */
export function resolveDueDate(
  invoiceDate: string | null,
  dueDate: string | null,
  paymentTermsDays: number | null,
): ResolvedDueDate {
  // A printed due date always wins — it is what the supplier actually asked for.
  if (dueDate !== null && dueDate.trim() !== "") {
    return { value: dueDate.trim(), source: "extracted" };
  }

  if (
    invoiceDate === null ||
    paymentTermsDays === null ||
    !Number.isInteger(paymentTermsDays) ||
    paymentTermsDays < 0 ||
    paymentTermsDays > MAX_PAYMENT_TERMS_DAYS
  ) {
    return { value: null, source: "absent" };
  }

  const invoiceTimestamp = parseIsoDateUtc(invoiceDate);
  if (invoiceTimestamp === undefined) {
    return { value: null, source: "absent" };
  }

  const due = new Date(invoiceTimestamp + paymentTermsDays * MS_PER_DAY);
  return { value: due.toISOString().slice(0, 10), source: "payment_terms" };
}
