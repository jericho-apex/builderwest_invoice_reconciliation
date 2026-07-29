/**
 * Purchase order string handling for work-order matching.
 *
 * Builderwest confirmed (2026-07-29) that their POs always start with "PO", but
 * that suppliers sometimes omit the prefix when printing one — "as long as it
 * matches it should be okay". Prime's own data has the same split from the other
 * side: the client's dummy work orders are labelled "PO21266", while most
 * production rows carry a bare number ("17651"). Under a single exact
 * `'label'.eq(...)` query that means an invoice printing "PO17651" silently
 * misses work order "17651", and vice versa.
 *
 * So this module turns one printed PO into the (at most two) canonical label
 * forms worth asking Prime about. It is the PO-prefix BRIDGE — it exists to
 * close a formatting difference, not to broaden matching:
 *
 * - It never alters the digits. Separators INSIDE the digits are not stripped
 *   and leading zeros are preserved, because "PO 21 343" -> 21343 and "017651"
 *   -> "17651" are guesses that could name a different work order. Widening what
 *   can match is exactly the failure mode resolveWorkOrder's exactly-one rule
 *   exists to prevent.
 * - Anything that is not "optional PO prefix + digits" is queried verbatim,
 *   byte for byte as before this module existed.
 *
 * Pure: no Prime call, no env read, no audit row. resolveWorkOrder owns the
 * lookups, the union and the verdict.
 */

/** The prefix Builderwest's PO-style work-order labels carry, emitted uppercase. */
const PO_PREFIX = "PO";

/**
 * A purchase order as suppliers actually print it: an OPTIONAL PO prefix
 * followed by digits and NOTHING else. Case-insensitive, and tolerant of the
 * spacing and punctuation seen in the wild — PO21266, po 21343, P.O. 21343,
 * PO#21343, PO-21343, PO No. 21343, PO:21343.
 *
 * ANCHORED, and the tail is `(\d+)$` deliberately. "PO21266/2",
 * "PO21266 Stage 1", "WO-21266", "POD123" and "PO 21 343" all fail this test and
 * fall through to a single verbatim query. That is the point: for those, any
 * canonical form we produced would be invented rather than recovered.
 */
const PRINTED_PURCHASE_ORDER =
  /^(?:P[.\s]*O[.\s]*(?:NO[.\s]*|NUMBER[.\s]*|#\s*)?[-–—_:#]?\s*)?(\d+)$/i;

export interface PurchaseOrderCandidates {
  /** Exactly what the invoice printed, trimmed. Persisted and audited as-is. */
  readonly printed: string;
  /** The digit core, leading zeros intact. Absent when `printed` did not parse. */
  readonly digits?: string;
  /** True when `printed` parsed into optional-prefix + digits. */
  readonly normalized: boolean;
  /** True when the printed form carried the PO prefix. Meaningless unless `normalized`. */
  readonly prefixed: boolean;
  /**
   * The label strings to query, in order — at most TWO, which is what bounds the
   * per-invoice Prime call budget. The form the invoice itself used comes FIRST,
   * so the first lookup is the one the pre-bridge code would have sent. Empty
   * when there is nothing to ask about, in which case Prime is never called.
   */
  readonly labels: readonly string[];
}

/** Blank, whitespace-only and missing are all "the invoice printed no PO". */
function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/**
 * The printed PO -> the canonical label forms to look up.
 *
 * `"PO21266"` -> `["PO21266", "21266"]`, `"17651"` -> `["17651", "PO17651"]`,
 * `"PO21266/2"` -> `["PO21266/2"]`, `null` -> `[]`.
 *
 * `PO_PREFIX + digits` can never equal `digits`, so the two labels are always
 * distinct and no dedupe is needed here.
 */
export function purchaseOrderCandidates(printedValue: string | null): PurchaseOrderCandidates {
  if (isBlank(printedValue)) {
    return { printed: "", normalized: false, prefixed: false, labels: [] };
  }

  const printed = printedValue!.trim();
  const digits = PRINTED_PURCHASE_ORDER.exec(printed)?.[1];

  if (digits === undefined) {
    // Unparseable: behave exactly as the pre-bridge code did — one query, the
    // string as printed. No extra Prime call, no new failure mode.
    return { printed, normalized: false, prefixed: false, labels: [printed] };
  }

  // The regex is anchored and its tail is the digits, so a printed value with no
  // prefix IS its digits. Anything else consumed a prefix.
  const prefixed = printed !== digits;
  const bare = digits;
  const withPrefix = `${PO_PREFIX}${digits}`;

  return {
    printed,
    digits,
    normalized: true,
    prefixed,
    labels: prefixed ? [withPrefix, bare] : [bare, withPrefix],
  };
}

export interface ChosenPurchaseOrder {
  readonly value: string | null;
  readonly source: "extracted" | "work_order_ref";
}

/**
 * Which extracted field to match the work order off.
 *
 * Normally that is `purchaseOrderNumber`. The fallback exists because one of the
 * client's real supplier invoices (369.pdf, Beale4) prints its PO under the
 * label "WO No:", and the extraction prompt tells the model that `workOrderRef`
 * is a separate field and not to copy the PO into it — so a perfectly valid
 * invoice arrives with `purchaseOrderNumber: null` and `workOrderRef:
 * "PO21342"`, and routes to Exceptions/No work order.
 *
 * The fallback is deliberately narrow on both counts:
 *
 * - It NEVER overrides a `purchaseOrderNumber` the model did read. A real PO
 *   always wins.
 * - It requires the reference to carry the PO PREFIX. Builderwest confirmed
 *   their POs always start with "PO", so the prefix is what distinguishes a PO
 *   printed under the wrong label from a genuine work-order reference that
 *   happens to be numeric. A bare number in `workOrderRef` is not treated as a
 *   PO — that would be reading a different identifier as this one.
 */
export function choosePurchaseOrder(
  purchaseOrderNumber: string | null,
  workOrderRef: string | null,
): ChosenPurchaseOrder {
  if (!isBlank(purchaseOrderNumber)) {
    return { value: purchaseOrderNumber!.trim(), source: "extracted" };
  }

  const fromRef = purchaseOrderCandidates(workOrderRef);
  if (fromRef.normalized && fromRef.prefixed) {
    return { value: fromRef.printed, source: "work_order_ref" };
  }

  return { value: null, source: "extracted" };
}
