import { findContactsByAbn, findContactsByName } from "../prime/contacts.js";
import type { PrimeContact } from "../prime/contacts.js";
import type { AuditContext } from "../prime/workOrders.js";
import { loadEnv } from "../../config/env.js";
import { normalizeAbn, isValidAbn } from "./abn.js";

export type SupplierResolution =
  | { status: "matched_by_abn"; contact: PrimeContact }
  | { status: "matched_by_name"; contact: PrimeContact }
  /**
   * ASSUME_SUPPLIER_MATCHED only. The supplier did NOT resolve — this says
   * "proceed as though it had", and carries no contact because there is no
   * verified one to carry. `candidateCount` is how many contacts the name
   * lookup did return, so the audit trail records what was waved through.
   */
  | { status: "assumed"; candidateCount: number }
  | { status: "not_found" };

export interface SupplierResolutionInput {
  abn: string | null;
  name: string | null;
}

/** Exactly one match resolves; zero or several do not (see resolveWorkOrder for the reasoning). */
function soleMatch(contacts: PrimeContact[]): PrimeContact | undefined {
  return contacts.length === 1 ? contacts[0] : undefined;
}

/**
 * Resolves the supplier by ABN first, name as fallback (PRD §4.1 step 4b).
 *
 * The ABN is only used as a key once it validates as a real ABN — a
 * placeholder like "00 000 000 000" appears on invoices from different
 * suppliers, so matching on it would resolve them all to the same contact.
 * An unusable ABN just means falling through to the name lookup; it is never
 * an exception in itself.
 *
 * Both lookups still run in full under ASSUME_SUPPLIER_MATCHED — the flag only
 * changes what an unresolved result means, never whether Prime is asked. A
 * genuine single match resolves normally whether the flag is set or not.
 */
export async function resolveSupplier(
  input: SupplierResolutionInput,
  context: AuditContext,
): Promise<SupplierResolution> {
  const abn = input.abn ? normalizeAbn(input.abn) : "";

  if (isValidAbn(abn)) {
    const byAbn = soleMatch(await findContactsByAbn(abn, context));
    if (byAbn) {
      return { status: "matched_by_abn", contact: byAbn };
    }
  }

  let nameCandidateCount = 0;
  if (input.name) {
    const byNameCandidates = await findContactsByName(input.name, context);
    nameCandidateCount = byNameCandidates.length;
    const byName = soleMatch(byNameCandidates);
    if (byName) {
      return { status: "matched_by_name", contact: byName };
    }
  }

  if (loadEnv().ASSUME_SUPPLIER_MATCHED) {
    return { status: "assumed", candidateCount: nameCandidateCount };
  }

  return { status: "not_found" };
}
