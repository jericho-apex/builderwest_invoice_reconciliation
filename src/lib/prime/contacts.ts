import { primeRequest } from "./httpClient.js";
import { buildEqQuery } from "./query.js";
import { appendAuditLog } from "../../db/repositories/auditLog.js";
import type { AuditContext } from "./workOrders.js";

export interface PrimeContact {
  id: string;
  name?: string;
  abn?: string;
  xeroRef?: string;
}

// JSON:API-shaped, as with work orders: id top-level, fields under attributes.
interface PrimeContactApiRow {
  id: string;
  attributes: {
    name?: string;
    abn?: string;
    xeroRef?: string;
  };
}

interface PrimeListResponse<T> {
  data: T[];
}

function mapContact(row: PrimeContactApiRow): PrimeContact {
  return {
    id: row.id,
    name: row.attributes.name,
    abn: row.attributes.abn,
    xeroRef: row.attributes.xeroRef,
  };
}

/**
 * Returns EVERY matching contact, not just the first — same reasoning as the
 * work-order finder: a multi-match is a question for the caller, not something
 * to resolve by taking `data[0]` and hoping. Suppliers sharing a placeholder
 * ABN is a real case in the client's own test data.
 *
 * NEEDS VENDOR CONFIRMATION: Prime's docs do not document an `abn` field or the
 * exact contact name field as queryable (see prime-api-gaps.md, open question
 * Q2), so the field names below are unconfirmed. The `q=` filter SYNTAX is
 * correct. Supplier resolution is ABN first, name fallback (PRD §4.1); anything
 * unresolved routes to Exceptions/Supplier not found rather than guessing.
 */
async function findContactsByField(
  field: string,
  value: string,
  context: AuditContext,
): Promise<PrimeContact[]> {
  const q = buildEqQuery(field, value);
  const response = await primeRequest<PrimeListResponse<PrimeContactApiRow>>({
    method: "GET",
    path: "/contacts",
    query: { q },
  });

  appendAuditLog({
    ...context,
    eventType: "prime.find_contact",
    detail: { q, matchCount: response.data.length },
  });

  return response.data.map(mapContact);
}

export function findContactsByAbn(abn: string, context: AuditContext): Promise<PrimeContact[]> {
  return findContactsByField("abn", abn, context);
}

export function findContactsByName(
  name: string,
  context: AuditContext,
): Promise<PrimeContact[]> {
  return findContactsByField("name", name, context);
}
