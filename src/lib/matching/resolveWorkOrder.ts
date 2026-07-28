import { findWorkOrdersByPurchaseOrder } from "../prime/workOrders.js";
import type { PrimeWorkOrder, AuditContext } from "../prime/workOrders.js";

export type WorkOrderResolution =
  | { status: "matched"; workOrder: PrimeWorkOrder }
  | { status: "not_found" }
  | { status: "ambiguous"; matchCount: number };

/**
 * Resolves the work order from the purchase order number printed on the
 * invoice — the only identifier that names ONE work order (PRD §4.1 step 4a).
 *
 * There is deliberately no job-number fallback. A job carries many work orders
 * (the client's two dummy invoices are Stage 1 and Stage 2 of job BWC-5126,
 * differing only by PO), so falling back to the job number would let an
 * invoice match a sibling work order and be approved against the wrong one.
 * A fallback that can hit the wrong work order is worse than no fallback.
 *
 * For the same reason, anything other than exactly one match is unresolved:
 * a missing PO and a zero-match lookup are `not_found`, and a multi-match is
 * `ambiguous` — never the first row.
 */
export async function resolveWorkOrder(
  purchaseOrderNumber: string | null,
  context: AuditContext,
): Promise<WorkOrderResolution> {
  if (!purchaseOrderNumber) {
    return { status: "not_found" };
  }

  const matches = await findWorkOrdersByPurchaseOrder(purchaseOrderNumber, context);

  if (matches.length === 1) {
    return { status: "matched", workOrder: matches[0]! };
  }

  if (matches.length > 1) {
    return { status: "ambiguous", matchCount: matches.length };
  }

  return { status: "not_found" };
}
