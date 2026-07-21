import type { PrimeWorkOrder } from "../prime/workOrders.js";

export type CostToleranceMode = "exact" | "dollar" | "percentage";
export type CostField = "cost" | "costTaxTotal";

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
 * implementation plan). Which Prime field is authoritative (`cost` vs
 * `costTaxTotal`, PRD §9.6) is a config value, not hardcoded, so resolving
 * that question with the client later needs no code change.
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
    costField === "cost" ? workOrder.costCents : workOrder.costTaxTotalCents;
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
