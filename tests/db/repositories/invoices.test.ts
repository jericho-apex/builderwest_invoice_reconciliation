import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, it, expect } from "vitest";
import { runMigrations } from "../../../src/db/migrate.js";
import {
  createInvoice,
  getInvoiceById,
  getInvoiceByMessage,
  getOrCreateInvoice,
  getInvoicesByMessage,
  getInFlightInvoices,
  setExtraction,
  setResolvedMatch,
  setAttachmentUploaded,
  setApInvoiceCreated,
  setApprovedPendingSync,
  setSynced,
  setException,
  resetForRetry,
} from "../../../src/db/repositories/invoices.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "bw-invoices-test-"));
  process.env.DB_PATH = join(dir, "app.db");
  process.env.PRIME_BASE_URL = "https://www.primeeco.tech/api/prime/v2";
  process.env.PRIME_CLIENT_ID = "test";
  process.env.PRIME_CLIENT_SECRET = "test";
  process.env.PRIME_USERNAME = "test";
  process.env.PRIME_PASSWORD = "test";
  process.env.GRAPH_TENANT_ID = "test";
  process.env.GRAPH_CLIENT_ID = "test";
  process.env.GRAPH_CLIENT_SECRET = "test";
  process.env.GRAPH_MAILBOX_ADDRESS = "test@example.com";
  process.env.OPENROUTER_API_KEY = "test";

  runMigrations();
});

describe("invoices repository", () => {
  it("creates an invoice at stage 'received'", () => {
    const id = createInvoice("msg-create-1");
    const invoice = getInvoiceById(id);
    expect(invoice?.stage).toBe("received");
    expect(invoice?.messageId).toBe("msg-create-1");
    expect(invoice?.attachmentIndex).toBe(0);
  });

  it("getOrCreateInvoice returns the existing row instead of creating a duplicate", () => {
    const firstId = getOrCreateInvoice("msg-getorcreate-1", 0);
    const secondId = getOrCreateInvoice("msg-getorcreate-1", 0);
    expect(secondId).toBe(firstId);
  });

  it("getOrCreateInvoice treats different attachment indexes as distinct invoices", () => {
    const first = getOrCreateInvoice("msg-multi-attachment", 0);
    const second = getOrCreateInvoice("msg-multi-attachment", 1);
    expect(first).not.toBe(second);
    expect(getInvoicesByMessage("msg-multi-attachment")).toHaveLength(2);
  });

  it("setExtraction moves the invoice to stage 'extracted' and stores mapped fields", () => {
    const id = createInvoice("msg-extraction-1");
    setExtraction(id, {
      supplierName: "Acme Roofing",
      supplierAbn: "12345678901",
      totalAmountCents: 150_000,
      workOrderRef: "WO-42",
      confidence: 0.95,
    });

    const invoice = getInvoiceById(id)!;
    expect(invoice.stage).toBe("extracted");
    expect(invoice.extractedSupplierName).toBe("Acme Roofing");
    expect(invoice.extractedTotalAmountCents).toBe(150_000);
  });

  it("getInFlightInvoices excludes synced and exception invoices but includes everything else", () => {
    const inFlightId = createInvoice("msg-inflight-1");
    const exceptionId = createInvoice("msg-inflight-2");
    setException(exceptionId, "costMismatch");

    const inFlightIds = getInFlightInvoices().map((invoice) => invoice.id);
    expect(inFlightIds).toContain(inFlightId);
    expect(inFlightIds).not.toContain(exceptionId);
  });

  describe("resetForRetry — the core resumability guarantee", () => {
    it("restarts from 'received' when the exception happened BEFORE any Prime write (e.g. cost mismatch)", () => {
      const id = createInvoice("msg-retry-prewrite");
      setExtraction(id, { confidence: 0.9 });
      setException(id, "costMismatch");

      resetForRetry(id);

      const invoice = getInvoiceById(id)!;
      expect(invoice.stage).toBe("received");
      expect(invoice.exceptionReason).toBeNull();
    });

    it("resumes at 'approved_pending_sync' with a fresh attempt budget when the exception happened AFTER Prime writes (persistent Xero sync failure) — never re-runs the approve flow", () => {
      const id = createInvoice("msg-retry-postwrite");
      setExtraction(id, { totalAmountCents: 150_000, confidence: 0.9 });
      setResolvedMatch(id, { primeWorkOrderId: "wo_1", primeContactId: "contact_1" });
      setAttachmentUploaded(id, "att_1");
      setApInvoiceCreated(id, "ap_1");
      setApprovedPendingSync(id);
      // Simulate several failed sync-poll attempts before giving up.
      for (let i = 0; i < 10; i++) {
        getInvoiceById(id); // no-op reads just to mirror real usage shape
      }
      setException(id, "xeroSyncFailed");

      resetForRetry(id);

      const invoice = getInvoiceById(id)!;
      expect(invoice.stage).toBe("approved_pending_sync");
      expect(invoice.exceptionReason).toBeNull();
      expect(invoice.syncAttemptCount).toBe(0);
      // Prime IDs already acquired must be preserved — this is exactly what
      // prevents a duplicate AP invoice from being created in Prime.
      expect(invoice.primeApInvoiceId).toBe("ap_1");
      expect(invoice.primeAttachmentId).toBe("att_1");
    });

    it("full lifecycle: matched -> attachment_uploaded -> ap_created -> approved_pending_sync -> synced", () => {
      const id = createInvoice("msg-full-lifecycle");
      setExtraction(id, { totalAmountCents: 150_000, confidence: 0.9 });
      setResolvedMatch(id, { primeWorkOrderId: "wo_1", primeContactId: "contact_1" });
      expect(getInvoiceById(id)!.stage).toBe("matched");

      setAttachmentUploaded(id, "att_1");
      expect(getInvoiceById(id)!.stage).toBe("attachment_uploaded");

      setApInvoiceCreated(id, "ap_1");
      expect(getInvoiceById(id)!.stage).toBe("ap_created");

      setApprovedPendingSync(id);
      expect(getInvoiceById(id)!.stage).toBe("approved_pending_sync");

      setSynced(id, { financeSystemName: "Xero", financeSystemReference: "XERO-REF-1" });
      const final = getInvoiceById(id)!;
      expect(final.stage).toBe("synced");
      expect(final.isSynced).toBe(true);
      expect(final.syncedFinanceSystemReference).toBe("XERO-REF-1");
    });
  });

  it("getInvoiceByMessage returns undefined for a message that was never created", () => {
    expect(getInvoiceByMessage("msg-never-existed")).toBeUndefined();
  });
});
