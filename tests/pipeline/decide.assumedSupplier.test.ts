import { describe, it, expect, beforeEach, vi } from "vitest";

// decide.ts's own behaviour under an "assumed" supplier, mocked one layer down
// (the resolvers) so this file is about what the DECISION records, not about how
// resolution reaches that state — resolveSupplier.test.ts covers that.
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

// PO21266 as production holds it: $435.00 ex-GST + $43.50 GST = $478.50 inc.
const WORK_ORDER = { id: "wo_po21266", costTotalCents: 43_500, costTaxTotalCents: 4_350 };

// Invoice 1's extracted fields, with the placeholder ABN it really prints.
const FIELDS = {
  purchaseOrderNumber: "PO21266",
  supplierAbn: "00 000 000 000",
  supplierName: "Ryan Smith",
  totalAmountCents: 47_850,
};

describe("decideMatch with an assumed supplier", () => {
  beforeEach(() => {
    resolveWorkOrder.mockReset();
    resolveSupplier.mockReset();
    resolveWorkOrder.mockResolvedValue({ status: "matched", workOrder: WORK_ORDER });
  });

  it("approves on cost alone, carrying no contact and recording what was assumed", async () => {
    resolveSupplier.mockResolvedValue({ status: "assumed", candidateCount: 4 });

    const decision = await decideMatch(FIELDS, context);

    expect(decision.outcome).toBe("approve");
    expect(decision.contact).toBeUndefined();
    expect(decision.matchResult).toMatchObject({
      supplierMatchStatus: "assumed",
      // Never a guessed id: an approved row with no contact is the honest record.
      supplierContactId: undefined,
      workOrderId: "wo_po21266",
      workOrderCostCents: 47_850,
      invoiceTotalCents: 47_850,
      withinTolerance: true,
      decision: "approve",
    });
    expect(decision.auditEvents).toEqual([
      {
        eventType: "pipeline.supplier_assumed",
        detail: {
          supplierName: "Ryan Smith",
          supplierAbn: "00 000 000 000",
          nameCandidateCount: 4,
          workOrderId: "wo_po21266",
        },
      },
    ]);
  });

  // The flag forgives the supplier and nothing else — a wrong amount must still
  // be caught, and the assumption must still be on the record when it is.
  it("still routes a cost mismatch to costMismatch, with the assumption recorded", async () => {
    resolveSupplier.mockResolvedValue({ status: "assumed", candidateCount: 0 });

    const decision = await decideMatch({ ...FIELDS, totalAmountCents: 77_550 }, context);

    expect(decision.outcome).toBe("exception");
    expect(decision).toMatchObject({ reason: "costMismatch" });
    expect(decision.matchResult).toMatchObject({
      supplierMatchStatus: "assumed",
      costDifferenceCents: 29_700,
      withinTolerance: false,
    });
    expect(decision.auditEvents).toHaveLength(1);
  });

  it("does not reach the supplier at all when the PO is unresolved", async () => {
    resolveWorkOrder.mockResolvedValue({ status: "not_found" });

    const decision = await decideMatch(FIELDS, context);

    expect(decision).toMatchObject({ outcome: "exception", reason: "noWorkOrder" });
    expect(decision.matchResult.supplierMatchStatus).toBe("not_attempted");
    expect(resolveSupplier).not.toHaveBeenCalled();
  });

  it("emits no assumption event when the supplier genuinely resolves", async () => {
    const contact = { id: "contact_ryan", name: "Ryan Smith" };
    resolveSupplier.mockResolvedValue({ status: "matched_by_name", contact });

    const decision = await decideMatch(FIELDS, context);

    expect(decision.outcome).toBe("approve");
    expect(decision.contact).toEqual(contact);
    expect(decision.matchResult.supplierContactId).toBe("contact_ryan");
    expect(decision.auditEvents).toEqual([]);
  });
});
