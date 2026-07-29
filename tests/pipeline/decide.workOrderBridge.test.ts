import { describe, it, expect, beforeEach, vi } from "vitest";

// What the DECISION records about work-order resolution — specifically the audit
// trail the PO-prefix bridge is obliged to leave. resolveWorkOrder.test.ts covers
// how resolution reaches these states; this file is about what survives into
// audit_log once it has.
const resolveWorkOrder = vi.fn();
vi.mock("../../src/lib/matching/resolveWorkOrder.js", () => ({
  resolveWorkOrder: (...a: unknown[]) => resolveWorkOrder(...a),
}));

const resolveSupplier = vi.fn();
vi.mock("../../src/lib/matching/resolveSupplier.js", () => ({
  resolveSupplier: (...a: unknown[]) => resolveSupplier(...a),
}));

vi.mock("../../src/config/env.js", () => ({
  loadEnv: () => ({
    COST_FIELD: "costTotalIncTax",
    COST_TOLERANCE_MODE: "exact",
    COST_TOLERANCE_VALUE: 0,
  }),
}));

const { decideMatch } = await import("../../src/pipeline/decide.js");

const context = { messageId: "msg-1" };
const WORK_ORDER = { id: "wo_17651", costTotalCents: 43_500, costTaxTotalCents: 4_350 };
const CONTACT = { id: "contact_hutchy", name: "Hutchy Ceilings Pty Ltd" };

// An invoice printing the prefix against a bare-labelled production work order —
// the case the bridge exists for.
const FIELDS = {
  purchaseOrderNumber: "PO17651",
  supplierAbn: "68628819741",
  supplierName: "Hutchy Ceilings Pty Ltd",
  totalAmountCents: 47_850,
};

const BRIDGED = {
  status: "matched",
  workOrder: WORK_ORDER,
  matchedLabel: "17651",
  matchedViaPrefixBridge: true,
  candidateLabels: ["PO17651", "17651"],
};

describe("decideMatch and the PO-prefix bridge", () => {
  beforeEach(() => {
    resolveWorkOrder.mockReset();
    resolveSupplier.mockReset();
    resolveSupplier.mockResolvedValue({ status: "matched_by_abn", contact: CONTACT });
  });

  // Approving against a label that is not literally what the invoice printed must
  // never be silent — same reasoning as pipeline.supplier_assumed. This row is
  // also how "how often is the bridge load-bearing?" becomes a countable
  // question, which is the evidence for asking Builderwest to standardize labels.
  it("records the bridged match when the invoice is approved", async () => {
    resolveWorkOrder.mockResolvedValue(BRIDGED);

    const decision = await decideMatch(FIELDS, context);

    expect(decision.outcome).toBe("approve");
    expect(decision.auditEvents).toEqual([
      {
        eventType: "pipeline.work_order_matched_by_bridge",
        detail: {
          purchaseOrderNumber: "PO17651",
          matchedLabel: "17651",
          candidateLabels: ["PO17651", "17651"],
          workOrderId: "wo_17651",
        },
      },
    ]);
  });

  it("still records it when a later check sends the invoice to a human", async () => {
    resolveWorkOrder.mockResolvedValue(BRIDGED);

    const decision = await decideMatch({ ...FIELDS, totalAmountCents: 120_450 }, context);

    expect(decision).toMatchObject({ outcome: "exception", reason: "costMismatch" });
    expect(decision.auditEvents[0]?.eventType).toBe("pipeline.work_order_matched_by_bridge");
  });

  it("records the work order before the supplier — the order the checks ran in", async () => {
    resolveWorkOrder.mockResolvedValue(BRIDGED);
    resolveSupplier.mockResolvedValue({ status: "assumed", candidateCount: 2 });

    const decision = await decideMatch(FIELDS, context);

    expect(decision.auditEvents.map((event) => event.eventType)).toEqual([
      "pipeline.work_order_matched_by_bridge",
      "pipeline.supplier_assumed",
    ]);
  });

  it("stays silent on the happy path, where the printed form matched directly", async () => {
    resolveWorkOrder.mockResolvedValue({
      status: "matched",
      workOrder: WORK_ORDER,
      matchedLabel: "PO17651",
      matchedViaPrefixBridge: false,
      candidateLabels: ["PO17651", "17651"],
    });

    const decision = await decideMatch(FIELDS, context);

    expect(decision.outcome).toBe("approve");
    expect(decision.auditEvents).toEqual([]);
  });

  // Debugging a miss should not require joining prime.find_work_order rows on
  // timestamps to work out what was actually asked.
  it("records which labels were tried when nothing matched", async () => {
    resolveWorkOrder.mockResolvedValue({
      status: "not_found",
      candidateLabels: ["PO17651", "17651"],
    });

    const decision = await decideMatch(FIELDS, context);

    expect(decision).toMatchObject({ outcome: "exception", reason: "noWorkOrder" });
    expect(decision.auditEvents).toEqual([
      {
        eventType: "pipeline.work_order_unresolved",
        detail: {
          status: "not_found",
          purchaseOrderNumber: "PO17651",
          matchCount: 0,
          candidateLabels: ["PO17651", "17651"],
        },
      },
    ]);
  });

  it("reports the union size when several work orders are consistent with the invoice", async () => {
    resolveWorkOrder.mockResolvedValue({
      status: "ambiguous",
      matchCount: 2,
      candidateLabels: ["PO17651", "17651"],
    });

    const decision = await decideMatch(FIELDS, context);

    expect(decision.auditEvents[0]?.detail).toMatchObject({
      status: "ambiguous",
      matchCount: 2,
      candidateLabels: ["PO17651", "17651"],
    });
  });

  // An empty candidate list is itself the record that Prime was never asked —
  // distinct from "asked and found nothing".
  it("records an empty candidate list when the invoice printed no PO", async () => {
    resolveWorkOrder.mockResolvedValue({ status: "not_found", candidateLabels: [] });

    const decision = await decideMatch({ ...FIELDS, purchaseOrderNumber: null }, context);

    expect(decision.auditEvents[0]?.detail).toMatchObject({
      purchaseOrderNumber: null,
      candidateLabels: [],
    });
  });
});
