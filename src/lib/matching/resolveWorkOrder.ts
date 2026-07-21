import { findWorkOrderByReference, findWorkOrderByJobNumber } from "../prime/workOrders.js";
import type { PrimeWorkOrder, AuditContext } from "../prime/workOrders.js";

export type WorkOrderResolution =
  | { status: "matched"; workOrder: PrimeWorkOrder }
  | { status: "not_found" };

/**
 * Resolves the work order by its reference, falling back to job number if
 * the reference lookup misses (PRD §4.1 step 4a). A missing or empty
 * reference is treated the same as a failed lookup — never a guess.
 */
export async function resolveWorkOrder(
  workOrderRef: string | null,
  context: AuditContext,
): Promise<WorkOrderResolution> {
  if (!workOrderRef) {
    return { status: "not_found" };
  }

  const byReference = await findWorkOrderByReference(workOrderRef, context);
  if (byReference) {
    return { status: "matched", workOrder: byReference };
  }

  const byJobNumber = await findWorkOrderByJobNumber(workOrderRef, context);
  if (byJobNumber) {
    return { status: "matched", workOrder: byJobNumber };
  }

  return { status: "not_found" };
}
