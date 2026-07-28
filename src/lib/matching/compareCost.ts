import type { PrimeWorkOrder } from "../prime/workOrders.js";

export type CostToleranceMode = "exact" | "dollar" | "percentage";

/**
 * Which figure on the Prime work order the invoice total is measured against:
 *
 * - `costTotalIncTax` (default) — `costTotal + costTaxTotal`, i.e. the ex-GST
 *   cost plus its GST. This is the inc-GST figure a supplier invoice prints as
 *   its total, so it is the like-for-like comparison.
 * - `costTotal` — ex-GST only. Compare against this ONLY if the invoice total
 *   being fed in is also ex-GST, or the GST line will read as a mismatch.
 *
 * Prime's `costTaxTotal` (the GST amount alone) is deliberately not an option:
 * no invoice total is ever meaningfully compared against a tax amount, and
 * having it here is what let a correct invoice fail to match.
 */
export type CostField = "costTotal" | "costTotalIncTax";

export interface CostComparisonResult {
  costField: CostField;
  invoiceTotalCents: number;
  workOrderCostCents: number;
  differenceCents: number;
  withinTolerance: boolean;
}

/**
 * Compares the invoice total to the work order's cost figure in integer
 * cents — never floats, since GST math is exactly where floating-point
 * rounding produces false mismatches (a known risk called out in the
 * implementation plan). Summing ex-GST + GST here is exactly that risk, which
 * is why the addition happens in cents and not in dollars upstream.
 *
 * Which figure is authoritative stays a config value (COST_FIELD) rather than
 * being hardcoded — see the CostField docs for what PRD §9.6 turned out to be.
 *
 * A tighter tolerance sends more items to review — it never widens what
 * counts as a match (PRD §4.2: "a tighter tolerance sends more items to
 * review; it never rejects").
 */
export function compareCost(
  invoiceTotalCents: number,
  workOrder: PrimeWorkOrder,
  costField: CostField,
  toleranceMode: CostToleranceMode,
  toleranceValue: number,
): CostComparisonResult {
  const workOrderCostCents =
    costField === "costTotal"
      ? workOrder.costTotalCents
      : workOrder.costTotalCents + workOrder.costTaxTotalCents;
  const differenceCents = Math.abs(invoiceTotalCents - workOrderCostCents);

  let withinTolerance: boolean;
  switch (toleranceMode) {
    case "exact":
      withinTolerance = differenceCents === 0;
      break;
    case "dollar":
      withinTolerance = differenceCents <= Math.round(toleranceValue * 100);
      break;
    case "percentage":
      withinTolerance = differenceCents <= Math.round(workOrderCostCents * (toleranceValue / 100));
      break;
  }

  return { costField, invoiceTotalCents, workOrderCostCents, differenceCents, withinTolerance };
}
