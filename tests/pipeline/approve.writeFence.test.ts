import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// The one suite that runs with PRIME_DRY_RUN=false, because the write fence only
// exists on the live path — under dry-run nothing reaches Prime anyway, and
// fencing the rehearsal would stop it rehearsing. Prime's write clients are
// mocked here for exactly that reason: with dry-run off, a fence that failed to
// hold would otherwise POST to production.
//
// Env must be set before importing anything that calls loadEnv(), which caches.
// ---------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "bw-write-fence-"));
process.env.DB_PATH = join(dir, "app.db");
process.env.PRIME_DRY_RUN = "false";
process.env.PRIME_TEST_WORK_ORDER_IDS = "wo-test-allowed,wo-test-also-allowed";
process.env.PRIME_BASE_URL = "https://www.primeeco.tech/api/prime/v2";
process.env.PRIME_CLIENT_ID = "test";
process.env.PRIME_CLIENT_SECRET = "test";
process.env.PRIME_USERNAME = "test";
process.env.PRIME_PASSWORD = "test";
process.env.GRAPH_TENANT_ID = "test";
process.env.GRAPH_CLIENT_ID = "test";
process.env.GRAPH_CLIENT_SECRET = "test";
process.env.GRAPH_MAILBOX_ADDRESS = "invoices@example.com";
process.env.OPENROUTER_API_KEY = "test";

const getPdfAttachments = vi.fn();
vi.mock("../../src/lib/graph/mailbox.js", () => ({
  getPdfAttachments: (...a: unknown[]) => getPdfAttachments(...a),
  getMessageById: vi.fn(),
}));

const moveMessage = vi.fn();
vi.mock("../../src/lib/graph/folders.js", () => ({
  moveMessage: (...a: unknown[]) => moveMessage(...a),
  getOrCreateFolderId: vi.fn(),
}));

vi.mock("../../src/lib/graph/sendMail.js", () => ({ sendMissingDataReply: vi.fn() }));

const uploadAttachment = vi.fn();
vi.mock("../../src/lib/prime/attachments.js", () => ({
  uploadAttachment: (...a: unknown[]) => uploadAttachment(...a),
  DRY_RUN_ID_PREFIX: "dryrun-",
}));

const createApInvoice = vi.fn();
const approveApInvoice = vi.fn();
const readBackApInvoice = vi.fn();
vi.mock("../../src/lib/prime/apInvoices.js", () => ({
  createApInvoice: (...a: unknown[]) => createApInvoice(...a),
  approveApInvoice: (...a: unknown[]) => approveApInvoice(...a),
  readBackApInvoice: (...a: unknown[]) => readBackApInvoice(...a),
}));

const { runMigrations } = await import("../../src/db/migrate.js");
const { getDb } = await import("../../src/db/client.js");
const { advanceApproveFlow } = await import("../../src/pipeline/approve.js");
const { getOrCreateInvoice, setExtraction, setResolvedMatch, getInvoiceById } = await import(
  "../../src/db/repositories/invoices.js"
);
const { EXCEPTION_FOLDERS } = await import("../../src/config/constants.js");

let messageCounter = 0;

/** An invoice sitting at stage `matched` against `workOrderId`, ready to write. */
function invoiceReadyToWrite(workOrderId: string): number {
  messageCounter += 1;
  const invoiceId = getOrCreateInvoice(`msg-fence-${messageCounter}`, 0);

  setExtraction(invoiceId, {
    supplierName: "Hutchy Ceilings Pty Ltd",
    invoiceNumber: "26",
    invoiceDate: "2026-07-28",
    dueDate: "2026-08-27",
    totalAmountCents: 120_450,
    purchaseOrderNumber: "PO21343",
    confidence: 0.95,
  });
  setResolvedMatch(invoiceId, {
    primeWorkOrderId: workOrderId,
    primeJobId: "job-bwc-wa-6797",
    primeContactId: "contact-hutchy",
  });

  return invoiceId;
}

function auditEventTypes(invoiceId: number): string[] {
  return getDb()
    .prepare<[number], { event_type: string }>(
      "SELECT event_type FROM audit_log WHERE invoice_id = ? ORDER BY id",
    )
    .all(invoiceId)
    .map((row) => row.event_type);
}

beforeAll(() => {
  runMigrations();
});

beforeEach(() => {
  vi.clearAllMocks();
  getPdfAttachments.mockResolvedValue([
    {
      name: "26.pdf",
      contentType: "application/pdf",
      contentBytes: Buffer.from("%PDF-1.4 fake").toString("base64"),
    },
  ]);
  uploadAttachment.mockResolvedValue("attachment-real");
  createApInvoice.mockResolvedValue("ap-invoice-real");
  approveApInvoice.mockResolvedValue(undefined);
  readBackApInvoice.mockResolvedValue({
    approvalStatus: "Approved",
    accountsPayableInvoiceStatus: "New",
    workOrderId: "wo-test-allowed",
    isSynced: false,
  });
});

describe("the live-write fence", () => {
  // There is no Prime sandbox, and the pilot mailbox is a real one that could
  // receive a genuine supplier invoice mid-test. Nothing but this check stands
  // between that invoice and an approved payable pushed to Xero.
  it("refuses to write for a work order outside the allowlist", async () => {
    const invoiceId = invoiceReadyToWrite("wo-a-real-customer-job");

    const result = await advanceApproveFlow(invoiceId, { invoiceId, messageId: "msg-fence-1" });

    expect(result).toBe("exception");
    const invoice = getInvoiceById(invoiceId)!;
    expect(invoice.stage).toBe("exception");
    expect(invoice.exceptionReason).toBe("writeBlocked");
  });

  // Blocked BEFORE the upload, so a fenced-out invoice leaves nothing behind on
  // the Prime job for someone to clean up — the same reason the missing-fields
  // check sits ahead of the upload.
  it("blocks before the attachment upload, leaving nothing in Prime", async () => {
    const invoiceId = invoiceReadyToWrite("wo-a-real-customer-job");

    await advanceApproveFlow(invoiceId, { invoiceId, messageId: "msg-fence-2" });

    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(createApInvoice).not.toHaveBeenCalled();
    expect(approveApInvoice).not.toHaveBeenCalled();
    const invoice = getInvoiceById(invoiceId)!;
    expect(invoice.primeAttachmentId).toBeNull();
    expect(invoice.primeApInvoiceId).toBeNull();
  });

  it("files the blocked invoice in its own folder and says what was refused", async () => {
    const invoiceId = invoiceReadyToWrite("wo-a-real-customer-job");

    await advanceApproveFlow(invoiceId, { invoiceId, messageId: "msg-fence-3" });

    expect(moveMessage).toHaveBeenCalledWith(
      "msg-fence-3",
      EXCEPTION_FOLDERS.writeBlocked,
      expect.anything(),
    );
    expect(auditEventTypes(invoiceId)).toContain("pipeline.write_blocked_not_allowlisted");

    const detail = getDb()
      .prepare<[number], { detail: string }>(
        `SELECT detail FROM audit_log
          WHERE invoice_id = ? AND event_type = 'pipeline.write_blocked_not_allowlisted'`,
      )
      .get(invoiceId)!;
    // Both sides of the comparison, so a human can see immediately whether the
    // fence was wrong or the invoice was.
    expect(JSON.parse(detail.detail)).toEqual({
      primeWorkOrderId: "wo-a-real-customer-job",
      allowedWorkOrderIds: ["wo-test-allowed", "wo-test-also-allowed"],
    });
  });

  it("lets an allowlisted work order write all the way through", async () => {
    const invoiceId = invoiceReadyToWrite("wo-test-allowed");

    const result = await advanceApproveFlow(invoiceId, { invoiceId, messageId: "msg-fence-4" });

    expect(result).toBe("completed");
    expect(getInvoiceById(invoiceId)!.stage).toBe("approved");
    expect(uploadAttachment).toHaveBeenCalled();
    expect(createApInvoice).toHaveBeenCalled();
    expect(approveApInvoice).toHaveBeenCalledWith("ap-invoice-real", expect.anything());
  });

  it("honours every entry in the list, not just the first", async () => {
    const invoiceId = invoiceReadyToWrite("wo-test-also-allowed");

    await advanceApproveFlow(invoiceId, { invoiceId, messageId: "msg-fence-5" });

    expect(getInvoiceById(invoiceId)!.stage).toBe("approved");
  });
});
