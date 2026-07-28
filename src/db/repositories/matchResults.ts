import { getDb } from "../client.js";

// "ambiguous" = the lookup returned more than one work order, so none of them
// can be trusted as THE match. It routes to the same Exceptions/No work order
// folder as "not_found" (accounts staff work one folder either way), but is
// recorded distinctly so the two are tellable apart afterwards.
export type WorkOrderMatchStatus = "matched" | "not_found" | "ambiguous";
// "not_attempted" = work-order resolution failed first, so supplier resolution never ran.
// Distinct from "not_found", which means we asked Prime and it had nobody. Recording
// "not_found" for a lookup that never happened is the kind of wrong signal this pilot
// exists to avoid — a human triaging Exceptions/No work order would otherwise conclude
// the supplier is missing from Prime on no evidence at all.
export type SupplierMatchStatus =
  | "matched_by_abn"
  | "matched_by_name"
  | "not_found"
  | "not_attempted";
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
