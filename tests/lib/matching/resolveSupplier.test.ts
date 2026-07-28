import { describe, it, expect, vi, beforeEach } from "vitest";

const findContactsByAbn = vi.fn();
const findContactsByName = vi.fn();

vi.mock("../../../src/lib/prime/contacts.js", () => ({
  findContactsByAbn: (...args: unknown[]) => findContactsByAbn(...args),
  findContactsByName: (...args: unknown[]) => findContactsByName(...args),
}));

const { resolveSupplier } = await import("../../../src/lib/matching/resolveSupplier.js");

const context = { messageId: "msg-1" };
const VALID_ABN = "51824753556"; // ATO's published example ABN — checksum-valid
const ryan = { id: "contact_ryan", name: "Ryan Smith" };
const tobey = { id: "contact_tobey", name: "Tobey Chan" };

describe("resolveSupplier", () => {
  beforeEach(() => {
    findContactsByAbn.mockReset();
    findContactsByName.mockReset();
  });

  it("matches by ABN first and never falls back to name when the ABN hits", async () => {
    findContactsByAbn.mockResolvedValue([ryan]);

    const result = await resolveSupplier({ abn: VALID_ABN, name: "Ryan Smith" }, context);

    expect(result).toEqual({ status: "matched_by_abn", contact: ryan });
    expect(findContactsByName).not.toHaveBeenCalled();
  });

  it("normalizes a formatted ABN before querying Prime", async () => {
    findContactsByAbn.mockResolvedValue([ryan]);

    await resolveSupplier({ abn: "51 824 753 556", name: "Ryan Smith" }, context);

    expect(findContactsByAbn).toHaveBeenCalledWith(VALID_ABN, context);
  });

  // The defect this closes: both dummy invoices print ABN "00 000 000 000" but
  // come from different suppliers. Querying on it would resolve both to
  // whichever contact happens to carry the placeholder.
  it("never queries by an invalid ABN — the placeholder resolves by name instead", async () => {
    findContactsByName.mockResolvedValue([tobey]);

    const result = await resolveSupplier({ abn: "00 000 000 000", name: "Tobey Chan" }, context);

    expect(result).toEqual({ status: "matched_by_name", contact: tobey });
    expect(findContactsByAbn).not.toHaveBeenCalled();
    expect(findContactsByName).toHaveBeenCalledWith("Tobey Chan", context);
  });

  it("falls back to name when a valid ABN simply isn't in Prime", async () => {
    findContactsByAbn.mockResolvedValue([]);
    findContactsByName.mockResolvedValue([ryan]);

    const result = await resolveSupplier({ abn: VALID_ABN, name: "Ryan Smith" }, context);

    expect(result).toEqual({ status: "matched_by_name", contact: ryan });
  });

  it("treats several contacts sharing one ABN as unresolved, not as the first row", async () => {
    findContactsByAbn.mockResolvedValue([ryan, tobey]);
    findContactsByName.mockResolvedValue([]);

    const result = await resolveSupplier({ abn: VALID_ABN, name: "Ryan Smith" }, context);

    expect(result).toEqual({ status: "not_found" });
  });

  it("treats several contacts sharing one name as unresolved", async () => {
    findContactsByName.mockResolvedValue([ryan, tobey]);

    const result = await resolveSupplier({ abn: null, name: "Ryan Smith" }, context);

    expect(result).toEqual({ status: "not_found" });
  });

  it("skips the ABN lookup entirely when no ABN was extracted", async () => {
    findContactsByName.mockResolvedValue([ryan]);

    const result = await resolveSupplier({ abn: null, name: "Ryan Smith" }, context);

    expect(result).toEqual({ status: "matched_by_name", contact: ryan });
    expect(findContactsByAbn).not.toHaveBeenCalled();
  });

  it("returns not_found when neither ABN nor name resolve, without guessing", async () => {
    findContactsByAbn.mockResolvedValue([]);
    findContactsByName.mockResolvedValue([]);

    const result = await resolveSupplier({ abn: VALID_ABN, name: "Unknown Co" }, context);

    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found when both abn and name are null, without calling Prime at all", async () => {
    const result = await resolveSupplier({ abn: null, name: null }, context);

    expect(result).toEqual({ status: "not_found" });
    expect(findContactsByAbn).not.toHaveBeenCalled();
    expect(findContactsByName).not.toHaveBeenCalled();
  });
});
