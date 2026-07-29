import { findWorkOrdersByPurchaseOrder } from "../prime/workOrders.js";
import type { PrimeWorkOrder, AuditContext } from "../prime/workOrders.js";
import { purchaseOrderCandidates } from "./purchaseOrder.js";

export type WorkOrderResolution =
  | {
      status: "matched";
      workOrder: PrimeWorkOrder;
      /** Which candidate label Prime matched on. */
      matchedLabel: string;
      /**
       * True when the sole match came from the bridged form rather than the form
       * the invoice printed — i.e. the PO-prefix bridge is what made this match.
       * Recorded so approving against a label that isn't literally what the
       * invoice printed is never silent.
       */
      matchedViaPrefixBridge: boolean;
      candidateLabels: readonly string[];
    }
  | { status: "not_found"; candidateLabels: readonly string[] }
  | { status: "ambiguous"; matchCount: number; candidateLabels: readonly string[] };

/**
 * Resolves the work order from the purchase order number printed on the
 * invoice — the only identifier that names ONE work order (PRD §4.1 step 4a).
 *
 * There is deliberately no job-number fallback. A job carries many work orders
 * (the client's two dummy invoices are Stage 1 and Stage 2 of job BWC-5126,
 * differing only by PO), so falling back to the job number would let an
 * invoice match a sibling work order and be approved against the wrong one.
 * A fallback that can hit the wrong work order is worse than no fallback.
 *
 * For the same reason, anything other than exactly one match is unresolved:
 * a missing PO and a zero-match lookup are `not_found`, and a multi-match is
 * `ambiguous` — never the first row.
 *
 * THE PO-PREFIX BRIDGE. Builderwest's POs always start with "PO" but suppliers
 * sometimes omit it, and Prime's own labels are split the same way (dummy work
 * orders "PO21266", most production rows a bare "17651"). So each candidate form
 * from matching/purchaseOrder.ts is looked up and the results UNIONED before the
 * exactly-one rule is applied.
 *
 * Why that stays safe on a money path: the printed form is queried first and the
 * second query only ADDS to the candidate set, so the union is a superset of what
 * a single query returned. Any invoice that resolves to work order X today still
 * has X in its union. The only reachable changes are not_found -> matched (the
 * fix), not_found -> ambiguous and matched -> ambiguous (both fail safe, to a
 * human). matched(X) -> matched(Y) cannot happen.
 *
 * Every candidate is queried unconditionally — no short-circuit on the first
 * non-empty result. Stopping early would be `data[0]` reintroduced one layer up:
 * if Prime held both a "PO17651" and a "17651" work order, both are consistent
 * with the invoice, and the order of our own candidate list would decide which
 * one got the money. It also keeps `matchCount` the true number of work orders
 * consistent with this invoice rather than the number the first query happened
 * to see. The cost is at most one extra GET per invoice.
 *
 * Sequential, not concurrent: the Prime limiter's 5-concurrent cap is global
 * across in-flight invoices, so firing both at once doubles this invoice's share
 * of that window to save wall-clock that is meaningless at a 10-minute poll
 * interval. It also keeps the prime.find_work_order audit rows in a readable
 * order.
 */
export async function resolveWorkOrder(
  purchaseOrderNumber: string | null,
  context: AuditContext,
): Promise<WorkOrderResolution> {
  const { labels } = purchaseOrderCandidates(purchaseOrderNumber);

  if (labels.length === 0) {
    // No PO printed, so Prime was never asked — the empty array says so.
    return { status: "not_found", candidateLabels: labels };
  }

  // Union by work-order id. This dedupe is load-bearing, not tidiness: if Prime's
  // `eq` turns out to be case- or format-insensitive in any way, the same work
  // order comes back from both queries, and counting rows instead of distinct
  // ids would report matchCount 2 and route a perfectly good invoice to
  // Exceptions/No work order — a false negative manufactured by our own second
  // query.
  const byId = new Map<string, PrimeWorkOrder>();
  let matchedLabel: string | undefined;

  for (const label of labels) {
    for (const workOrder of await findWorkOrdersByPurchaseOrder(label, context)) {
      if (!byId.has(workOrder.id)) {
        byId.set(workOrder.id, workOrder);
        // Which candidate first surfaced it. Only meaningful when the union ends
        // up holding exactly one work order.
        matchedLabel ??= label;
      }
    }
  }

  if (byId.size === 1) {
    return {
      status: "matched",
      workOrder: [...byId.values()][0]!,
      matchedLabel: matchedLabel!,
      matchedViaPrefixBridge: matchedLabel !== labels[0],
      candidateLabels: labels,
    };
  }

  if (byId.size > 1) {
    return { status: "ambiguous", matchCount: byId.size, candidateLabels: labels };
  }

  return { status: "not_found", candidateLabels: labels };
}
