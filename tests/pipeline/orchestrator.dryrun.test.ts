import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Env MUST be set before importing any module that calls loadEnv() (it caches
// on first call). PRIME_DRY_RUN=true is the whole point of this suite: the
// Prime write clients (upload / create AP / approve / poll sync) run for real
// but short-circuit to fabricated IDs, so the full pipeline is exercised end
// to end without a single Prime network call.
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "bw-pipeline-dryrun-"));
process.env.DB_PATH = join(dir, "app.db");
process.env.PRIME_DRY_RUN = "true";
process.env.PRIME_BASE_URL = "https://www.primeeco.tech/api/prime/v2";
process.env.PRIME_CLIENT_ID = "test";
process.env.PRIME_CLIENT_SECRET = "test";
process.env.PRIME_USERNAME = "test";
process.env.PRIME_PASSWORD = "test";
process.env.COST_TOLERANCE_MODE = "exact";
process.env.COST_TOLERANCE_VALUE = "0";
process.env.COST_FIELD = "costTotalIncTax";
// Off, so the exactly-one-match supplier rule is what these tests exercise. The
// one test that needs it on sets it per-case and restores it.
process.env.ASSUME_SUPPLIER_MATCHED = "false";
process.env.GRAPH_TENANT_ID = "test";
process.env.GRAPH_CLIENT_ID = "test";
process.env.GRAPH_CLIENT_SECRET = "test";
process.env.GRAPH_MAILBOX_ADDRESS = "invoices@example.com";
process.env.OPENROUTER_API_KEY = "test";

// ---- Graph mocks (no real mailbox) ----
const getPdfAttachments = vi.fn();
const getMessageById = vi.fn();
vi.mock("../../src/lib/graph/mailbox.js", () => ({
  getPdfAttachments: (...a: unknown[]) => getPdfAttachments(...a),
  getMessageById: (...a: unknown[]) => getMessageById(...a),
}));

const moveMessage = vi.fn();
const getOrCreateFolderId = vi.fn();
vi.mock("../../src/lib/graph/folders.js", () => ({
  moveMessage: (...a: unknown[]) => moveMessage(...a),
  getOrCreateFolderId: (...a: unknown[]) => getOrCreateFolderId(...a),
}));

const sendMissingDataReply = vi.fn();
vi.mock("../../src/lib/graph/sendMail.js", () => ({
  sendMissingDataReply: (...a: unknown[]) => sendMissingDataReply(...a),
}));

// ---- Extraction mocks (no real OpenRouter call) ----
const classifyMessage = vi.fn();
vi.mock("../../src/lib/extraction/classifyMessage.js", () => ({
  classifyMessage: (...a: unknown[]) => classifyMessage(...a),
}));

const extractInvoiceFields = vi.fn();
vi.mock("../../src/lib/extraction/extractInvoice.js", () => ({
  extractInvoiceFields: (...a: unknown[]) => extractInvoiceFields(...a),
}));

// ---- Prime READ mocks. Prime WRITES are intentionally NOT mocked — they run
// through the real dry-run gate. ----
const findWorkOrdersByPurchaseOrder = vi.fn();
vi.mock("../../src/lib/prime/workOrders.js", () => ({
  findWorkOrdersByPurchaseOrder: (...a: unknown[]) => findWorkOrdersByPurchaseOrder(...a),
}));

const findContactsByAbn = vi.fn();
const findContactsByName = vi.fn();
vi.mock("../../src/lib/prime/contacts.js", () => ({
  findContactsByAbn: (...a: unknown[]) => findContactsByAbn(...a),
  findContactsByName: (...a: unknown[]) => findContactsByName(...a),
}));

const { runMigrations } = await import("../../src/db/migrate.js");
const { getDb } = await import("../../src/db/client.js");
const { processMessage } = await import("../../src/pipeline/orchestrator.js");
const { getInvoiceByMessage } = await import("../../src/db/repositories/invoices.js");
const { isEligibleForProcessing } = await import(
  "../../src/db/repositories/processedMessages.js"
);
const { EXCEPTION_FOLDERS, PROCESSED_FOLDER } = await import("../../src/config/constants.js");

import {
  CLIENT_DUMMY_INVOICES,
  PRIME_CONTACTS,
  PRIME_WORK_ORDERS,
  toPrimeContact,
  toPrimeWorkOrder,
} from "../fixtures/clientDummyInvoices.js";

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
// Fixtures mirror the client's real dummy invoices
// (docs/Dummy_Invoice_1_PO21266_CORRECT.pdf and
// docs/Dummy_Invoice_2_PO21267_INCORRECT_AMOUNT.pdf): both are Stage 1 / Stage 2
// of the SAME job BWC-5126, distinguished only by their purchase order, and
// both print the placeholder ABN "00 000 000 000" despite coming from
// different suppliers.
let messageCounter = 0;
function makeMessage() {
  messageCounter += 1;
  return {
    id: `msg-dryrun-${messageCounter}`,
    receivedDateTime: "2026-07-21T00:00:00Z",
    subject: "Invoice TEST-INV-001",
    hasAttachments: true,
    from: { emailAddress: { address: "supplier@example.com", name: "Ryan Smith" } },
  };
}

const PDF_ATTACHMENT = {
  id: "att-graph-1",
  name: "invoice.pdf",
  contentType: "application/pdf",
  contentBytes: Buffer.from("%PDF-1.4 fake").toString("base64"),
};

// Dummy invoice 1: $478.50 inc GST, matching the Stage 1 work order's ex-GST
// cost plus its GST ($435.00 + $43.50) exactly.
const CLEAN_EXTRACTION = {
  supplierName: "Ryan Smith",
  supplierAbn: "00 000 000 000",
  invoiceNumber: "TEST-INV-001",
  invoiceDate: "2026-07-22",
  dueDate: "2026-07-22",
  exTaxAmount: 435.0,
  taxAmount: 43.5,
  totalAmount: 478.5,
  purchaseOrderNumber: "PO21266",
  jobNumber: "BWC-5126",
  workOrderRef: null,
  confidence: 0.95,
};

const MATCHING_WORK_ORDER = {
  id: "wo_po21266",
  costTotalCents: 43_500,
  costTaxTotalCents: 4_350,
};

// Stage 2 of the same job — the work order an invoice must never be matched to
// by accident.
const SIBLING_WORK_ORDER = {
  id: "wo_po21267",
  costTotalCents: 40_500,
  costTaxTotalCents: 4_050,
};

const MATCHING_CONTACT = { id: "contact_ryan", name: "Ryan Smith" };

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  // Happy-path defaults; each test overrides only what it needs to diverge.
  getPdfAttachments.mockResolvedValue([PDF_ATTACHMENT]);
  getMessageById.mockResolvedValue(makeMessageSummaryForReply());
  moveMessage.mockResolvedValue(undefined);
  getOrCreateFolderId.mockResolvedValue("folder-id");
  sendMissingDataReply.mockResolvedValue(undefined);
  classifyMessage.mockResolvedValue({ category: "invoice", confidence: 0.9 });
  extractInvoiceFields.mockResolvedValue({ ...CLEAN_EXTRACTION });
  findWorkOrdersByPurchaseOrder.mockResolvedValue([{ ...MATCHING_WORK_ORDER }]);
  // The placeholder ABN never reaches Prime, so the supplier resolves by name.
  findContactsByAbn.mockResolvedValue([]);
  findContactsByName.mockResolvedValue([{ ...MATCHING_CONTACT }]);
});

interface MatchResultRow {
  work_order_match_status: string;
  work_order_id: string | null;
  supplier_match_status: string;
  supplier_contact_id: string | null;
  decision: string;
  exception_reason: string | null;
  work_order_cost_cents: number | null;
  invoice_total_cents: number | null;
}

/** The authoritative matching attempt for an invoice — the newest row. */
function latestMatchResult(invoiceId: number): MatchResultRow {
  return getDb()
    .prepare<[number], MatchResultRow>(
      `SELECT work_order_match_status, work_order_id,
              supplier_match_status, supplier_contact_id,
              decision, exception_reason,
              work_order_cost_cents, invoice_total_cents
         FROM match_results WHERE invoice_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(invoiceId)!;
}

function makeMessageSummaryForReply() {
  return {
    id: "any",
    receivedDateTime: "2026-07-21T00:00:00Z",
    subject: "Invoice TEST-INV-001",
    hasAttachments: true,
    from: { emailAddress: { address: "supplier@example.com", name: "Ryan Smith" } },
  };
}

describe("dry-run pipeline (no Prime writes)", () => {
  it("clean match -> approved -> synced, moved to Processed, using only fabricated dry-run Prime IDs", async () => {
    const message = makeMessage();

    await processMessage(message);

    const invoice = getInvoiceByMessage(message.id)!;
    expect(invoice.stage).toBe("synced");
    expect(invoice.isSynced).toBe(true);
    // Proof no real Prime write happened: every Prime-side ID is a dry-run stub.
    expect(invoice.primeAttachmentId).toMatch(/^dryrun-/);
    expect(invoice.primeApInvoiceId).toMatch(/^dryrun-/);
    expect(moveMessage).toHaveBeenCalledWith(message.id, PROCESSED_FOLDER, expect.anything());
  });

  it("persists the purchase order and job number separately", async () => {
    const message = makeMessage();

    await processMessage(message);

    const invoice = getInvoiceByMessage(message.id)!;
    expect(invoice.extractedPurchaseOrderNumber).toBe("PO21266");
    expect(invoice.extractedJobNumber).toBe("BWC-5126");
    // The PO — not the job number — is what the work-order lookup keys off.
    expect(findWorkOrdersByPurchaseOrder).toHaveBeenCalledWith("PO21266", expect.anything());
  });

  // Dummy invoice 2: same job, different PO, $775.50 against the Stage 1 work
  // order's $478.50.
  it("cost mismatch -> Exceptions/Cost mismatch, no approval", async () => {
    extractInvoiceFields.mockResolvedValue({
      ...CLEAN_EXTRACTION,
      supplierName: "Tobey Chan",
      invoiceNumber: "TEST-INV-002",
      exTaxAmount: 705.0,
      taxAmount: 70.5,
      totalAmount: 775.5,
      purchaseOrderNumber: "PO21267",
    });
    const message = makeMessage();

    await processMessage(message);

    const invoice = getInvoiceByMessage(message.id)!;
    expect(invoice.stage).toBe("exception");
    expect(invoice.exceptionReason).toBe("costMismatch");
    expect(invoice.primeApInvoiceId).toBeNull();
    expect(moveMessage).toHaveBeenCalledWith(
      message.id,
      EXCEPTION_FOLDERS.costMismatch,
      expect.anything(),
    );
  });

  it("unresolvable work order -> Exceptions/No work order", async () => {
    findWorkOrdersByPurchaseOrder.mockResolvedValue([]);
    const message = makeMessage();

    await processMessage(message);

    const invoice = getInvoiceByMessage(message.id)!;
    expect(invoice.stage).toBe("exception");
    expect(invoice.exceptionReason).toBe("noWorkOrder");
    expect(moveMessage).toHaveBeenCalledWith(
      message.id,
      EXCEPTION_FOLDERS.noWorkOrder,
      expect.anything(),
    );
  });

  // An invoice whose PO somehow resolves to more than one work order must not
  // be approved against either of them.
  it("ambiguous work order -> Exceptions/No work order, recorded as ambiguous, never approved", async () => {
    findWorkOrdersByPurchaseOrder.mockResolvedValue([
      { ...MATCHING_WORK_ORDER },
      { ...SIBLING_WORK_ORDER },
    ]);
    const message = makeMessage();

    await processMessage(message);

    const invoice = getInvoiceByMessage(message.id)!;
    expect(invoice.stage).toBe("exception");
    expect(invoice.exceptionReason).toBe("noWorkOrder");
    expect(invoice.primeWorkOrderId).toBeNull();
    expect(invoice.primeApInvoiceId).toBeNull();
    expect(moveMessage).toHaveBeenCalledWith(
      message.id,
      EXCEPTION_FOLDERS.noWorkOrder,
      expect.anything(),
    );

    const matchResult = latestMatchResult(invoice.id);
    expect(matchResult.work_order_match_status).toBe("ambiguous");
  });

  it("unresolved supplier -> Exceptions/Supplier not found", async () => {
    findContactsByAbn.mockResolvedValue([]);
    findContactsByName.mockResolvedValue([]);
    const message = makeMessage();

    await processMessage(message);

    const invoice = getInvoiceByMessage(message.id)!;
    expect(invoice.stage).toBe("exception");
    expect(invoice.exceptionReason).toBe("supplierNotFound");
    expect(moveMessage).toHaveBeenCalledWith(
      message.id,
      EXCEPTION_FOLDERS.supplierNotFound,
      expect.anything(),
    );
  });

  it("low-confidence extraction -> Exceptions/Unreadable and fires the missing-data reply", async () => {
    extractInvoiceFields.mockResolvedValue({ ...CLEAN_EXTRACTION, confidence: 0.4 });
    const message = makeMessage();

    await processMessage(message);

    const invoice = getInvoiceByMessage(message.id)!;
    expect(invoice.stage).toBe("exception");
    expect(invoice.exceptionReason).toBe("unreadable");
    expect(moveMessage).toHaveBeenCalledWith(
      message.id,
      EXCEPTION_FOLDERS.unreadable,
      expect.anything(),
    );
    expect(sendMissingDataReply).toHaveBeenCalledOnce();
  });

  it("non-invoice classification is marked processed and never gets an invoices row", async () => {
    classifyMessage.mockResolvedValue({ category: "job_note", confidence: 0.9 });
    const message = makeMessage();

    await processMessage(message);

    expect(getInvoiceByMessage(message.id)).toBeUndefined();
    expect(isEligibleForProcessing(message.id)).toBe(false); // marked processed
    expect(extractInvoiceFields).not.toHaveBeenCalled();
  });

  // Regression test for the P1.1 fix (analyze.md): a classifier failure must
  // NOT silently drop the message. It stays un-marked (so the next poll retries
  // it) and no orphan invoice row is created.
  it("classifier failure leaves the message eligible for retry and creates no invoice row", async () => {
    classifyMessage.mockRejectedValue(new Error("OpenRouter unavailable"));
    const message = makeMessage();

    await expect(processMessage(message)).rejects.toThrow(/OpenRouter unavailable/);

    expect(getInvoiceByMessage(message.id)).toBeUndefined();
    expect(isEligibleForProcessing(message.id)).toBe(true); // still retryable
  });
});

// ---------------------------------------------------------------------------
// The acceptance contract for the client's three dummy invoices: exactly one of
// them may be approved, and the other two must each be flagged for the right
// reason. Extraction stays mocked here so `npm test` remains offline and
// deterministic — scripts/pipeline-sample.ts is the counterpart that runs the
// real PDFs through the real model against the same fixtures.
//
// Unlike the suite above, the Prime finders here are genuinely KEYED. The
// default stub returns the Stage 1 work order for every PO, which cannot tell
// PO21266 from PO99999 and so cannot prove anything about invoice 3.
// ---------------------------------------------------------------------------
describe("the three client dummy invoices", () => {
  beforeEach(() => {
    findWorkOrdersByPurchaseOrder.mockImplementation(async (po: string) =>
      PRIME_WORK_ORDERS.filter((w) => w.purchaseOrderNumber === po).map(toPrimeWorkOrder),
    );
    findContactsByName.mockImplementation(async (name: string) =>
      PRIME_CONTACTS.filter((c) => c.attributes.name === name).map(toPrimeContact),
    );
    // The placeholder ABN must never reach Prime at all — asserted below.
    findContactsByAbn.mockImplementation(async () => {
      throw new Error("findContactsByAbn must not be called: the placeholder ABN is invalid");
    });
  });

  it.each(CLIENT_DUMMY_INVOICES.map((c) => [c.label, c] as const))(
    "%s routes correctly end to end",
    async (_label, invoiceCase) => {
      extractInvoiceFields.mockResolvedValue({
        ...CLEAN_EXTRACTION,
        ...invoiceCase.extraction,
      });
      const message = makeMessage();

      await processMessage(message);

      const invoice = getInvoiceByMessage(message.id)!;
      const expected = invoiceCase.expected;

      expect(invoice.stage).toBe(expected.stage);
      expect(invoice.exceptionReason).toBe(expected.reason ?? null);

      // The PO — never the shared job number — is what the lookup keys off.
      expect(findWorkOrdersByPurchaseOrder).toHaveBeenCalledWith(
        invoiceCase.extraction.purchaseOrderNumber,
        expect.anything(),
      );

      // Field-level, not outcome-level. Invoice 2 yields costMismatch whether
      // the model reads "Tobey Chan" (the issuer) or "Ryan Smith" (its
      // Attention line), so only the resolved contact id catches that.
      //
      // These live on match_results, not the invoices row: setResolvedMatch
      // runs on the approve branch only, so a flagged invoice deliberately
      // commits nothing to invoices.prime_* — what it resolved before failing
      // is recorded as evidence, not as state.
      const matchResult = latestMatchResult(invoice.id);
      expect(matchResult.work_order_id).toBe(expected.workOrderId ?? null);
      expect(matchResult.supplier_contact_id).toBe(expected.contactId ?? null);
      expect(matchResult.work_order_match_status).toBe(expected.workOrderMatchStatus);
      expect(matchResult.supplier_match_status).toBe(expected.supplierMatchStatus);
      expect(matchResult.decision).toBe(expected.outcome);
      expect(matchResult.exception_reason).toBe(expected.reason ?? null);

      if (expected.outcome === "approve") {
        expect(invoice.isSynced).toBe(true);
        expect(invoice.primeWorkOrderId).toBe(expected.workOrderId);
        expect(invoice.primeContactId).toBe(expected.contactId);
        expect(invoice.primeApInvoiceId).toMatch(/^dryrun-/); // no real Prime write
        expect(moveMessage).toHaveBeenCalledWith(message.id, PROCESSED_FOLDER, expect.anything());
      } else {
        expect(invoice.primeWorkOrderId).toBeNull();
        expect(invoice.primeContactId).toBeNull();
        // Nothing was pushed to Prime for a flagged invoice.
        expect(invoice.primeApInvoiceId).toBeNull();
        expect(moveMessage).toHaveBeenCalledWith(
          message.id,
          EXCEPTION_FOLDERS[expected.reason!],
          expect.anything(),
        );
      }
    },
  );

  it("compares invoice 2 against its OWN work order, not the sibling stage", async () => {
    const invoiceCase = CLIENT_DUMMY_INVOICES[1]!;
    extractInvoiceFields.mockResolvedValue({ ...CLEAN_EXTRACTION, ...invoiceCase.extraction });
    const message = makeMessage();

    await processMessage(message);

    // The recorded comparison must be $775.50 against PO21267's own inc-GST cost
    // ($405.00 + $40.50 = $445.50, the real production figures). If the finder
    // were unkeyed it would silently compare against Stage 1 ($478.50) and "cost
    // mismatch" would prove nothing about the amount.
    const matchResult = latestMatchResult(getInvoiceByMessage(message.id)!.id);
    expect(matchResult.invoice_total_cents).toBe(77_550);
    expect(matchResult.work_order_cost_cents).toBe(44_550);
  });

  it("never queries Prime by the placeholder ABN for any of the three", async () => {
    for (const invoiceCase of CLIENT_DUMMY_INVOICES) {
      extractInvoiceFields.mockResolvedValue({ ...CLEAN_EXTRACTION, ...invoiceCase.extraction });
      await processMessage(makeMessage());
    }

    // All three print "00 000 000 000"; matching/abn.ts rejects it, so supplier
    // resolution falls through to the name lookup. Had it not, all three would
    // resolve to whichever contact carries the placeholder.
    expect(findContactsByAbn).not.toHaveBeenCalled();
    expect(findContactsByName).toHaveBeenCalledWith("Ryan Smith", expect.anything());
    expect(findContactsByName).toHaveBeenCalledWith("Tobey Chan", expect.anything());
    // Invoice 3 fails on its PO first, so its supplier is never looked up.
    expect(findContactsByName).not.toHaveBeenCalledWith("Brittnii Woods", expect.anything());
  });
});
