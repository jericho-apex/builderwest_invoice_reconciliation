import { findContactByAbn, findContactByName } from "../prime/contacts.js";
import type { PrimeContact } from "../prime/contacts.js";
import type { AuditContext } from "../prime/workOrders.js";

export type SupplierResolution =
  | { status: "matched_by_abn"; contact: PrimeContact }
  | { status: "matched_by_name"; contact: PrimeContact }
  | { status: "not_found" };

export interface SupplierResolutionInput {
  abn: string | null;
  name: string | null;
}

/** Resolves the supplier by ABN first, name as fallback (PRD §4.1 step 4b). */
export async function resolveSupplier(
  input: SupplierResolutionInput,
  context: AuditContext,
): Promise<SupplierResolution> {
  if (input.abn) {
    const byAbn = await findContactByAbn(input.abn, context);
    if (byAbn) {
      return { status: "matched_by_abn", contact: byAbn };
    }
  }

  if (input.name) {
    const byName = await findContactByName(input.name, context);
    if (byName) {
      return { status: "matched_by_name", contact: byName };
    }
  }

  return { status: "not_found" };
}
