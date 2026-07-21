import { describe, it, expect, vi, beforeEach } from "vitest";

const findContactByAbn = vi.fn();
const findContactByName = vi.fn();

vi.mock("../../../src/lib/prime/contacts.js", () => ({
  findContactByAbn: (...args: unknown[]) => findContactByAbn(...args),
  findContactByName: (...args: unknown[]) => findContactByName(...args),
}));

const { resolveSupplier } = await import("../../../src/lib/matching/resolveSupplier.js");

const context = { messageId: "msg-1" };
const contact = { id: "contact_1", name: "Acme Roofing" };

describe("resolveSupplier", () => {
  beforeEach(() => {
    findContactByAbn.mockReset();
    findContactByName.mockReset();
  });

  it("matches by ABN first and never falls back to name when the ABN hits", async () => {
    findContactByAbn.mockResolvedValue(contact);

    const result = await resolveSupplier({ abn: "12345678901", name: "Acme Roofing" }, context);

    expect(result).toEqual({ status: "matched_by_abn", contact });
    expect(findContactByName).not.toHaveBeenCalled();
  });

  it("falls back to name when ABN is present but doesn't match", async () => {
    findContactByAbn.mockResolvedValue(undefined);
    findContactByName.mockResolvedValue(contact);

    const result = await resolveSupplier({ abn: "00000000000", name: "Acme Roofing" }, context);

    expect(result).toEqual({ status: "matched_by_name", contact });
  });

  it("skips the ABN lookup entirely when no ABN was extracted", async () => {
    findContactByName.mockResolvedValue(contact);

    const result = await resolveSupplier({ abn: null, name: "Acme Roofing" }, context);

    expect(result).toEqual({ status: "matched_by_name", contact });
    expect(findContactByAbn).not.toHaveBeenCalled();
  });

  it("returns not_found when neither ABN nor name resolve, without guessing", async () => {
    findContactByAbn.mockResolvedValue(undefined);
    findContactByName.mockResolvedValue(undefined);

    const result = await resolveSupplier({ abn: "999", name: "Unknown Co" }, context);

    expect(result).toEqual({ status: "not_found" });
  });

  it("returns not_found when both abn and name are null, without calling Prime at all", async () => {
    const result = await resolveSupplier({ abn: null, name: null }, context);

    expect(result).toEqual({ status: "not_found" });
    expect(findContactByAbn).not.toHaveBeenCalled();
    expect(findContactByName).not.toHaveBeenCalled();
  });
});
