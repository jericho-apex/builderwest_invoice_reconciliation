import { describe, it, expect } from "vitest";
import { compareCost } from "../../../src/lib/matching/compareCost.js";
import type { PrimeWorkOrder } from "../../../src/lib/prime/workOrders.js";

function workOrder(overrides: Partial<PrimeWorkOrder> = {}): PrimeWorkOrder {
  return { id: "wo_1", costCents: 100_000, costTaxTotalCents: 110_000, ...overrides };
}

describe("compareCost", () => {
  describe("exact tolerance mode", () => {
    it("is within tolerance when the invoice total matches exactly", () => {
      const result = compareCost(110_000, workOrder(), "costTaxTotal", "exact", 0);
      expect(result.withinTolerance).toBe(true);
      expect(result.differenceCents).toBe(0);
    });

    it("is NOT within tolerance for even a single cent of difference — exact means exact", () => {
      const result = compareCost(110_001, workOrder(), "costTaxTotal", "exact", 0);
      expect(result.withinTolerance).toBe(false);
      expect(result.differenceCents).toBe(1);
    });

    it("uses the absolute difference regardless of direction (invoice higher or lower)", () => {
      const higher = compareCost(110_050, workOrder(), "costTaxTotal", "exact", 0);
      const lower = compareCost(109_950, workOrder(), "costTaxTotal", "exact", 0);
      expect(higher.differenceCents).toBe(50);
      expect(lower.differenceCents).toBe(50);
      expect(higher.withinTolerance).toBe(false);
      expect(lower.withinTolerance).toBe(false);
    });
  });

  describe("dollar tolerance mode", () => {
    it("is within tolerance when the difference is within the configured dollar allowance", () => {
      const result = compareCost(110_500, workOrder(), "costTaxTotal", "dollar", 10);
      expect(result.differenceCents).toBe(500);
      expect(result.withinTolerance).toBe(true);
    });

    it("is not within tolerance just past the dollar allowance", () => {
      const result = compareCost(111_001, workOrder(), "costTaxTotal", "dollar", 10);
      expect(result.differenceCents).toBe(1001);
      expect(result.withinTolerance).toBe(false);
    });
  });

  describe("percentage tolerance mode", () => {
    it("computes the allowance as a percentage of the work order's cost figure", () => {
      // 5% of 110,000 cents = 5,500 cents allowance
      const withinBounds = compareCost(115_000, workOrder(), "costTaxTotal", "percentage", 5);
      const overBounds = compareCost(115_600, workOrder(), "costTaxTotal", "percentage", 5);
      expect(withinBounds.withinTolerance).toBe(true);
      expect(overBounds.withinTolerance).toBe(false);
    });
  });

  describe("cost field selection", () => {
    it("compares against costCents when costField is 'cost'", () => {
      const result = compareCost(100_000, workOrder(), "cost", "exact", 0);
      expect(result.workOrderCostCents).toBe(100_000);
      expect(result.withinTolerance).toBe(true);
    });

    it("compares against costTaxTotalCents when costField is 'costTaxTotal'", () => {
      const result = compareCost(100_000, workOrder(), "costTaxTotal", "exact", 0);
      expect(result.workOrderCostCents).toBe(110_000);
      expect(result.withinTolerance).toBe(false);
    });
  });

  it("never widens a match — a tighter tolerance only ever sends MORE items to review, never fewer", () => {
    // Same inputs, tolerance goes from percentage (loose) to exact (tight):
    // what passed loosely must not silently start failing to also pass tightly,
    // and what fails tightly must never have been silently approved loosely.
    const loose = compareCost(112_000, workOrder(), "costTaxTotal", "percentage", 10);
    const tight = compareCost(112_000, workOrder(), "costTaxTotal", "exact", 0);
    expect(loose.withinTolerance).toBe(true);
    expect(tight.withinTolerance).toBe(false);
  });
});
