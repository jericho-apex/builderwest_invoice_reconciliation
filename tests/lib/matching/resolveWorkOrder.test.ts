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

/**
 * Serves a Prime label -> rows map, so one test can return different work orders
 * for each of the two candidate forms. Anything unlisted returns no rows, which
 * is what a real exact `eq` does.
 */
function servingLabels(rows: Record<string, unknown[]>) {
  return (label: string) => Promise.resolve(rows[label] ?? []);
}

describe("resolveWorkOrder", () => {
  beforeEach(() => {
    findWorkOrdersByPurchaseOrder.mockReset();
  });

  it("returns not_found without calling Prime when no PO was extracted — never a guess", async () => {
    const result = await resolveWorkOrder(null, context);

    expect(result).toEqual({ status: "not_found", candidateLabels: [] });
    expect(findWorkOrdersByPurchaseOrder).not.toHaveBeenCalled();
  });

  it("treats an empty PO the same as a missing one", async () => {
    const result = await resolveWorkOrder("", context);

    expect(result).toEqual({ status: "not_found", candidateLabels: [] });
    expect(findWorkOrdersByPurchaseOrder).not.toHaveBeenCalled();
  });

  it("matches when the PO resolves to exactly one work order", async () => {
    findWorkOrdersByPurchaseOrder.mockImplementation(servingLabels({ PO21266: [stage1] }));

    const result = await resolveWorkOrder("PO21266", context);

    expect(result).toEqual({
      status: "matched",
      workOrder: stage1,
      matchedLabel: "PO21266",
      matchedViaPrefixBridge: false,
      candidateLabels: ["PO21266", "21266"],
    });
    expect(findWorkOrdersByPurchaseOrder).toHaveBeenCalledWith("PO21266", context);
  });

  it("returns not_found when the PO matches nothing", async () => {
    findWorkOrdersByPurchaseOrder.mockResolvedValue([]);

    const result = await resolveWorkOrder("PO-UNKNOWN", context);

    expect(result).toEqual({ status: "not_found", candidateLabels: ["PO-UNKNOWN"] });
  });

  // The defect this rewrite exists to close: the previous implementation took
  // the first row of a multi-match, which on the client's data (job BWC-5126
  // carries both a Stage 1 and a Stage 2 work order) could approve an invoice
  // against a sibling work order.
  it("returns ambiguous — never the first row — when several work orders match", async () => {
    findWorkOrdersByPurchaseOrder.mockImplementation(
      servingLabels({ PO21266: [stage1, stage2] }),
    );

    const result = await resolveWorkOrder("PO21266", context);

    expect(result).toEqual({
      status: "ambiguous",
      matchCount: 2,
      candidateLabels: ["PO21266", "21266"],
    });
    expect(result).not.toMatchObject({ status: "matched" });
  });

  it("does not fall back to any other identifier when the PO misses", async () => {
    findWorkOrdersByPurchaseOrder.mockResolvedValue([]);

    await resolveWorkOrder("PO21266", context);

    // Two lookups, and only ever the PO's own two candidate forms — no
    // work-order-reference retry and, crucially, no job-number retry. The count
    // rose from one to two when the PO-prefix bridge landed; what must not
    // change is that nothing but the PO itself is ever queried.
    expect(findWorkOrdersByPurchaseOrder.mock.calls.map((call) => call[0])).toEqual([
      "PO21266",
      "21266",
    ]);
  });

  describe("the PO-prefix bridge", () => {
    // The bug the bridge exists to close. Most production work orders carry a
    // bare-number label, so an invoice printing the prefix missed them entirely.
    it("matches a bare-labelled work order when the invoice prints the prefix", async () => {
      findWorkOrdersByPurchaseOrder.mockImplementation(servingLabels({ "17651": [stage1] }));

      const result = await resolveWorkOrder("PO17651", context);

      expect(result).toMatchObject({
        status: "matched",
        workOrder: stage1,
        matchedLabel: "17651",
        matchedViaPrefixBridge: true,
      });
    });

    it("matches a prefixed work order when the invoice prints a bare number", async () => {
      findWorkOrdersByPurchaseOrder.mockImplementation(servingLabels({ PO17651: [stage1] }));

      const result = await resolveWorkOrder("17651", context);

      expect(result).toMatchObject({
        status: "matched",
        workOrder: stage1,
        matchedLabel: "PO17651",
        matchedViaPrefixBridge: true,
      });
    });

    // The dedupe guard. If Prime's `eq` is insensitive to the prefix in any way,
    // both candidates return the SAME work order — and counting rows instead of
    // distinct ids would call that ambiguous and send a perfectly good invoice
    // to a human. A false negative manufactured by our own second query.
    it("treats the same work order returned by both candidates as one match", async () => {
      findWorkOrdersByPurchaseOrder.mockImplementation(
        servingLabels({ PO17651: [stage1], "17651": [stage1] }),
      );

      const result = await resolveWorkOrder("PO17651", context);

      expect(result).toMatchObject({ status: "matched", workOrder: stage1 });
    });

    // A genuine ambiguity about the world: Prime holds two different work orders,
    // one under each label, and the invoice names both. Exactly the case the
    // exactly-one rule exists for.
    it("returns ambiguous when the two candidates name different work orders", async () => {
      findWorkOrdersByPurchaseOrder.mockImplementation(
        servingLabels({ PO17651: [stage1], "17651": [stage2] }),
      );

      const result = await resolveWorkOrder("PO17651", context);

      expect(result).toMatchObject({ status: "ambiguous", matchCount: 2 });
      expect(result).not.toMatchObject({ status: "matched" });
    });

    // Anti-short-circuit lock. Stopping as soon as the first candidate matched
    // would be `data[0]` one layer up — our candidate ordering, not any evidence
    // on the invoice, would pick which work order got the money.
    it("queries both candidates even when the first already matched exactly one", async () => {
      findWorkOrdersByPurchaseOrder.mockImplementation(servingLabels({ PO17651: [stage1] }));

      await resolveWorkOrder("PO17651", context);

      expect(findWorkOrdersByPurchaseOrder).toHaveBeenCalledTimes(2);
      expect(findWorkOrdersByPurchaseOrder).toHaveBeenNthCalledWith(1, "PO17651", context);
      expect(findWorkOrdersByPurchaseOrder).toHaveBeenNthCalledWith(2, "17651", context);
    });

    it("queries the second candidate even when the first was already ambiguous", async () => {
      findWorkOrdersByPurchaseOrder.mockImplementation(
        servingLabels({ PO17651: [stage1, stage2], "17651": [{ id: "wo_third" }] }),
      );

      const result = await resolveWorkOrder("PO17651", context);

      // matchCount is the union — the true number of work orders consistent with
      // this invoice, not the number the first query happened to see.
      expect(result).toMatchObject({ status: "ambiguous", matchCount: 3 });
      expect(findWorkOrdersByPurchaseOrder).toHaveBeenCalledTimes(2);
    });

    it("issues a single verbatim lookup for a PO it cannot parse", async () => {
      findWorkOrdersByPurchaseOrder.mockResolvedValue([]);

      await resolveWorkOrder("PO21266/2", context);

      expect(findWorkOrdersByPurchaseOrder).toHaveBeenCalledOnce();
      expect(findWorkOrdersByPurchaseOrder).toHaveBeenCalledWith("PO21266/2", context);
    });

    it("normalizes the prefix spellings suppliers print before querying", async () => {
      findWorkOrdersByPurchaseOrder.mockImplementation(servingLabels({ PO21343: [stage1] }));

      const result = await resolveWorkOrder("P.O. 21343", context);

      expect(result).toMatchObject({ status: "matched", matchedViaPrefixBridge: false });
      expect(findWorkOrdersByPurchaseOrder).toHaveBeenNthCalledWith(1, "PO21343", context);
    });

    it("asks Prime nothing for a whitespace-only PO", async () => {
      const result = await resolveWorkOrder("   ", context);

      expect(result).toEqual({ status: "not_found", candidateLabels: [] });
      expect(findWorkOrdersByPurchaseOrder).not.toHaveBeenCalled();
    });
  });
});
