import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The exact JSON Prime receives on the two write calls. Both shapes were wrong
 * in ways no dry-run could reveal — dry-run short-circuits before the body is
 * ever built, so these assertions are the only thing standing between a
 * corrected payload and a rediscovered defect.
 */
const primeRequest = vi.fn();
vi.mock("../../../src/lib/prime/httpClient.js", () => ({
  primeRequest: (...args: unknown[]) => primeRequest(...args),
}));

vi.mock("../../../src/db/repositories/auditLog.js", () => ({
  appendAuditLog: (...args: unknown[]) => appendAuditLog(...args),
}));
const appendAuditLog = vi.fn();

let dryRun = false;
vi.mock("../../../src/config/env.js", () => ({
  loadEnv: () => ({
    PRIME_DRY_RUN: dryRun,
    PRIME_ATTACHMENT_TYPE_ID: "type-subcontractor-invoices",
  }),
}));

const { uploadAttachment } = await import("../../../src/lib/prime/attachments.js");
const { createApInvoice, readBackApInvoice } = await import(
  "../../../src/lib/prime/apInvoices.js"
);

const context = { invoiceId: 1, messageId: "msg-1" };

function bodySent(): Record<string, unknown> {
  const [options] = primeRequest.mock.calls[0] as [{ body: Record<string, unknown> }];
  return options.body;
}

beforeEach(() => {
  primeRequest.mockReset();
  appendAuditLog.mockReset();
  dryRun = false;
});

describe("uploadAttachment", () => {
  beforeEach(() => {
    primeRequest.mockResolvedValue({ data: { id: "attachment-created" } });
  });

  // Was multipart/form-data with a Blob. Prime takes JSON with base64 content
  // and four other required fields, none of which were being sent.
  it("posts JSON with base64 content and every required field", async () => {
    const pdf = Buffer.from("%PDF-1.4 fake");

    const id = await uploadAttachment(
      { pdf, filename: "Dummy_Invoice_1_PO21266_CORRECT.pdf", jobId: "job-abc" },
      context,
    );

    expect(id).toBe("attachment-created");
    expect(primeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ method: "POST", path: "/attachments" }),
    );
    expect(bodySent()).toEqual({
      fileName: "Dummy_Invoice_1_PO21266_CORRECT.pdf",
      attachmentTypeId: "type-subcontractor-invoices",
      attachmentStatus: "Published",
      objectType: "Job",
      objectId: "job-abc",
      file: pdf.toString("base64"),
    });
  });

  // The response id is at data.id. Reading a top-level `attachmentId` meant even
  // a successful upload returned undefined, and the AP invoice then referenced
  // nothing at all.
  it("reads the created id from the JSON:API envelope", async () => {
    primeRequest.mockResolvedValue({ data: { id: "the-real-id" }, attachmentId: "wrong" });

    await expect(
      uploadAttachment({ pdf: Buffer.from("x"), filename: "a.pdf", jobId: "job-1" }, context),
    ).resolves.toBe("the-real-id");
  });

  // That base64 blob is the entire invoice. It must not land in the log a human
  // reads, nor in an append-only audit table.
  it("never logs or audits the file content", async () => {
    await uploadAttachment(
      { pdf: Buffer.from("SENSITIVE-INVOICE-BYTES"), filename: "a.pdf", jobId: "job-1" },
      context,
    );

    const audited = JSON.stringify(appendAuditLog.mock.calls);
    expect(audited).not.toContain("SENSITIVE-INVOICE-BYTES");
    expect(audited).not.toContain(Buffer.from("SENSITIVE-INVOICE-BYTES").toString("base64"));
    expect(audited).toContain("fileBytes");
  });

  it("calls Prime not at all under dry-run, returning a marked fake id", async () => {
    dryRun = true;

    const id = await uploadAttachment(
      { pdf: Buffer.from("x"), filename: "a.pdf", jobId: "job-1" },
      context,
    );

    expect(id).toMatch(/^dryrun-attachment-/);
    expect(primeRequest).not.toHaveBeenCalled();
  });
});

describe("createApInvoice", () => {
  const input = {
    invoiceNumber: "TEST-INV-001",
    jobId: "job-abc",
    workOrderId: "wo-abc",
    attachmentId: "attachment-abc",
    totalAmountCents: 47_850,
    invoicedDate: "2026-07-22",
    dueDate: "2026-08-21",
  };

  beforeEach(() => {
    primeRequest.mockResolvedValue({ data: { id: "ap-created" } });
  });

  // The old body sent {workOrderId, attachmentId, amount: exTax, tax, taxTotal}:
  // it omitted three fields Prime requires, and passed the EX-GST figure as
  // `amount`, which Prime treats as the inc-GST total — every AP invoice would
  // have been created ~9% short.
  it("sends the inc-GST total as amount, with all required fields and no invented tax", async () => {
    const id = await createApInvoice(input, context);

    expect(id).toBe("ap-created");
    expect(bodySent()).toEqual({
      invoiceNumber: "TEST-INV-001",
      jobId: "job-abc",
      workOrderId: "wo-abc",
      attachmentId: "attachment-abc",
      amount: 478.5,
      invoicedDate: "2026-07-22",
      dueDate: "2026-08-21",
    });
    expect(bodySent()).not.toHaveProperty("tax");
    expect(bodySent()).not.toHaveProperty("taxTotal");
  });

  it("converts cents to dollars without floating-point drift", async () => {
    await createApInvoice({ ...input, totalAmountCents: 8_712_00 }, context);
    expect(bodySent().amount).toBe(8712);

    primeRequest.mockClear();
    await createApInvoice({ ...input, totalAmountCents: 1 }, context);
    expect(bodySent().amount).toBe(0.01);
  });

  it("reads the created id from the JSON:API envelope", async () => {
    primeRequest.mockResolvedValue({ data: { id: "the-real-id" }, id: "wrong" });

    await expect(createApInvoice(input, context)).resolves.toBe("the-real-id");
  });

  it("calls Prime not at all under dry-run, returning a marked fake id", async () => {
    dryRun = true;

    const id = await createApInvoice(input, context);

    expect(id).toMatch(/^dryrun-ap-invoice-/);
    expect(primeRequest).not.toHaveBeenCalled();
  });

  // A dry run is only worth reviewing if it shows the payload that would really
  // be sent — the previous version logged its input arguments, not the body.
  it("logs the exact body it would have sent under dry-run", async () => {
    dryRun = true;

    await createApInvoice(input, context);

    const [audit] = appendAuditLog.mock.calls[0] as [{ detail: { body: Record<string, unknown> } }];
    expect(audit.detail.body).toMatchObject({ amount: 478.5, jobId: "job-abc" });
  });
});

describe("readBackApInvoice", () => {
  function auditDetail(): Record<string, unknown> {
    const [audit] = appendAuditLog.mock.calls[0] as [{ detail: Record<string, unknown> }];
    return audit.detail;
  }

  // The shape that matters: Prime v2 is JSON:API and every other resource in this
  // client reads its fields from data.attributes. Reading only the top level saw
  // `undefined` for everything — which would report a correctly-created AP invoice
  // as carrying no work-order link at all, i.e. exactly the wrong answer to the one
  // question this read-back exists to settle.
  it("reads the record out of the JSON:API attributes envelope", async () => {
    primeRequest.mockResolvedValue({
      data: {
        id: "ap-1",
        attributes: {
          approvalStatus: "Approved",
          accountsPayableInvoiceStatus: "New",
          workOrderId: "wo-abc",
          jobId: "job-abc",
          isSynced: false,
        },
      },
    });

    await expect(readBackApInvoice("ap-1", context)).resolves.toEqual({
      approvalStatus: "Approved",
      accountsPayableInvoiceStatus: "New",
      workOrderId: "wo-abc",
      jobId: "job-abc",
      isSynced: false,
      syncedFinanceSystemName: undefined,
      syncedFinanceSystemReference: undefined,
    });
  });

  it("still reads a flat response, so either shape works", async () => {
    primeRequest.mockResolvedValue({ approvalStatus: "Approved", workOrderId: "wo-abc" });

    await expect(readBackApInvoice("ap-1", context)).resolves.toMatchObject({
      approvalStatus: "Approved",
      workOrderId: "wo-abc",
    });
  });

  it("reads fields sitting directly on data, without attributes", async () => {
    primeRequest.mockResolvedValue({ data: { id: "ap-1", workOrderId: "wo-abc" } });

    await expect(readBackApInvoice("ap-1", context)).resolves.toMatchObject({
      workOrderId: "wo-abc",
    });
  });

  // The work-order link is the whole point of the project, so a record that came
  // back without one is flagged as an error even though the invoice is already
  // approved by this point and nothing is retried.
  it("flags a missing work-order link as an error in the audit trail", async () => {
    primeRequest.mockResolvedValue({ data: { id: "ap-1", attributes: { approvalStatus: "Approved" } } });

    await readBackApInvoice("ap-1", context);

    const [audit] = appendAuditLog.mock.calls[0] as [{ eventType: string; isError: boolean }];
    expect(audit.eventType).toBe("prime.read_back_ap_invoice");
    expect(audit.isError).toBe(true);
  });

  it("does not flag a record that came back with its work-order link", async () => {
    primeRequest.mockResolvedValue({ data: { id: "ap-1", attributes: { workOrderId: "wo-abc" } } });

    await readBackApInvoice("ap-1", context);

    const [audit] = appendAuditLog.mock.calls[0] as [{ isError: boolean }];
    expect(audit.isError).toBe(false);
  });

  // Never "probably synced". The pipeline does not act on this either way — it
  // stops at approved — but the audit trail should not claim a sync that Prime did
  // not report.
  it("treats a missing or non-boolean isSynced as not synced", async () => {
    for (const response of [{}, { data: { id: "ap-1" } }, { isSynced: "true" }, { isSynced: 1 }]) {
      primeRequest.mockResolvedValue(response);

      await expect(readBackApInvoice("ap-1", context)).resolves.toMatchObject({
        isSynced: false,
      });
    }
  });

  // Both status fields are recorded because they are the evidence for the Xero-push
  // question (prime-api-gaps.md Q6) if it is ever revisited.
  it("audits the whole record, including both of Prime's status fields", async () => {
    primeRequest.mockResolvedValue({
      data: {
        id: "ap-1",
        attributes: {
          isSynced: false,
          approvalStatus: "Approved",
          accountsPayableInvoiceStatus: "New",
          workOrderId: "wo-abc",
        },
      },
    });

    await readBackApInvoice("ap-1", context);

    expect(auditDetail()).toMatchObject({
      apInvoiceId: "ap-1",
      record: {
        approvalStatus: "Approved",
        accountsPayableInvoiceStatus: "New",
        workOrderId: "wo-abc",
        isSynced: false,
      },
    });
  });

  // Reports NOT-synced under dry-run, deliberately: a fabricated `isSynced: true`
  // was only ever needed to get the old sync poll to terminate, and now it would
  // just put a claim in the audit trail that no Prime record supports.
  it("fabricates an unsynced record for a dry-run id without calling Prime", async () => {
    await expect(readBackApInvoice("dryrun-ap-invoice-abc", context)).resolves.toMatchObject({
      approvalStatus: "Approved",
      isSynced: false,
    });
    expect(primeRequest).not.toHaveBeenCalled();
  });
});
