import { getDb } from "../client.js";

export type WorkOrderMatchStatus = "matched" | "not_found";
export type SupplierMatchStatus = "matched_by_abn" | "matched_by_name" | "not_found";
export type Decision = "approve" | "exception";

export interface MatchResultInput {
  invoiceId: number;
  workOrderMatchStatus: WorkOrderMatchStatus;
  workOrderId?: string;
  supplierMatchStatus: SupplierMatchStatus;
  supplierContactId?: string;
  costFieldUsed?: string;
  invoiceTotalCents?: number;
  workOrderCostCents?: number;
  costDifferenceCents?: number;
  withinTolerance?: boolean;
  decision: Decision;
  exceptionReason?: string;
}

/** Records one matching attempt for an invoice. A retried invoice may accumulate more than one row — the newest is authoritative. */
export function recordMatchResult(input: MatchResultInput): number {
  const result = getDb()
    .prepare(
      `INSERT INTO match_results (
         invoice_id, work_order_match_status, work_order_id,
         supplier_match_status, supplier_contact_id,
         cost_field_used, invoice_total_cents, work_order_cost_cents,
         cost_difference_cents, within_tolerance, decision, exception_reason
       ) VALUES (
         @invoiceId, @workOrderMatchStatus, @workOrderId,
         @supplierMatchStatus, @supplierContactId,
         @costFieldUsed, @invoiceTotalCents, @workOrderCostCents,
         @costDifferenceCents, @withinTolerance, @decision, @exceptionReason
       )`,
    )
    .run({
      invoiceId: input.invoiceId,
      workOrderMatchStatus: input.workOrderMatchStatus,
      workOrderId: input.workOrderId ?? null,
      supplierMatchStatus: input.supplierMatchStatus,
      supplierContactId: input.supplierContactId ?? null,
      costFieldUsed: input.costFieldUsed ?? null,
      invoiceTotalCents: input.invoiceTotalCents ?? null,
      workOrderCostCents: input.workOrderCostCents ?? null,
      costDifferenceCents: input.costDifferenceCents ?? null,
      withinTolerance:
        input.withinTolerance === undefined ? null : input.withinTolerance ? 1 : 0,
      decision: input.decision,
      exceptionReason: input.exceptionReason ?? null,
    });
  return Number(result.lastInsertRowid);
}
