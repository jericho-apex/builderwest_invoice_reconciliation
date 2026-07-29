import { findContactsByAbn, findContactsByName } from "../prime/contacts.js";
import type { PrimeContact } from "../prime/contacts.js";
import type { AuditContext } from "../prime/workOrders.js";
import { loadEnv } from "../../config/env.js";
import { normalizeAbn, isValidAbn, abnQueryCandidates } from "./abn.js";

export type SupplierResolution =
  | { status: "matched_by_abn"; contact: PrimeContact }
  | { status: "matched_by_name"; contact: PrimeContact }
  /**
   * Several contacts carry the invoice's supplier name, and exactly one of them
   * is the contact the matched work order is assigned to. Distinct from
   * matched_by_name so a reader can tell that a tie was broken and on what.
   */
  | { status: "matched_by_assignment"; contact: PrimeContact }
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
  /**
   * The contact the matched work order is assigned to, used only as a
   * tie-breaker — see resolveSupplier. Absent when no work order resolved, in
   * which case supplier resolution never runs anyway.
   */
  workOrderAssignedId?: string;
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
 * THE ASSIGNMENT TIE-BREAK. Builderwest's production Prime holds four contacts
 * named "Ryan Smith", so the name lookup alone cannot resolve their own
 * auto-approve invoice. Where several contacts share the name and exactly one of
 * them is the contact the matched work order is ASSIGNED to, that one is taken.
 *
 * What makes this safe rather than a dressed-up `data[0]`: the candidate set is
 * already restricted to contacts whose name matches the invoice, so the
 * tie-break can only ever choose among suppliers the invoice itself names. It
 * cannot introduce an unrelated party, and it cannot fire when the name matched
 * nobody — no name match means no corroboration, which is still not_found.
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
    // Both stored formats, unioned by contact id. Production holds the ABN
    // ATO-grouped, so querying only the digits found nothing — see
    // abnQueryCandidates. Deduping matters for the same reason it does in
    // resolveWorkOrder: one contact returned by both queries must count once, or
    // a resolvable supplier would look ambiguous.
    const byId = new Map<string, PrimeContact>();
    for (const candidate of abnQueryCandidates(abn)) {
      for (const contact of await findContactsByAbn(candidate, context)) {
        byId.set(contact.id, contact);
      }
    }

    const byAbn = soleMatch([...byId.values()]);
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

    // Only ever narrows an existing set of name matches — never a lookup of its
    // own, and never reached when the name matched nobody.
    if (input.workOrderAssignedId) {
      const assigned = soleMatch(
        byNameCandidates.filter((contact) => contact.id === input.workOrderAssignedId),
      );
      if (assigned) {
        return { status: "matched_by_assignment", contact: assigned };
      }
    }
  }

  if (loadEnv().ASSUME_SUPPLIER_MATCHED) {
    return { status: "assumed", candidateCount: nameCandidateCount };
  }

  return { status: "not_found" };
}
