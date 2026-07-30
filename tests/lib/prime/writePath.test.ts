import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The exact JSON Prime receives on the write calls. Dry-run short-circuits before
 * the body is ever built, so these assertions are the only thing standing between
 * a corrected payload and a rediscovered defect.
 *
 * A LESSON THIS FILE LEARNED THE HARD WAY. It used to assert FLAT bodies
 * (`{ fileName, ... }`), and it passed — while every real write returned 500.
 * Prime requires the fields nested under `attributes`; a test asserting our own
 * belief about an external contract proves only that we send what we decided to
 * send. The envelope assertions below are pinned against a verified live 200
 * (2026-07-30), not against a reading of the docs.
 */
const primeRequest = vi.fn();
vi.mock("../../../src/lib/prime/httpClient.js", async () => {
  // primeRequest is stubbed (it would hit production); primeWriteBody is the REAL
  // one. Stubbing it would make these assertions test the stub's idea of the
  // envelope rather than the code that ships — the same mistake as the flat-body
  // assertions this file used to carry.
  const actual = await vi.importActual<typeof import("../../../src/lib/prime/httpClient.js")>(
    "../../../src/lib/prime/httpClient.js",
  );
  return {
    primeWriteBody: actual.primeWriteBody,
    primeRequest: (...args: unknown[]) => primeRequest(...args),
  };
});

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

/** The whole request body, envelope included. */
function bodySent(): Record<string, unknown> {
  const [options] = primeRequest.mock.calls[0] as [{ body: Record<string, unknown> }];
  return options.body;
}

/** Just the payload Prime validates, i.e. what used to be sent at the top level. */
function attributesSent(): Record<string, unknown> {
  return bodySent().attributes as Record<string, unknown>;
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
    expect(attributesSent()).toEqual({
      fileName: "Dummy_Invoice_1_PO21266_CORRECT.pdf",
      attachmentTypeId: "type-subcontractor-invoices",
      attachmentStatus: "Published",
      objectType: "Job",
      objectId: "job-abc",
      file: pdf.toString("base64"),
    });
  });

  // The exact envelope, verified live: `{ attributes }` returns 200 and creates the
  // record. Both neighbours fail — flat fields 500 (the original defect), and the
  // FULL JSON:API envelope `{ data: { type, attributes } }` also 500s, which is the
  // counter-intuitive part worth pinning. Prime reads JSON:API on the way out but
  // wants bare attributes on the way in.
  it("wraps the payload in a bare `attributes` envelope, not `data.attributes`", async () => {
    await uploadAttachment({ pdf: Buffer.from("x"), filename: "a.pdf", jobId: "job-1" }, context);

    expect(Object.keys(bodySent())).toEqual(["attributes"]);
    expect(bodySent()).not.toHaveProperty("data");
    expect(bodySent()).not.toHaveProperty("fileName");
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
    expect(attributesSent()).toEqual({
      invoiceNumber: "TEST-INV-001",
      jobId: "job-abc",
      workOrderId: "wo-abc",
      attachmentId: "attachment-abc",
      amount: 478.5,
      invoicedDate: "2026-07-22",
      dueDate: "2026-08-21",
      accountsPayableInvoiceStatus: "New",
      approvalStatus: "Approved",
    });
    expect(attributesSent()).not.toHaveProperty("tax");
    expect(attributesSent()).not.toHaveProperty("taxTotal");
  });

  /**
   * THE FIELD WHOSE ABSENCE CRASHED PRIME. Two live runs failed every approvable
   * invoice on `POST /accounts-payable-invoices -> 500`, with the body
   * `{"message":"Attempt to read property \"name\" on null"}` — a null dereference
   * inside Prime's handler. The API docs name the missing field:
   *
   *   accountsPayableInvoiceStatusId  "required if attributes.accountsPayableInvoiceStatus is not presented"
   *   accountsPayableInvoiceStatus    "Accounts Payable Invoice Status Name -
   *                                    required if attributes.accountsPayableInvoiceStatusId is not presented"
   *
   * We sent neither half. The second is a status *Name*, which is exactly the
   * property the crash dereferenced.
   *
   * TWO LESSONS PINNED HERE. First, the live validator does NOT enforce this pair —
   * the empty-body 422 lists seven fields and no status — so the docs are stricter
   * than the validator, the reverse of the `workOrderId` case where the docs said
   * "optional" and production required it. Neither source is authoritative alone.
   * Second, an unenforced-but-required field fails as a 500 rather than a 422, i.e.
   * with no signal at all; that is the third time a Prime write has failed this way.
   */
  it("sends the required status name, whose absence Prime answers with a 500", async () => {
    await createApInvoice(input, context);

    expect(attributesSent()).toHaveProperty("accountsPayableInvoiceStatus", "New");
  });

  /**
   * `workOrder` is a real documented field — "Work Order Number - required if
   * attributes.workOrderId is not presented" — and it is one half of an either/or
   * pair with `workOrderId`. This code used to send BOTH, on a misreading of the
   * live 422: an empty body trips both halves of an either/or at once, and the two
   * errors arriving side by side were read as "Prime requires both".
   *
   * `workOrderId` alone satisfies the rule. It is also the correct half to send:
   * `workOrder` wants the work-order NUMBER (the PO label), whereas the removed line
   * was passing it a UUID — which the validator accepted only because it checks for
   * a string, not a valid reference. And 15/15 production records store
   * `workOrderId`; none store `workOrder`.
   */
  it("sends the id half of the workOrder either/or, not the number half", async () => {
    await createApInvoice(input, context);

    expect(attributesSent()).toHaveProperty("workOrderId", "wo-abc");
    expect(attributesSent()).not.toHaveProperty("workOrder");
  });

  it("wraps the payload in a bare `attributes` envelope, not `data.attributes`", async () => {
    await createApInvoice(input, context);

    expect(Object.keys(bodySent())).toEqual(["attributes"]);
    expect(bodySent()).not.toHaveProperty("data");
    expect(bodySent()).not.toHaveProperty("invoiceNumber");
  });

  it("converts cents to dollars without floating-point drift", async () => {
    await createApInvoice({ ...input, totalAmountCents: 8_712_00 }, context);
    expect(attributesSent().amount).toBe(8712);

    primeRequest.mockClear();
    await createApInvoice({ ...input, totalAmountCents: 1 }, context);
    expect(attributesSent().amount).toBe(0.01);
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

/**
 * There is no `approveApInvoice` any more, and this block guards its absence.
 *
 * It used to PATCH `/accounts-payable-invoices/{id}` with `{ approvalStatus:
 * "Approved" }`. The live run of 2026-07-30 — the first one to get past the create —
 * showed that endpoint answers **405 "Endpoint not currently available"**. Prime
 * creates an AP invoice already approved (`approvedAt == createdAt` on both records we
 * created and on all 15 production ones), so approval moved onto the create body and
 * `advanceApproveFlow` verifies it with a GET.
 *
 * The regression this pins: reviving a second write to "make approval explicit". The
 * create is where it is explicit; the only PATCH-able status route on this resource is
 * the lifecycle one, and pointing that at "Paid" asserts payment before payment.
 */
describe("the approve write that no longer exists", () => {
  it("exports no approveApInvoice, so nothing can call the 405 endpoint", async () => {
    const module = await import("../../../src/lib/prime/apInvoices.js");

    expect(module).not.toHaveProperty("approveApInvoice");
  });

  it("requests approval on the create instead, in the same single write", async () => {
    primeRequest.mockResolvedValue({ data: { id: "ap-created" } });

    await createApInvoice(
      {
        invoiceNumber: "TEST-INV-001",
        jobId: "job-abc",
        workOrderId: "wo-abc",
        attachmentId: "attachment-abc",
        totalAmountCents: 47_850,
        invoicedDate: "2026-07-22",
        dueDate: "2026-08-21",
      },
      context,
    );

    expect(primeRequest).toHaveBeenCalledTimes(1);
    expect(attributesSent()).toHaveProperty("approvalStatus", "Approved");
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
    primeRequest.mockResolvedValue({
      data: { id: "ap-1", attributes: { approvalStatus: "Approved" } },
    });

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
