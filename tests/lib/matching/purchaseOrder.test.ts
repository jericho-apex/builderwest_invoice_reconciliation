import { describe, it, expect } from "vitest";
import {
  purchaseOrderCandidates,
  choosePurchaseOrder,
} from "../../../src/lib/matching/purchaseOrder.js";

describe("purchaseOrderCandidates", () => {
  // The two directions the bridge exists to close. Builderwest's dummy work
  // orders are labelled "PO21266" while most production rows carry a bare
  // number, so an invoice can print either form and mean either label.
  it("offers both forms when the invoice prints the prefix, printed form first", () => {
    expect(purchaseOrderCandidates("PO21266").labels).toEqual(["PO21266", "21266"]);
  });

  it("offers both forms when the invoice prints a bare number, printed form first", () => {
    expect(purchaseOrderCandidates("17651").labels).toEqual(["17651", "PO17651"]);
  });

  it("collapses the prefix spellings suppliers actually print to the same pair", () => {
    for (const printed of [
      "PO21343",
      "po 21343",
      "P.O. 21343",
      "PO#21343",
      "PO-21343",
      "PO No. 21343",
      "PO:21343",
      "  PO21343  ",
    ]) {
      expect(purchaseOrderCandidates(printed).labels).toEqual(["PO21343", "21343"]);
    }
  });

  // The deliberate non-goal. Dropping a leading zero is not the PO-prefix
  // difference — it invents a different number, which could name a different
  // work order and get an invoice approved against it.
  it("preserves leading zeros rather than normalizing them away", () => {
    const result = purchaseOrderCandidates("PO017651");

    expect(result.labels).toEqual(["PO017651", "017651"]);
    expect(result.labels).not.toContain("17651");
  });

  // Same reasoning for separators inside the digits: "PO 21 343" could be 21343
  // or two separate figures, and guessing is widening.
  it("queries anything that isn't prefix-plus-digits verbatim, exactly as before", () => {
    for (const printed of ["PO21266/2", "PO21266 Stage 1", "WO-21266", "POD123", "PO 21 343"]) {
      const result = purchaseOrderCandidates(printed);

      expect(result.labels).toEqual([printed]);
      expect(result.normalized).toBe(false);
    }
  });

  it("asks Prime nothing when the invoice printed no PO", () => {
    for (const printed of [null, "", "   "]) {
      expect(purchaseOrderCandidates(printed).labels).toEqual([]);
    }
  });

  it("reports whether the printed form carried the prefix", () => {
    expect(purchaseOrderCandidates("PO21266")).toMatchObject({
      normalized: true,
      prefixed: true,
      digits: "21266",
    });
    expect(purchaseOrderCandidates("21266")).toMatchObject({
      normalized: true,
      prefixed: false,
      digits: "21266",
    });
  });

  it("trims the printed value it reports without otherwise altering it", () => {
    expect(purchaseOrderCandidates("  PO21266  ").printed).toBe("PO21266");
  });

  // This invariant is what bounds the per-invoice Prime call budget — two
  // lookups at most, never a fan-out proportional to how creatively a supplier
  // formatted their PO.
  it("never produces more than two candidate labels, each a canonical form", () => {
    for (const printed of [
      "PO21266",
      "17651",
      "po 21343",
      "P.O. 21343",
      "PO No. 21343",
      "PO017651",
      "PO21266/2",
      "POD123",
      "",
    ]) {
      const result = purchaseOrderCandidates(printed);

      expect(result.labels.length).toBeLessThanOrEqual(2);
      if (result.normalized) {
        expect([...result.labels].sort()).toEqual(
          [result.digits!, `PO${result.digits!}`].sort(),
        );
      }
    }
  });
});

describe("choosePurchaseOrder", () => {
  it("uses the purchase order number whenever the model read one", () => {
    expect(choosePurchaseOrder("PO21266", "PO99999")).toEqual({
      value: "PO21266",
      source: "extracted",
    });
  });

  // 369.pdf (Beale4) prints its PO under the label "WO No:", and the extraction
  // prompt tells the model workOrderRef is a separate field — so a valid invoice
  // arrives with no purchaseOrderNumber and PO21342 in workOrderRef.
  it("falls back to a prefixed work-order reference when no PO was read", () => {
    expect(choosePurchaseOrder(null, "PO21342")).toEqual({
      value: "PO21342",
      source: "work_order_ref",
    });
  });

  // The prefix is the whole discriminator: Builderwest confirmed POs always
  // start with "PO", so a bare number under "WO No" is a work-order reference,
  // not a PO printed under the wrong label. Reading it as one would be matching
  // on a different identifier.
  it("does not treat a bare-number work-order reference as a PO", () => {
    expect(choosePurchaseOrder(null, "17651")).toEqual({ value: null, source: "extracted" });
  });

  it("ignores a work-order reference that is not a PO at all", () => {
    for (const ref of [null, "", "WO-4471", "Stage 2"]) {
      expect(choosePurchaseOrder(null, ref)).toEqual({ value: null, source: "extracted" });
    }
  });

  it("treats a blank purchase order number as absent", () => {
    expect(choosePurchaseOrder("   ", "PO21342")).toEqual({
      value: "PO21342",
      source: "work_order_ref",
    });
  });
});
