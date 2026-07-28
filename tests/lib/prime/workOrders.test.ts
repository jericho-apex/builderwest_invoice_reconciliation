import { describe, it, expect, beforeEach, vi } from "vitest";

// Everything below the mapping is stubbed: this file exists to cover
// mapWorkOrder's dollars->cents conversion, which until now was exercised by
// nothing in the suite (the finders are vi.mocked everywhere else) and only by
// npm run pipeline:sample.
const primeRequest = vi.fn();
vi.mock("../../../src/lib/prime/httpClient.js", () => ({
  primeRequest: (...args: unknown[]) => primeRequest(...args),
}));

vi.mock("../../../src/db/repositories/auditLog.js", () => ({
  appendAuditLog: () => 1,
}));

vi.mock("../../../src/config/env.js", () => ({
  loadEnv: () => ({ PRIME_WORK_ORDER_PO_FIELD: "label" }),
}));

const { findWorkOrdersByPurchaseOrder } = await import("../../../src/lib/prime/workOrders.js");

const context = { messageId: "msg-1" };

/** One JSON:API work-order row, shaped exactly as production returns it. */
function row(attributes: Record<string, unknown>) {
  return { id: "wo_1", attributes };
}

async function mapOne(attributes: Record<string, unknown>) {
  primeRequest.mockResolvedValue({ data: [row(attributes)] });
  const [workOrder] = await findWorkOrdersByPurchaseOrder("PO21266", context);
  return workOrder!;
}

describe("findWorkOrdersByPurchaseOrder mapping", () => {
  beforeEach(() => {
    primeRequest.mockReset();
  });

  // Production sends costTotal as a JSON number and costTaxTotal as a decimal
  // string. Reading either with the wrong assumption yields NaN or 0 cents, and
  // a 0 quietly becomes "cost mismatch" on a correct invoice.
  it("converts PO21266's real production figures to cents from mixed types", async () => {
    const workOrder = await mapOne({
      costTotal: 435,
      costTaxTotal: "43.50",
      jobId: "08fff8ef",
    });

    expect(workOrder).toEqual({
      id: "wo_1",
      costTotalCents: 43_500,
      costTaxTotalCents: 4_350,
      estimateId: undefined,
      jobId: "08fff8ef",
    });
  });

  it("handles both fields arriving as strings, and as numbers", async () => {
    expect(await mapOne({ costTotal: "405.00", costTaxTotal: "40.50" })).toMatchObject({
      costTotalCents: 40_500,
      costTaxTotalCents: 4_050,
    });
    expect(await mapOne({ costTotal: 405, costTaxTotal: 40.5 })).toMatchObject({
      costTotalCents: 40_500,
      costTaxTotalCents: 4_050,
    });
  });

  it("rounds to the nearest cent rather than truncating", async () => {
    expect(await mapOne({ costTotal: "0.005", costTaxTotal: "0.004" })).toMatchObject({
      costTotalCents: 1,
      costTaxTotalCents: 0,
    });
  });

  // 0 can only produce a cost MISMATCH, which routes to a human. Throwing here
  // would instead strand the invoice being retried every tick.
  it("treats an absent or unparseable amount as 0 cents rather than throwing", async () => {
    expect(await mapOne({ jobId: "job_1" })).toMatchObject({
      costTotalCents: 0,
      costTaxTotalCents: 0,
    });
    expect(await mapOne({ costTotal: "not a number", costTaxTotal: null })).toMatchObject({
      costTotalCents: 0,
      costTaxTotalCents: 0,
    });
  });

  it("queries the configured PO field and returns every match, never just the first", async () => {
    primeRequest.mockResolvedValue({
      data: [row({ costTotal: 1 }), row({ costTotal: 2 })],
    });

    const results = await findWorkOrdersByPurchaseOrder("PO21266", context);

    expect(results).toHaveLength(2);
    expect(primeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        path: "/work-orders",
        query: { q: "'label'.eq('PO21266')" },
      }),
    );
  });
});
