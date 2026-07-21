import { primeRequest } from "./httpClient.js";
import { buildEqQuery } from "./query.js";
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
 * NEEDS VENDOR CONFIRMATION: which work-order field the invoice's human-facing
 * reference / job number maps to. Prime's docs list `estimateId`,
 * `estimateItemId`, `estimateLabel`, `costTaxTotal` as queryable — but do NOT
 * document a `reference` or `jobNumber` field, so the field names below are
 * unconfirmed (see prime-api-gaps.md, open question Q1). The `q=` filter
 * SYNTAX itself is correct. A wrong field name fails safe (no match -> routes
 * to Exceptions/No work order) but will misroute everything until confirmed.
 */
async function findWorkOrderByField(
  field: string,
  value: string,
  context: AuditContext,
): Promise<PrimeWorkOrder | undefined> {
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

  return response.data[0] ? mapWorkOrder(response.data[0]) : undefined;
}

export function findWorkOrderByReference(
  reference: string,
  context: AuditContext,
): Promise<PrimeWorkOrder | undefined> {
  return findWorkOrderByField("reference", reference, context);
}

export function findWorkOrderByJobNumber(
  jobNumber: string,
  context: AuditContext,
): Promise<PrimeWorkOrder | undefined> {
  return findWorkOrderByField("jobNumber", jobNumber, context);
}
