import { describe, it, expect, vi, beforeEach } from "vitest";

const findContactsByAbn = vi.fn();
const findContactsByName = vi.fn();

vi.mock("../../../src/lib/prime/contacts.js", () => ({
  findContactsByAbn: (...args: unknown[]) => findContactsByAbn(...args),
  findContactsByName: (...args: unknown[]) => findContactsByName(...args),
}));

// Stubbed rather than driven through real env vars so a test can flip the flag
// mid-file — loadEnv() caches on first call and would otherwise pin whichever
// value the first test happened to use.
let assumeSupplierMatched = false;
vi.mock("../../../src/config/env.js", () => ({
  loadEnv: () => ({ ASSUME_SUPPLIER_MATCHED: assumeSupplierMatched }),
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
    assumeSupplierMatched = false;
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

  // Builderwest's production Prime holds four contacts named "Ryan Smith", so
  // their own auto-approve invoice cannot resolve by name alone. The matched
  // work order is assigned to exactly one of them, which breaks the tie.
  describe("work-order assignment tie-break", () => {
    const ryanUser = { id: "contact_ryan_user", name: "Ryan Smith" };
    const ryanClient = { id: "contact_ryan_client", name: "Ryan Smith" };
    const ryanCustomer = { id: "contact_ryan_customer", name: "Ryan Smith" };

    it("resolves to the contact the work order is assigned to", async () => {
      findContactsByName.mockResolvedValue([ryanUser, ryanClient, ryanCustomer]);

      const result = await resolveSupplier(
        { abn: null, name: "Ryan Smith", workOrderAssignedId: "contact_ryan_user" },
        context,
      );

      expect(result).toEqual({ status: "matched_by_assignment", contact: ryanUser });
    });

    // The property that makes this not a dressed-up data[0]: the tie-break can
    // only choose among contacts the INVOICE named. An assignee whose name is
    // nothing like the supplier on the invoice must never be selected.
    it("does not select an assignee whose name the invoice never mentioned", async () => {
      findContactsByName.mockResolvedValue([ryanUser, ryanClient]);

      const result = await resolveSupplier(
        { abn: null, name: "Ryan Smith", workOrderAssignedId: "contact_someone_else" },
        context,
      );

      expect(result).toEqual({ status: "not_found" });
    });

    // No name match means no corroboration at all — the assignment alone is not
    // evidence that this work order's assignee sent this invoice.
    it("never fires when the name matched nobody", async () => {
      findContactsByName.mockResolvedValue([]);

      const result = await resolveSupplier(
        { abn: null, name: "Unknown Co", workOrderAssignedId: "contact_ryan_user" },
        context,
      );

      expect(result).toEqual({ status: "not_found" });
    });

    it("leaves an unambiguous single name match reported as matched_by_name", async () => {
      findContactsByName.mockResolvedValue([tobey]);

      const result = await resolveSupplier(
        { abn: null, name: "Tobey Chan", workOrderAssignedId: "contact_ryan_user" },
        context,
      );

      expect(result).toEqual({ status: "matched_by_name", contact: tobey });
    });

    it("stays unresolved when the work order has no assignee to break the tie with", async () => {
      findContactsByName.mockResolvedValue([ryanUser, ryanClient]);

      const result = await resolveSupplier({ abn: null, name: "Ryan Smith" }, context);

      expect(result).toEqual({ status: "not_found" });
    });

    it("still prefers a genuine ABN match over the tie-break", async () => {
      findContactsByAbn.mockResolvedValue([ryanClient]);

      const result = await resolveSupplier(
        { abn: VALID_ABN, name: "Ryan Smith", workOrderAssignedId: "contact_ryan_user" },
        context,
      );

      expect(result).toEqual({ status: "matched_by_abn", contact: ryanClient });
      expect(findContactsByName).not.toHaveBeenCalled();
    });
  });

  // ASSUME_SUPPLIER_MATCHED exists only because production Prime holds four
  // contacts named "Ryan Smith", so the client's own auto-approve invoice cannot
  // resolve a supplier. It must change what an UNRESOLVED result means and
  // nothing else — never which lookups run, never a genuine match.
  describe("with ASSUME_SUPPLIER_MATCHED on", () => {
    beforeEach(() => {
      assumeSupplierMatched = true;
    });

    it("assumes the supplier when several contacts share the name, reporting how many", async () => {
      findContactsByName.mockResolvedValue([ryan, tobey]);

      const result = await resolveSupplier({ abn: null, name: "Ryan Smith" }, context);

      expect(result).toEqual({ status: "assumed", candidateCount: 2 });
      // Still asked Prime — the flag forgives the answer, it does not skip the question.
      expect(findContactsByName).toHaveBeenCalledWith("Ryan Smith", context);
    });

    it("assumes the supplier when Prime has nobody by that name", async () => {
      findContactsByName.mockResolvedValue([]);

      const result = await resolveSupplier({ abn: null, name: "Unknown Co" }, context);

      expect(result).toEqual({ status: "assumed", candidateCount: 0 });
    });

    it("still reports a genuine single name match as matched_by_name", async () => {
      findContactsByName.mockResolvedValue([tobey]);

      const result = await resolveSupplier({ abn: null, name: "Tobey Chan" }, context);

      expect(result).toEqual({ status: "matched_by_name", contact: tobey });
    });

    it("still prefers a genuine ABN match over assuming", async () => {
      findContactsByAbn.mockResolvedValue([ryan]);

      const result = await resolveSupplier({ abn: VALID_ABN, name: "Ryan Smith" }, context);

      expect(result).toEqual({ status: "matched_by_abn", contact: ryan });
      expect(findContactsByName).not.toHaveBeenCalled();
    });

    it("assumes without a contact — there is no verified one to hand back", async () => {
      findContactsByName.mockResolvedValue([ryan, tobey]);

      const result = await resolveSupplier({ abn: null, name: "Ryan Smith" }, context);

      expect(result).not.toHaveProperty("contact");
    });
  });
});
