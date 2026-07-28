/**
 * ABN handling for supplier matching.
 *
 * An ABN is only useful as a lookup key if it's actually an ABN. The client's
 * own dummy invoices print "00 000 000 000" — a placeholder — on invoices from
 * two DIFFERENT suppliers. Keying on that resolves both invoices to whichever
 * contact happens to carry it, i.e. the wrong supplier for at least one of
 * them. Validating before use makes resolveSupplier fall through to the name
 * lookup instead, which is correct.
 *
 * Failing validation is never itself an exception — it only means the ABN
 * isn't trustworthy enough to match on.
 */

/** Weights for the ATO's ABN checksum, applied left to right. */
const CHECKSUM_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;

/** Strips formatting (spaces, dots, dashes) so "00 000 000 000" -> "00000000000". */
export function normalizeAbn(raw: string): string {
  return raw.replace(/\D/g, "");
}

/**
 * The ATO's published ABN check: 11 digits, subtract 1 from the first digit,
 * multiply each digit by its weight, and the sum must be divisible by 89.
 * Expects already-normalized digits — call normalizeAbn first.
 *
 * The all-zeros guard is redundant against the checksum (0 - 1 = -1 gives a
 * sum of -10, not divisible by 89) but is kept explicit: a placeholder ABN is
 * the case this function exists for, and it should be obvious at a glance that
 * it's rejected.
 */
export function isValidAbn(digits: string): boolean {
  if (!/^\d{11}$/.test(digits)) {
    return false;
  }

  if (/^0+$/.test(digits)) {
    return false;
  }

  const weighted = CHECKSUM_WEIGHTS.reduce((sum, weight, index) => {
    const digit = Number(digits[index]) - (index === 0 ? 1 : 0);
    return sum + digit * weight;
  }, 0);

  return weighted % 89 === 0;
}
