import { describe, it, expect } from "vitest";
import { normalizeAbn, isValidAbn } from "../../../src/lib/matching/abn.js";

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
