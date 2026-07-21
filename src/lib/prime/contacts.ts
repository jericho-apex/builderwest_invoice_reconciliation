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
 * NEEDS VENDOR CONFIRMATION: Prime's docs do not document an `abn` field or the
 * exact contact name field as queryable (see prime-api-gaps.md, open question
 * Q2), so the field names below are unconfirmed. The `q=` filter SYNTAX is
 * correct. Supplier resolution is ABN first, name fallback (PRD §4.1); anything
 * unresolved routes to Exceptions/Supplier not found rather than guessing.
 */
async function findContactByField(
  field: string,
  value: string,
  context: AuditContext,
): Promise<PrimeContact | undefined> {
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

  return response.data[0] ? mapContact(response.data[0]) : undefined;
}

export function findContactByAbn(abn: string, context: AuditContext): Promise<PrimeContact | undefined> {
  return findContactByField("abn", abn, context);
}

export function findContactByName(
  name: string,
  context: AuditContext,
): Promise<PrimeContact | undefined> {
  return findContactByField("name", name, context);
}
