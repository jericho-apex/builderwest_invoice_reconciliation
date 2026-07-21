import { primeRequest } from "./httpClient.js";
import { appendAuditLog } from "../../db/repositories/auditLog.js";
import type { AuditContext } from "./workOrders.js";

export interface PrimeContact {
  id: string;
  name: string;
  abn?: string;
  xeroRef?: string;
}

interface PrimeContactApiRow {
  id: string;
  name: string;
  abn?: string;
  xeroRef?: string;
}

interface PrimeListResponse<T> {
  data: T[];
}

function mapContact(row: PrimeContactApiRow): PrimeContact {
  return { id: row.id, name: row.name, abn: row.abn, xeroRef: row.xeroRef };
}

/**
 * ASSUMPTION FLAGGED FOR VERIFICATION: same caveat as workOrders.ts — filter
 * param names are placeholders pending confirmation against Prime's real API
 * reference. Supplier resolution is ABN first, name fallback (PRD §4.1);
 * anything unresolved routes to Exceptions/Supplier not found rather than
 * guessing.
 */
async function findContactByFilter(
  filter: Record<string, string>,
  context: AuditContext,
): Promise<PrimeContact | undefined> {
  const response = await primeRequest<PrimeListResponse<PrimeContactApiRow>>({
    method: "GET",
    path: "/contacts",
    query: filter,
  });

  appendAuditLog({
    ...context,
    eventType: "prime.find_contact",
    detail: { filter, matchCount: response.data.length },
  });

  return response.data[0] ? mapContact(response.data[0]) : undefined;
}

export function findContactByAbn(abn: string, context: AuditContext): Promise<PrimeContact | undefined> {
  return findContactByFilter({ "filter[abn]": abn }, context);
}

export function findContactByName(
  name: string,
  context: AuditContext,
): Promise<PrimeContact | undefined> {
  return findContactByFilter({ "filter[name]": name }, context);
}
