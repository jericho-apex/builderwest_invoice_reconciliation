import { primeRequest } from "./httpClient.js";
import { buildEqQuery } from "./query.js";
import { loadEnv } from "../../config/env.js";
import { appendAuditLog, type AuditLogInput } from "../../db/repositories/auditLog.js";

export type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

export interface PrimeWorkOrder {
  id: string;
  costCents: number;
  costTaxTotalCents: number;
  estimateId?: string;
  jobId?: string;
}

// Prime v2 responses are JSON:API-shaped: the resource id is top-level and the
// data fields live under `attributes` (media type application/vnd.api.v2+json).
interface PrimeWorkOrderApiRow {
  id: string;
  attributes: {
    cost?: number;
    costTaxTotal?: number;
    estimateId?: string;
    jobId?: string;
  };
}

interface PrimeListResponse<T> {
  data: T[];
}

function toCents(dollars: number | undefined): number {
  return dollars === undefined ? 0 : Math.round(dollars * 100);
}

function mapWorkOrder(row: PrimeWorkOrderApiRow): PrimeWorkOrder {
  return {
    id: row.id,
    // `cost` (ex-tax) is NOT documented as a work-order field — only
    // `costTaxTotal` is. COST_FIELD defaults to costTaxTotal for this reason;
    // costCents falls back to 0 if the field is absent (see prime-api-gaps.md).
    costCents: toCents(row.attributes.cost),
    costTaxTotalCents: toCents(row.attributes.costTaxTotal),
    estimateId: row.attributes.estimateId,
    jobId: row.attributes.jobId,
  };
}

/**
 * Returns EVERY matching work order, not just the first. Callers decide what
 * to do with a multi-match — silently taking `data[0]` is how an invoice ends
 * up approved against the wrong work order, which on this money path is worse
 * than not matching at all (see matching/resolveWorkOrder.ts).
 *
 * NEEDS VENDOR CONFIRMATION: which work-order field holds the purchase order
 * number. Prime's docs list `estimateId`, `estimateItemId`, `estimateLabel`,
 * `costTaxTotal` as queryable — but do NOT document a purchase-order field
 * (see prime-api-gaps.md, open question Q1), which is why the field name comes
 * from `PRIME_WORK_ORDER_PO_FIELD` rather than being hardcoded. The `q=` filter
 * SYNTAX itself is correct. A wrong field name fails safe (no match -> routes
 * to Exceptions/No work order) but will misroute everything until confirmed.
 */
async function findWorkOrdersByField(
  field: string,
  value: string,
  context: AuditContext,
): Promise<PrimeWorkOrder[]> {
  const q = buildEqQuery(field, value);
  const response = await primeRequest<PrimeListResponse<PrimeWorkOrderApiRow>>({
    method: "GET",
    path: "/work-orders",
    query: { q },
  });

  appendAuditLog({
    ...context,
    eventType: "prime.find_work_order",
    detail: { q, matchCount: response.data.length },
  });

  return response.data.map(mapWorkOrder);
}

/**
 * The one work-order lookup the matching engine performs. The purchase order
 * number is the only identifier on a supplier invoice that names a single work
 * order — a job number is shared by every work order on that job.
 */
export function findWorkOrdersByPurchaseOrder(
  purchaseOrderNumber: string,
  context: AuditContext,
): Promise<PrimeWorkOrder[]> {
  return findWorkOrdersByField(
    loadEnv().PRIME_WORK_ORDER_PO_FIELD,
    purchaseOrderNumber,
    context,
  );
}
