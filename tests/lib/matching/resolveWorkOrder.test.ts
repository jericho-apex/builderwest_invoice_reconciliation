import { describe, it, expect, vi, beforeEach } from "vitest";

const findWorkOrderByReference = vi.fn();
const findWorkOrderByJobNumber = vi.fn();

vi.mock("../../../src/lib/prime/workOrders.js", () => ({
  findWorkOrderByReference: (...args: unknown[]) => findWorkOrderByReference(...args),
  findWorkOrderByJobNumber: (...args: unknown[]) => findWorkOrderByJobNumber(...args),
}));

const { resolveWorkOrder } = await import("../../../src/lib/matching/resolveWorkOrder.js");

const context = { messageId: "msg-1" };
const workOrder = { id: "wo_1", costCents: 1000, costTaxTotalCents: 1100 };

describe("resolveWorkOrder", () => {
  beforeEach(() => {
    findWorkOrderByReference.mockReset();
    findWorkOrderByJobNumber.mockReset();
  });

  it("returns not_found without calling Prime when the reference is null — never a guess", async () => {
    const result = await resolveWorkOrder(null, context);
    expect(result).toEqual({ status: "not_found" });
    expect(findWorkOrderByReference).not.toHaveBeenCalled();
    expect(findWorkOrderByJobNumber).not.toHaveBeenCalled();
  });

  it("matches by reference and does not fall back to job number when the reference hits", async () => {
    findWorkOrderByReference.mockResolvedValue(workOrder);

    const result = await resolveWorkOrder("WO-42", context);

    expect(result).toEqual({ status: "matched", workOrder });
    expect(findWorkOrderByJobNumber).not.toHaveBeenCalled();
  });

  it("falls back to job number when the reference lookup misses", async () => {
    findWorkOrderByReference.mockResolvedValue(undefined);
    findWorkOrderByJobNumber.mockResolvedValue(workOrder);

    const result = await resolveWorkOrder("JOB-99", context);

    expect(result).toEqual({ status: "matched", workOrder });
    expect(findWorkOrderByReference).toHaveBeenCalledWith("JOB-99", context);
    expect(findWorkOrderByJobNumber).toHaveBeenCalledWith("JOB-99", context);
  });

  it("returns not_found when both reference and job number lookups miss", async () => {
    findWorkOrderByReference.mockResolvedValue(undefined);
    findWorkOrderByJobNumber.mockResolvedValue(undefined);

    const result = await resolveWorkOrder("UNKNOWN-1", context);

    expect(result).toEqual({ status: "not_found" });
  });
});
