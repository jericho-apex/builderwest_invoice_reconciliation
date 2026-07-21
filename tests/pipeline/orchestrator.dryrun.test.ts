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
process.env.COST_FIELD = "costTaxTotal";
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
const findWorkOrderByReference = vi.fn();
const findWorkOrderByJobNumber = vi.fn();
vi.mock("../../src/lib/prime/workOrders.js", () => ({
  findWorkOrderByReference: (...a: unknown[]) => findWorkOrderByReference(...a),
  findWorkOrderByJobNumber: (...a: unknown[]) => findWorkOrderByJobNumber(...a),
}));

const findContactByAbn = vi.fn();
const findContactByName = vi.fn();
vi.mock("../../src/lib/prime/contacts.js", () => ({
  findContactByAbn: (...a: unknown[]) => findContactByAbn(...a),
  findContactByName: (...a: unknown[]) => findContactByName(...a),
}));

const { runMigrations } = await import("../../src/db/migrate.js");
const { processMessage } = await import("../../src/pipeline/orchestrator.js");
const { getInvoiceByMessage } = await import("../../src/db/repositories/invoices.js");
const { isEligibleForProcessing } = await import(
  "../../src/db/repositories/processedMessages.js"
);
const { EXCEPTION_FOLDERS, PROCESSED_FOLDER } = await import("../../src/config/constants.js");

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
let messageCounter = 0;
function makeMessage() {
  messageCounter += 1;
  return {
    id: `msg-dryrun-${messageCounter}`,
    receivedDateTime: "2026-07-21T00:00:00Z",
    subject: "Invoice 12345",
    hasAttachments: true,
    from: { emailAddress: { address: "supplier@example.com", name: "Acme Roofing" } },
  };
}

const PDF_ATTACHMENT = {
  id: "att-graph-1",
  name: "invoice.pdf",
  contentType: "application/pdf",
  contentBytes: Buffer.from("%PDF-1.4 fake").toString("base64"),
};

// A clean extraction whose tax-inclusive total ($1,500.00) matches the work
// order's costTaxTotal below exactly.
const CLEAN_EXTRACTION = {
  supplierName: "Acme Roofing",
  supplierAbn: "12345678901",
  invoiceNumber: "INV-12345",
  invoiceDate: "2026-07-01",
  dueDate: "2026-07-31",
  exTaxAmount: 1363.64,
  taxAmount: 136.36,
  totalAmount: 1500.0,
  workOrderRef: "WO-42",
  confidence: 0.95,
};

const MATCHING_WORK_ORDER = {
  id: "wo_1",
  costCents: 136_364,
  costTaxTotalCents: 150_000,
};

const MATCHING_CONTACT = { id: "contact_1", name: "Acme Roofing", abn: "12345678901" };

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
  findWorkOrderByReference.mockResolvedValue({ ...MATCHING_WORK_ORDER });
  findWorkOrderByJobNumber.mockResolvedValue(undefined);
  findContactByAbn.mockResolvedValue({ ...MATCHING_CONTACT });
  findContactByName.mockResolvedValue(undefined);
});

function makeMessageSummaryForReply() {
  return {
    id: "any",
    receivedDateTime: "2026-07-21T00:00:00Z",
    subject: "Invoice 12345",
    hasAttachments: true,
    from: { emailAddress: { address: "supplier@example.com", name: "Acme Roofing" } },
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

  it("cost mismatch -> Exceptions/Cost mismatch, no approval", async () => {
    extractInvoiceFields.mockResolvedValue({ ...CLEAN_EXTRACTION, totalAmount: 1499.99 });
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
    findWorkOrderByReference.mockResolvedValue(undefined);
    findWorkOrderByJobNumber.mockResolvedValue(undefined);
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

  it("unresolved supplier -> Exceptions/Supplier not found", async () => {
    findContactByAbn.mockResolvedValue(undefined);
    findContactByName.mockResolvedValue(undefined);
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
