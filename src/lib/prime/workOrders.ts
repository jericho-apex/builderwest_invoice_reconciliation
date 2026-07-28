import { primeRequest } from "./httpClient.js";
import { buildEqQuery } from "./query.js";
import { loadEnv } from "../../config/env.js";
import { appendAuditLog, type AuditLogInput } from "../../db/repositories/auditLog.js";

export type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

export interface PrimeWorkOrder {
  id: string;
  /** Ex-GST cost total. */
  costTotalCents: number;
  /** The GST portion ONLY — not a tax-inclusive total. See mapWorkOrder. */
  costTaxTotalCents: number;
  estimateId?: string;
  jobId?: string;
  /**
   * The contact this work order is assigned to. Used by resolveSupplier ONLY to
   * break a tie between contacts that already match the invoice's supplier name
   * — never as a supplier lookup in its own right.
   */
  assignedId?: string;
}

// Prime v2 responses are JSON:API-shaped: the resource id is top-level and the
// data fields live under `attributes` (media type application/vnd.api.v2+json).
//
// Amounts arrive in DOLLARS and inconsistently typed — `costTotal` as a JSON
// number, `costTaxTotal` as a decimal string ("43.50") — hence the union below.
interface PrimeWorkOrderApiRow {
  id: string;
  attributes: {
    costTotal?: number | string;
    costTaxTotal?: number | string;
    estimateId?: string;
    jobId?: string;
    assignedId?: string;
  };
}

interface PrimeListResponse<T> {
  data: T[];
}

/**
 * Dollars (number or decimal string) -> integer cents.
 *
 * An absent or unparseable amount becomes 0 rather than throwing. That is
 * deliberate: 0 can only ever produce a cost MISMATCH, which routes the invoice
 * to a human, whereas throwing would leave the invoice stuck being retried
 * every tick. Nothing here can widen what counts as a match.
 */
function toCents(dollars: number | string | undefined): number {
  if (dollars === undefined || dollars === null) {
    return 0;
  }
  const value = typeof dollars === "string" ? Number(dollars) : dollars;
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/**
 * VERIFIED LIVE 2026-07-28 against production Prime. A work order carries
 * `costTotal` (ex-GST, e.g. 435 on PO21266) and `costTaxTotal` (the GST amount
 * ONLY, e.g. "43.50") — there is no `cost` field, and `costTaxTotal` is NOT a
 * tax-inclusive total despite the name. The inc-GST figure a supplier invoice
 * prints is the sum of the two ($478.50), which is what COST_FIELD's default
 * `costTotalIncTax` compares against; see matching/compareCost.ts.
 *
 * The earlier reading of this — `cost` for ex-tax, `costTaxTotal` for inc-tax —
 * silently compared invoice totals against a GST amount, so a correct invoice
 * could never match.
 */
function mapWorkOrder(row: PrimeWorkOrderApiRow): PrimeWorkOrder {
  return {
    id: row.id,
    costTotalCents: toCents(row.attributes.costTotal),
    costTaxTotalCents: toCents(row.attributes.costTaxTotal),
    estimateId: row.attributes.estimateId,
    jobId: row.attributes.jobId,
    assignedId: row.attributes.assignedId,
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
