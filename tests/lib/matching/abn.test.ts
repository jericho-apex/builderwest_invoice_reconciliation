import { describe, it, expect } from "vitest";
import {
  normalizeAbn,
  isValidAbn,
  formatAbn,
  abnQueryCandidates,
} from "../../../src/lib/matching/abn.js";

// 51 824 753 556 is the ATO's own published example ABN — a real, checksum-
// valid number that belongs to a government body, not to any client.
const VALID_ABN = "51824753556";

describe("normalizeAbn", () => {
  it("strips the spacing suppliers actually print", () => {
    expect(normalizeAbn("51 824 753 556")).toBe(VALID_ABN);
  });

  it("strips other punctuation and surrounding whitespace", () => {
    expect(normalizeAbn(" 51-824-753.556 ")).toBe(VALID_ABN);
  });

  it("drops a leading ABN label rather than choking on it", () => {
    expect(normalizeAbn("ABN 51 824 753 556")).toBe(VALID_ABN);
  });
});

describe("isValidAbn", () => {
  it("accepts a checksum-valid ABN", () => {
    expect(isValidAbn(VALID_ABN)).toBe(true);
  });

  // The case this module exists for: both of the client's dummy invoices print
  // this placeholder, but come from different suppliers. Treating it as a real
  // ABN resolves both to the same contact.
  it("rejects the all-zeros placeholder printed on the dummy invoices", () => {
    expect(isValidAbn(normalizeAbn("00 000 000 000"))).toBe(false);
  });

  it("rejects a number that is the right length but fails the checksum", () => {
    expect(isValidAbn("12345678901")).toBe(false);
  });

  it("rejects anything that isn't exactly 11 digits", () => {
    expect(isValidAbn("5182475355")).toBe(false); // 10
    expect(isValidAbn("518247535567")).toBe(false); // 12
    expect(isValidAbn("")).toBe(false);
  });

  it("rejects unnormalized input rather than silently accepting it", () => {
    // Callers must normalize first — this guards against a caller that forgets.
    expect(isValidAbn("51 824 753 556")).toBe(false);
  });
});

describe("formatAbn", () => {
  it("applies the ATO's 2-3-3-3 display grouping", () => {
    expect(formatAbn(VALID_ABN)).toBe("51 824 753 556");
  });

  // Verified live 2026-07-29: this is the exact string production Prime holds for
  // Builderwest's real subcontractor contacts.
  it("reproduces the format production Prime stores", () => {
    expect(formatAbn("68628819741")).toBe("68 628 819 741");
    expect(formatAbn("39108785824")).toBe("39 108 785 824");
    expect(formatAbn("23676709185")).toBe("23 676 709 185");
  });

  it("round-trips through normalizeAbn", () => {
    expect(normalizeAbn(formatAbn(VALID_ABN))).toBe(VALID_ABN);
  });
});

describe("abnQueryCandidates", () => {
  // The defect this closes: Prime's `q=` is an exact `eq`, production stores the
  // ABN grouped, and resolveSupplier sent only the digits — so the ABN lookup
  // could never hit, and every real supplier fell through to a name lookup that
  // misses too (invoices print "Hutchy Ceilings Pty Ltd", Prime holds "Hutchy
  // Ceilings"). All three of the client's real invoices routed to
  // Exceptions/Supplier not found for that reason alone.
  it("offers the grouped form first, since that is what production holds", () => {
    expect(abnQueryCandidates("68628819741")).toEqual(["68 628 819 741", "68628819741"]);
  });

  it("offers exactly two forms, so the ABN lookup costs at most two calls", () => {
    const candidates = abnQueryCandidates(VALID_ABN);

    expect(candidates).toHaveLength(2);
    // Both must still be the SAME ABN — bridging a format, never widening to
    // another business.
    for (const candidate of candidates) {
      expect(normalizeAbn(candidate)).toBe(VALID_ABN);
    }
  });

  // Beale4's invoice prints "3910 8785 824" — 11 valid digits under a
  // non-standard grouping. Normalizing then re-grouping still lands on exactly
  // what Prime stores.
  it("recovers the stored form from a non-standard printed grouping", () => {
    expect(abnQueryCandidates(normalizeAbn("3910 8785 824"))[0]).toBe("39 108 785 824");
  });
});
