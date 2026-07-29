import { describe, it, expect } from "vitest";
import { compareCost } from "../../../src/lib/matching/compareCost.js";
import type { PrimeWorkOrder } from "../../../src/lib/prime/workOrders.js";

// $1,000.00 ex-GST + $100.00 GST = $1,100.00 inc-GST, so costTotalIncTax is
// 110,000 cents and costTotal is 100,000.
function workOrder(overrides: Partial<PrimeWorkOrder> = {}): PrimeWorkOrder {
  return { id: "wo_1", costTotalCents: 100_000, costTaxTotalCents: 10_000, ...overrides };
}

describe("compareCost", () => {
  describe("exact tolerance mode", () => {
    it("is within tolerance when the invoice total matches exactly", () => {
      const result = compareCost(110_000, workOrder(), "costTotalIncTax", "exact", 0);
      expect(result.withinTolerance).toBe(true);
      expect(result.differenceCents).toBe(0);
    });

    it("is NOT within tolerance for even a single cent of difference — exact means exact", () => {
      const result = compareCost(110_001, workOrder(), "costTotalIncTax", "exact", 0);
      expect(result.withinTolerance).toBe(false);
      expect(result.differenceCents).toBe(1);
    });

    it("uses the absolute difference regardless of direction (invoice higher or lower)", () => {
      const higher = compareCost(110_050, workOrder(), "costTotalIncTax", "exact", 0);
      const lower = compareCost(109_950, workOrder(), "costTotalIncTax", "exact", 0);
      expect(higher.differenceCents).toBe(50);
      expect(lower.differenceCents).toBe(50);
      expect(higher.withinTolerance).toBe(false);
      expect(lower.withinTolerance).toBe(false);
    });
  });

  describe("dollar tolerance mode", () => {
    it("is within tolerance when the difference is within the configured dollar allowance", () => {
      const result = compareCost(110_500, workOrder(), "costTotalIncTax", "dollar", 10);
      expect(result.differenceCents).toBe(500);
      expect(result.withinTolerance).toBe(true);
    });

    it("is not within tolerance just past the dollar allowance", () => {
      const result = compareCost(111_001, workOrder(), "costTotalIncTax", "dollar", 10);
      expect(result.differenceCents).toBe(1001);
      expect(result.withinTolerance).toBe(false);
    });
  });

  describe("percentage tolerance mode", () => {
    it("computes the allowance as a percentage of the work order's cost figure", () => {
      // 5% of 110,000 cents = 5,500 cents allowance
      const withinBounds = compareCost(115_000, workOrder(), "costTotalIncTax", "percentage", 5);
      const overBounds = compareCost(115_600, workOrder(), "costTotalIncTax", "percentage", 5);
      expect(withinBounds.withinTolerance).toBe(true);
      expect(overBounds.withinTolerance).toBe(false);
    });
  });

  describe("cost field selection", () => {
    it("compares against costTotalCents alone when costField is 'costTotal'", () => {
      const result = compareCost(100_000, workOrder(), "costTotal", "exact", 0);
      expect(result.workOrderCostCents).toBe(100_000);
      expect(result.withinTolerance).toBe(true);
    });

    it("sums ex-GST cost and GST when costField is 'costTotalIncTax'", () => {
      const result = compareCost(100_000, workOrder(), "costTotalIncTax", "exact", 0);
      expect(result.workOrderCostCents).toBe(110_000);
      expect(result.withinTolerance).toBe(false);
    });

    // The regression this whole field rename exists for: Prime's costTaxTotal is
    // the GST amount alone, so comparing invoice 1's $478.50 against it read as a
    // $435.00 discrepancy and the client's correct invoice could never approve.
    it("matches the client's invoice 1 against PO21266's real production figures", () => {
      const po21266 = workOrder({ costTotalCents: 43_500, costTaxTotalCents: 4_350 });
      const result = compareCost(47_850, po21266, "costTotalIncTax", "exact", 0);
      expect(result.workOrderCostCents).toBe(47_850);
      expect(result.differenceCents).toBe(0);
      expect(result.withinTolerance).toBe(true);
    });

    it("still mismatches the client's invoice 2 against PO21267's real figures", () => {
      const po21267 = workOrder({ costTotalCents: 40_500, costTaxTotalCents: 4_050 });
      const result = compareCost(77_550, po21267, "costTotalIncTax", "exact", 0);
      expect(result.workOrderCostCents).toBe(44_550);
      expect(result.withinTolerance).toBe(false);
    });

    // The sum happens in integer cents, not dollars — a GST figure like $43.505
    // rounded per-field before adding is how a correct invoice picks up a
    // one-cent discrepancy and lands in review for nothing.
    it("adds in cents so a fractional-cent GST figure cannot drift", () => {
      const result = compareCost(
        47_851,
        workOrder({ costTotalCents: 43_500, costTaxTotalCents: 4_351 }),
        "costTotalIncTax",
        "exact",
        0,
      );
      expect(result.workOrderCostCents).toBe(47_851);
      expect(result.withinTolerance).toBe(true);
    });
  });

  it("never widens a match — a tighter tolerance only ever sends MORE items to review, never fewer", () => {
    // Same inputs, tolerance goes from percentage (loose) to exact (tight):
    // what passed loosely must not silently start failing to also pass tightly,
    // and what fails tightly must never have been silently approved loosely.
    const loose = compareCost(112_000, workOrder(), "costTotalIncTax", "percentage", 10);
    const tight = compareCost(112_000, workOrder(), "costTotalIncTax", "exact", 0);
    expect(loose.withinTolerance).toBe(true);
    expect(tight.withinTolerance).toBe(false);
  });
});
