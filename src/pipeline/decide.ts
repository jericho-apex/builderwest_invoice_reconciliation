import { loadEnv } from "../config/env.js";
import type { ExceptionReason } from "../config/constants.js";
import type { MatchResultInput } from "../db/repositories/matchResults.js";
import { resolveWorkOrder } from "../lib/matching/resolveWorkOrder.js";
import { resolveSupplier } from "../lib/matching/resolveSupplier.js";
import { compareCost } from "../lib/matching/compareCost.js";
import type { CostComparisonResult } from "../lib/matching/compareCost.js";
import type { PrimeWorkOrder, AuditContext } from "../lib/prime/workOrders.js";
import type { PrimeContact } from "../lib/prime/contacts.js";

/** The extracted fields matching keys off — nothing else from the invoices row is read. */
export interface DecisionFields {
  purchaseOrderNumber: string | null;
  supplierAbn: string | null;
  supplierName: string | null;
  totalAmountCents: number;
}

/** A match_results row minus the invoice it belongs to — decide.ts never writes one. */
export type MatchResultPayload = Omit<MatchResultInput, "invoiceId">;

/** An audit row the decision earned but did not write; the caller appends these, in order. */
export interface DecisionAuditEvent {
  eventType: string;
  detail: Record<string, unknown>;
}

/** The only reasons matching itself can produce — never "unreadable" or "xeroSyncFailed". */
export type MatchExceptionReason = Extract<
  ExceptionReason,
  "noWorkOrder" | "supplierNotFound" | "costMismatch"
>;

export type MatchDecision =
  | {
      outcome: "approve";
      workOrder: PrimeWorkOrder;
      /** Absent only when supplierMatchStatus is "assumed" — there is no verified contact to report. */
      contact?: PrimeContact;
      supplierMatchStatus: "matched_by_abn" | "matched_by_name" | "assumed";
      cost: CostComparisonResult;
      matchResult: MatchResultPayload;
      auditEvents: DecisionAuditEvent[];
    }
  | {
      outcome: "exception";
      reason: MatchExceptionReason;
      /** Present only for the stages actually reached before the decision was made. */
      workOrder?: PrimeWorkOrder;
      contact?: PrimeContact;
      cost?: CostComparisonResult;
      matchResult: MatchResultPayload;
      auditEvents: DecisionAuditEvent[];
    };

/**
 * The matching decision core: work order -> supplier -> cost, stopping at the
 * first check that fails (PRD §4.1). Given extracted invoice fields, it says
 * what should happen and hands back the match_results payload and audit rows
 * for the caller to persist.
 *
 * It records no DECISION state — no match_results row, no invoices update, and
 * crucially no Graph call. That last part is why this function exists as a
 * separate unit: GRAPH_BASE_URL is a hardcoded const, so anything that moves a
 * message can only ever run against the live mailbox. Everything up to the
 * decision can run outside the worker (see scripts/pipeline-sample.ts), and
 * everything after it cannot.
 *
 * It is not side-effect free: the Prime finders each append an audit_log row of
 * their own, so a migrated database still has to exist.
 *
 * The audit events come back as data rather than being written here because
 * pipeline.work_order_unresolved carries a matchCount the caller has no way to
 * reconstruct.
 */
export async function decideMatch(
  fields: DecisionFields,
  context: AuditContext,
): Promise<MatchDecision> {
  const workOrderResolution = await resolveWorkOrder(fields.purchaseOrderNumber, context);

  // "ambiguous" (several work orders share this PO) shares the folder with
  // "not_found" — the human action is the same, and it is recorded distinctly
  // in match_results. What it must NOT do is pick one.
  if (workOrderResolution.status !== "matched") {
    return {
      outcome: "exception",
      reason: "noWorkOrder",
      matchResult: {
        workOrderMatchStatus: workOrderResolution.status,
        // Not "not_found": the PO never resolved, so Prime was never asked
        // about this supplier at all.
        supplierMatchStatus: "not_attempted",
        decision: "exception",
        exceptionReason: "noWorkOrder",
      },
      auditEvents: [
        {
          eventType: "pipeline.work_order_unresolved",
          detail: {
            status: workOrderResolution.status,
            purchaseOrderNumber: fields.purchaseOrderNumber,
            matchCount:
              workOrderResolution.status === "ambiguous" ? workOrderResolution.matchCount : 0,
          },
        },
      ],
    };
  }

  const workOrder = workOrderResolution.workOrder;

  const supplierResolution = await resolveSupplier(
    { abn: fields.supplierAbn, name: fields.supplierName },
    context,
  );
  if (supplierResolution.status === "not_found") {
    return {
      outcome: "exception",
      reason: "supplierNotFound",
      workOrder,
      matchResult: {
        workOrderMatchStatus: "matched",
        workOrderId: workOrder.id,
        supplierMatchStatus: "not_found",
        decision: "exception",
        exceptionReason: "supplierNotFound",
      },
      auditEvents: [],
    };
  }

  // ASSUME_SUPPLIER_MATCHED reached here: the supplier did not resolve and we
  // are continuing anyway, so say so in the audit trail. Without this row the
  // only trace is a match_results status, and a reader reconstructing why an
  // invoice was approved would have no record of what was skipped or why.
  const supplierAuditEvents: DecisionAuditEvent[] =
    supplierResolution.status === "assumed"
      ? [
          {
            eventType: "pipeline.supplier_assumed",
            detail: {
              supplierName: fields.supplierName,
              supplierAbn: fields.supplierAbn,
              nameCandidateCount: supplierResolution.candidateCount,
              workOrderId: workOrder.id,
            },
          },
        ]
      : [];

  const contact = supplierResolution.status === "assumed" ? undefined : supplierResolution.contact;

  const env = loadEnv();
  const cost = compareCost(
    fields.totalAmountCents,
    workOrder,
    env.COST_FIELD,
    env.COST_TOLERANCE_MODE,
    env.COST_TOLERANCE_VALUE,
  );

  const costColumns = {
    workOrderMatchStatus: "matched",
    workOrderId: workOrder.id,
    supplierMatchStatus: supplierResolution.status,
    supplierContactId: contact?.id,
    costFieldUsed: cost.costField,
    invoiceTotalCents: cost.invoiceTotalCents,
    workOrderCostCents: cost.workOrderCostCents,
    costDifferenceCents: cost.differenceCents,
  } as const;

  if (!cost.withinTolerance) {
    return {
      outcome: "exception",
      reason: "costMismatch",
      workOrder,
      contact,
      cost,
      matchResult: {
        ...costColumns,
        withinTolerance: false,
        decision: "exception",
        exceptionReason: "costMismatch",
      },
      auditEvents: supplierAuditEvents,
    };
  }

  return {
    outcome: "approve",
    workOrder,
    contact,
    supplierMatchStatus: supplierResolution.status,
    cost,
    matchResult: {
      ...costColumns,
      withinTolerance: true,
      decision: "approve",
    },
    auditEvents: supplierAuditEvents,
  };
}
