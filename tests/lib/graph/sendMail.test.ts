import { describe, it, expect, beforeEach, vi } from "vitest";

const graphRequest = vi.fn();
vi.mock("../../../src/lib/graph/httpClient.js", () => ({
  graphRequest: (...args: unknown[]) => graphRequest(...args),
}));

interface FakeEnv {
  GRAPH_MAILBOX_ADDRESS: string;
  GRAPH_SEND_MAIL_ENABLED: boolean;
  GRAPH_SEND_MAIL_REDIRECT_TO_TEST: boolean;
  GRAPH_TEST_RECIPIENT?: string;
  LOG_LEVEL: string;
}

let env: FakeEnv;
vi.mock("../../../src/config/env.js", () => ({
  loadEnv: () => env,
}));

const appendAuditLog = vi.fn();
vi.mock("../../../src/db/repositories/auditLog.js", () => ({
  appendAuditLog: (...args: unknown[]) => appendAuditLog(...args),
}));

const { sendMissingDataReply } = await import("../../../src/lib/graph/sendMail.js");

const REPLY = {
  toEmail: "accounts@hutchyceilings.com.au",
  subject: "RE: PO21343 — additional information needed",
  bodyText: "Hi,\n\nWe received your invoice but...",
};

interface SentMail {
  body: {
    message: {
      subject: string;
      body: { content: string };
      toRecipients: Array<{ emailAddress: { address: string } }>;
    };
  };
}

function sentMail(): SentMail["body"]["message"] {
  const call = graphRequest.mock.calls[0]?.[0] as SentMail | undefined;
  if (!call) {
    throw new Error("expected graphRequest to have been called");
  }
  return call.body.message;
}

function auditDetail(): Record<string, unknown> {
  const row = appendAuditLog.mock.calls.at(-1)?.[0] as
    { eventType: string; detail: Record<string, unknown> } | undefined;
  if (!row) {
    throw new Error("expected an audit row");
  }
  return row.detail;
}

beforeEach(() => {
  graphRequest.mockReset();
  graphRequest.mockResolvedValue(undefined);
  appendAuditLog.mockReset();
  env = {
    GRAPH_MAILBOX_ADDRESS: "invoices@example.com",
    GRAPH_SEND_MAIL_ENABLED: true,
    GRAPH_SEND_MAIL_REDIRECT_TO_TEST: true,
    GRAPH_TEST_RECIPIENT: "accounts.test@builderwest.com.au",
    LOG_LEVEL: "error",
  };
});

describe("sendMissingDataReply", () => {
  it("sends nothing at all when outbound mail is disabled", async () => {
    env.GRAPH_SEND_MAIL_ENABLED = false;

    await sendMissingDataReply(REPLY, {});

    expect(graphRequest).not.toHaveBeenCalled();
    // Still audited: "we chose not to email this supplier" is itself a fact the
    // trail has to carry, or a missing reply looks like a bug later.
    const row = appendAuditLog.mock.calls[0]?.[0] as { eventType: string };
    expect(row.eventType).toBe("graph.send_mail.skipped_disabled");
  });

  describe("with the redirect on (the pilot default)", () => {
    it("sends to the test recipient, NEVER to the supplier", async () => {
      await sendMissingDataReply(REPLY, {});

      const message = sentMail();
      expect(message.toRecipients).toEqual([
        { emailAddress: { address: "accounts.test@builderwest.com.au" } },
      ]);
      // The whole point of the fence. Asserted on the serialized payload rather
      // than the recipient field alone, so a supplier address leaking into the
      // body or a cc would fail too.
      expect(JSON.stringify(message.toRecipients)).not.toContain("hutchyceilings");
    });

    it("marks the subject so a test inbox cannot mistake it for a live reply", async () => {
      await sendMissingDataReply(REPLY, {});

      expect(sentMail().subject).toBe(
        "[TEST — not sent to supplier] RE: PO21343 — additional information needed",
      );
    });

    it("states the intended recipient in the body, and keeps the original text", async () => {
      await sendMissingDataReply(REPLY, {});

      const content = sentMail().body.content;
      expect(content).toContain("would have been sent to accounts@hutchyceilings.com.au");
      expect(content).toContain("We received your invoice but...");
    });

    it("records both addresses in the audit row", async () => {
      await sendMissingDataReply(REPLY, {});

      expect(auditDetail()).toMatchObject({
        toEmail: "accounts.test@builderwest.com.au",
        intendedRecipient: "accounts@hutchyceilings.com.au",
        redirected: true,
      });
    });

    it("still redirects when the caller happens to pass the test recipient itself", async () => {
      await sendMissingDataReply({ ...REPLY, toEmail: env.GRAPH_TEST_RECIPIENT! }, {});

      expect(sentMail().toRecipients[0]?.emailAddress.address).toBe(
        "accounts.test@builderwest.com.au",
      );
    });

    it("fails CLOSED if GRAPH_TEST_RECIPIENT is somehow unset — sends nothing", async () => {
      // loadEnv refuses this combination at startup, so it should be unreachable.
      // Belt and braces: a redirect that cannot resolve an address must drop the
      // reply, never fall through to the supplier it exists to protect.
      delete env.GRAPH_TEST_RECIPIENT;

      await sendMissingDataReply(REPLY, {});

      expect(graphRequest).not.toHaveBeenCalled();
      const row = appendAuditLog.mock.calls[0]?.[0] as { eventType: string; isError: boolean };
      expect(row.eventType).toBe("graph.send_mail.skipped_no_test_recipient");
      expect(row.isError).toBe(true);
    });
  });

  describe("with the redirect off (the go-live setting)", () => {
    beforeEach(() => {
      env.GRAPH_SEND_MAIL_REDIRECT_TO_TEST = false;
    });

    it("replies to the real sender, with the subject and body untouched", async () => {
      await sendMissingDataReply(REPLY, {});

      const message = sentMail();
      expect(message.toRecipients).toEqual([
        { emailAddress: { address: "accounts@hutchyceilings.com.au" } },
      ]);
      expect(message.subject).toBe(REPLY.subject);
      expect(message.body.content).toBe(REPLY.bodyText);
    });

    it("audits redirected:false so the trail distinguishes the two modes", async () => {
      await sendMissingDataReply(REPLY, {});

      expect(auditDetail()).toMatchObject({
        toEmail: "accounts@hutchyceilings.com.au",
        intendedRecipient: "accounts@hutchyceilings.com.au",
        redirected: false,
      });
    });
  });
});
