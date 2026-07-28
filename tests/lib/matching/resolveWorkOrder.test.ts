import { describe, it, expect, vi, beforeEach } from "vitest";

const findWorkOrdersByPurchaseOrder = vi.fn();

vi.mock("../../../src/lib/prime/workOrders.js", () => ({
  findWorkOrdersByPurchaseOrder: (...args: unknown[]) => findWorkOrdersByPurchaseOrder(...args),
}));

const { resolveWorkOrder } = await import("../../../src/lib/matching/resolveWorkOrder.js");

const context = { messageId: "msg-1" };
// Ex-GST cost + its GST, as mapWorkOrder returns them.
const stage1 = { id: "wo_stage_1", costTotalCents: 43_500, costTaxTotalCents: 4_350 };
const stage2 = { id: "wo_stage_2", costTotalCents: 40_500, costTaxTotalCents: 4_050 };

describe("resolveWorkOrder", () => {
  beforeEach(() => {
    findWorkOrdersByPurchaseOrder.mockReset();
  });

  it("returns not_found without calling Prime when no PO was extracted — never a guess", async () => {
    const result = await resolveWorkOrder(null, context);

    expect(result).toEqual({ status: "not_found" });
    expect(findWorkOrdersByPurchaseOrder).not.toHaveBeenCalled();
  });

  it("treats an empty PO the same as a missing one", async () => {
    const result = await resolveWorkOrder("", context);

    expect(result).toEqual({ status: "not_found" });
    expect(findWorkOrdersByPurchaseOrder).not.toHaveBeenCalled();
  });

  it("matches when the PO resolves to exactly one work order", async () => {
    findWorkOrdersByPurchaseOrder.mockResolvedValue([stage1]);

    const result = await resolveWorkOrder("PO21266", context);

    expect(result).toEqual({ status: "matched", workOrder: stage1 });
    expect(findWorkOrdersByPurchaseOrder).toHaveBeenCalledWith("PO21266", context);
  });

  it("returns not_found when the PO matches nothing", async () => {
    findWorkOrdersByPurchaseOrder.mockResolvedValue([]);

    const result = await resolveWorkOrder("PO-UNKNOWN", context);

    expect(result).toEqual({ status: "not_found" });
  });

  // The defect this rewrite exists to close: the previous implementation took
  // the first row of a multi-match, which on the client's data (job BWC-5126
  // carries both a Stage 1 and a Stage 2 work order) could approve an invoice
  // against a sibling work order.
  it("returns ambiguous — never the first row — when several work orders match", async () => {
    findWorkOrdersByPurchaseOrder.mockResolvedValue([stage1, stage2]);

    const result = await resolveWorkOrder("PO21266", context);

    expect(result).toEqual({ status: "ambiguous", matchCount: 2 });
    expect(result).not.toMatchObject({ status: "matched" });
  });

  it("does not fall back to any other identifier when the PO misses", async () => {
    findWorkOrdersByPurchaseOrder.mockResolvedValue([]);

    await resolveWorkOrder("PO21266", context);

    // Exactly one lookup: no reference retry, no job-number retry.
    expect(findWorkOrdersByPurchaseOrder).toHaveBeenCalledOnce();
  });
});
