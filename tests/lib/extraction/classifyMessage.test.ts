import { describe, it, expect, beforeEach, vi } from "vitest";

const chatCompletion = vi.fn();
vi.mock("../../../src/lib/extraction/client.js", () => ({
  chatCompletion: (...args: unknown[]) => chatCompletion(...args),
}));

vi.mock("../../../src/db/repositories/auditLog.js", () => ({
  appendAuditLog: (...args: unknown[]) => appendAuditLog(...args),
}));

const appendAuditLog = vi.fn();

const { classifyMessage } = await import("../../../src/lib/extraction/classifyMessage.js");

const context = { messageId: "msg-1" };

function userMessageSent(): string {
  const [messages] = chatCompletion.mock.calls[0] as [{ role: string; content: string }[]];
  return messages.find((m) => m.role === "user")!.content;
}

describe("classifyMessage", () => {
  beforeEach(() => {
    chatCompletion.mockReset();
    appendAuditLog.mockReset();
    chatCompletion.mockResolvedValue('{"category":"invoice","confidence":0.9}');
  });

  // The live run that failed sent nothing but a bare "PO21266" subject and a
  // sender, and the model answered "other" at 0.95 for all three test invoices —
  // silently dropping them. The evidence below was already in hand at the call
  // site; it just wasn't being passed.
  it("gives the model the attachment filenames and body preview, not just the subject", async () => {
    await classifyMessage(
      {
        subject: "PO21266",
        senderEmail: "supplier@example.com",
        bodyPreview: "Please find attached our invoice for stage 1.",
        attachmentFilenames: ["Dummy_Invoice_1_PO21266_CORRECT.pdf"],
      },
      context,
    );

    const sent = userMessageSent();
    expect(sent).toContain("Subject: PO21266");
    expect(sent).toContain("From: supplier@example.com");
    expect(sent).toContain("Dummy_Invoice_1_PO21266_CORRECT.pdf");
    expect(sent).toContain("Please find attached our invoice for stage 1.");
  });

  it("omits the optional lines rather than sending empty or undefined ones", async () => {
    await classifyMessage({ subject: "PO21266" }, context);

    const sent = userMessageSent();
    expect(sent).toContain("From: unknown");
    expect(sent).not.toContain("PDF attachments:");
    expect(sent).not.toContain("Preview:");
    expect(sent).not.toContain("undefined");
  });

  it("lists every attachment when an email carries more than one", async () => {
    await classifyMessage(
      { subject: "Invoices", attachmentFilenames: ["a.pdf", "b.pdf"] },
      context,
    );

    expect(userMessageSent()).toContain("PDF attachments: a.pdf, b.pdf");
  });

  it("returns the parsed verdict and audits it", async () => {
    const result = await classifyMessage({ subject: "PO21266" }, context);

    expect(result).toEqual({ category: "invoice", confidence: 0.9 });
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "openrouter.classify",
        isError: false,
      }),
    );
  });

  // Unparseable output must not read as a confident "not an invoice" —
  // processMessage treats undefined and "other" the same way, so the audit row
  // is the only place the difference survives.
  it("returns undefined and flags the audit row when the model's output is unusable", async () => {
    chatCompletion.mockResolvedValue("I'm afraid I can't do that.");

    const result = await classifyMessage({ subject: "PO21266" }, context);

    expect(result).toBeUndefined();
    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ isError: true }));
  });
});
