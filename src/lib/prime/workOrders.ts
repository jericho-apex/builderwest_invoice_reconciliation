import { primeRequest } from "./httpClient.js";
import { appendAuditLog, type AuditLogInput } from "../../db/repositories/auditLog.js";

export type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

export interface PrimeWorkOrder {
  id: string;
  costCents: number;
  costTaxTotalCents: number;
  estimateId?: string;
}

interface PrimeWorkOrderApiRow {
  id: string;
  cost: number;
  costTaxTotal: number;
  estimateId?: string;
}

interface PrimeListResponse<T> {
  data: T[];
}

function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

function mapWorkOrder(row: PrimeWorkOrderApiRow): PrimeWorkOrder {
  return {
    id: row.id,
    costCents: toCents(row.cost),
    costTaxTotalCents: toCents(row.costTaxTotal),
    estimateId: row.estimateId,
  };
}

/**
 * ASSUMPTION FLAGGED FOR VERIFICATION: the filter query param names below
 * (`filter[reference]`, `filter[jobNumber]`) are placeholders — the PRD
 * excerpt available while building this documents the work-orders object's
 * key fields (cost, costTaxTotal, estimateId) but not its query/filter
 * syntax. Confirm the real filter param names against Prime's API reference
 * before relying on these lookups; a wrong param name fails safe (no match
 * found -> routes to Exceptions/No work order) rather than silently
 * matching the wrong record, but it will misroute everything until fixed.
 */
async function findWorkOrderByFilter(
  filter: Record<string, string>,
  context: AuditContext,
): Promise<PrimeWorkOrder | undefined> {
  const response = await primeRequest<PrimeListResponse<PrimeWorkOrderApiRow>>({
    method: "GET",
    path: "/work-orders",
    query: filter,
  });

  appendAuditLog({
    ...context,
    eventType: "prime.find_work_order",
    detail: { filter, matchCount: response.data.length },
  });

  return response.data[0] ? mapWorkOrder(response.data[0]) : undefined;
}

export function findWorkOrderByReference(
  reference: string,
  context: AuditContext,
): Promise<PrimeWorkOrder | undefined> {
  return findWorkOrderByFilter({ "filter[reference]": reference }, context);
}

export function findWorkOrderByJobNumber(
  jobNumber: string,
  context: AuditContext,
): Promise<PrimeWorkOrder | undefined> {
  return findWorkOrderByFilter({ "filter[jobNumber]": jobNumber }, context);
}
