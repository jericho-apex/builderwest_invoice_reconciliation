import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// loadEnv caches on first call, so every case here needs a fresh module
// registry — hence resetModules + a dynamic import rather than a top-level one.
const REQUIRED = {
  PRIME_BASE_URL: "https://www.primeeco.tech/api.prime/v2",
  PRIME_CLIENT_ID: "test",
  PRIME_CLIENT_SECRET: "test",
  PRIME_USERNAME: "test",
  PRIME_PASSWORD: "test",
  GRAPH_TENANT_ID: "test",
  GRAPH_CLIENT_ID: "test",
  GRAPH_CLIENT_SECRET: "test",
  GRAPH_MAILBOX_ADDRESS: "invoices@example.com",
  OPENROUTER_API_KEY: "test",
};

const originalEnv = process.env;

async function loadWith(overrides: Record<string, string>) {
  process.env = { ...originalEnv, ...REQUIRED, ...overrides };
  vi.resetModules();
  const { loadEnv } = await import("../../src/config/env.js");
  return loadEnv();
}

describe("loadEnv", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to the settled cost basis and the safe flags", async () => {
    const env = await loadWith({});

    expect(env.COST_FIELD).toBe("costTotalIncTax");
    expect(env.PRIME_DRY_RUN).toBe(true);
    expect(env.ASSUME_SUPPLIER_MATCHED).toBe(false);
    expect(env.PRIME_WORK_ORDER_PO_FIELD).toBe("label");
  });

  // The one combination that could approve a real AP invoice in production Prime
  // against a supplier nobody verified. Config validation is the only thing
  // standing between an operator's stray env edit and that outcome.
  it("refuses to start when the supplier check is bypassed on the live write path", async () => {
    await expect(
      loadWith({ ASSUME_SUPPLIER_MATCHED: "true", PRIME_DRY_RUN: "false" }),
    ).rejects.toThrow(/ASSUME_SUPPLIER_MATCHED is true but PRIME_DRY_RUN is false/);
  });

  it("allows the bypass while dry-run is on — that is the test-run case it exists for", async () => {
    const env = await loadWith({ ASSUME_SUPPLIER_MATCHED: "true", PRIME_DRY_RUN: "true" });

    expect(env.ASSUME_SUPPLIER_MATCHED).toBe(true);
    expect(env.PRIME_DRY_RUN).toBe(true);
  });

  it("allows the live write path when the supplier check is intact", async () => {
    const env = await loadWith({ ASSUME_SUPPLIER_MATCHED: "false", PRIME_DRY_RUN: "false" });

    expect(env.PRIME_DRY_RUN).toBe(false);
  });

  it("rejects a COST_FIELD naming a Prime field that cannot be compared to an invoice total", async () => {
    // "costTaxTotal" is the GST amount alone and "cost" does not exist on a
    // Prime work order — both were accepted before and made a correct invoice
    // unmatchable.
    await expect(loadWith({ COST_FIELD: "costTaxTotal" })).rejects.toThrow(/COST_FIELD/);
    await expect(loadWith({ COST_FIELD: "cost" })).rejects.toThrow(/COST_FIELD/);
  });

  it("lists every missing variable at once rather than failing on the first", async () => {
    process.env = { ...originalEnv, ...REQUIRED };
    delete process.env.PRIME_CLIENT_ID;
    delete process.env.GRAPH_TENANT_ID;
    delete process.env.OPENROUTER_API_KEY;
    vi.resetModules();
    const { loadEnv } = await import("../../src/config/env.js");

    expect(() => loadEnv()).toThrow(/PRIME_CLIENT_ID[\s\S]*GRAPH_TENANT_ID[\s\S]*OPENROUTER_API_KEY/);
  });
});
