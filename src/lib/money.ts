/**
 * Money is integer cents end to end (the *_cents columns and fields) — never
 * floats. GST math is exactly where floating-point rounding produces false
 * mismatches, and a false mismatch here means a correct invoice gets flagged.
 *
 * One conversion point, so extraction (dollars, as printed on the PDF) and the
 * rest of the pipeline (cents) cannot drift apart.
 */
export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}
