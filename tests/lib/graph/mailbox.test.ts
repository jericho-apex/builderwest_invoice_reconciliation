import { describe, it, expect, beforeEach, vi } from "vitest";

const graphRequest = vi.fn();
vi.mock("../../../src/lib/graph/httpClient.js", () => ({
  graphRequest: (...args: unknown[]) => graphRequest(...args),
}));

vi.mock("../../../src/lib/graph/folders.js", () => ({
  getOrCreateFolderId: () => Promise.resolve("retry-folder-id"),
}));

vi.mock("../../../src/db/repositories/processedMessages.js", () => ({
  getLatestProcessedTimestamp: () => checkpoint,
}));

vi.mock("../../../src/config/env.js", () => ({
  loadEnv: () => ({ GRAPH_MAILBOX_ADDRESS: "invoices@example.com" }),
}));

let checkpoint: string | undefined;

const { pollForNewMessages } = await import("../../../src/lib/graph/mailbox.js");

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    receivedDateTime: "2026-07-28T04:41:42Z",
    subject: "PO21266",
    hasAttachments: true,
    ...overrides,
  };
}

/** The request made against a given folder path fragment. */
function callFor(pathFragment: string) {
  const call = graphRequest.mock.calls.find(([options]) =>
    String((options as { path: string }).path).includes(pathFragment),
  );
  return call?.[0] as { path: string; query?: Record<string, string | undefined> } | undefined;
}

describe("pollForNewMessages", () => {
  beforeEach(() => {
    graphRequest.mockReset();
    graphRequest.mockResolvedValue({ value: [] });
    checkpoint = undefined;
  });

  it("checkpoint-filters the Inbox, constraining the property it orders by", async () => {
    checkpoint = "2026-07-28T06:00:00.000Z";

    await pollForNewMessages();

    const inbox = callFor("mailFolders/inbox/messages");
    // Graph requires the ordered property to be constrained in the filter when
    // the two are combined; receivedDateTime appears in both here.
    expect(inbox?.query?.$orderby).toBe("receivedDateTime asc");
    expect(inbox?.query?.$filter).toMatch(/^receivedDateTime gt .* and hasAttachments eq true$/);
    // 15-minute safety buffer subtracted from the checkpoint.
    expect(inbox?.query?.$filter).toContain("2026-07-28T05:45:00.000Z");
  });

  it("looks back 24h on the very first run rather than scanning all history", async () => {
    await pollForNewMessages();

    const inbox = callFor("mailFolders/inbox/messages");
    expect(inbox?.query?.$filter).toMatch(/^receivedDateTime gt /);
  });

  // Regression: `$filter=hasAttachments eq true` with `$orderby=receivedDateTime`
  // is rejected 400 InefficientFilter — the Retry folder has no checkpoint clause
  // to constrain the ordered property with, so it must send no filter at all.
  // This crashed the first live tick before a single message was processed.
  it("sends NO filter when listing the Retry folder", async () => {
    await pollForNewMessages();

    const retry = callFor("mailFolders/retry-folder-id/messages");
    expect(retry).toBeDefined();
    expect(retry?.query?.$filter).toBeUndefined();
    expect(retry?.query?.$orderby).toBe("receivedDateTime asc");
  });

  it("still screens Retry messages for attachments, in code", async () => {
    graphRequest.mockImplementation((options: { path: string }) =>
      Promise.resolve({
        value: options.path.includes("retry-folder-id")
          ? [
              message({ id: "retry-with-pdf", hasAttachments: true }),
              message({ id: "retry-no-pdf", hasAttachments: false }),
            ]
          : [],
      }),
    );

    const { retryMessages } = await pollForNewMessages();

    expect(retryMessages.map((m) => m.id)).toEqual(["retry-with-pdf"]);
  });

  it("keeps Inbox and Retry results separate — they get different handling upstream", async () => {
    graphRequest.mockImplementation((options: { path: string }) =>
      Promise.resolve({
        value: options.path.includes("retry-folder-id")
          ? [message({ id: "from-retry" })]
          : [message({ id: "from-inbox" })],
      }),
    );

    const result = await pollForNewMessages();

    expect(result.inboxMessages.map((m) => m.id)).toEqual(["from-inbox"]);
    expect(result.retryMessages.map((m) => m.id)).toEqual(["from-retry"]);
  });

  it("follows @odata.nextLink through to the last page", async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/users/invoices@example.com/mailFolders/inbox/messages?$skiptoken=ABC";
    graphRequest.mockImplementation((options: { path: string }) => {
      if (options.path.includes("retry-folder-id")) {
        return Promise.resolve({ value: [] });
      }
      if (options.path === nextLink) {
        return Promise.resolve({ value: [message({ id: "page-2" })] });
      }
      return Promise.resolve({
        value: [message({ id: "page-1" })],
        "@odata.nextLink": nextLink,
      });
    });

    const { inboxMessages } = await pollForNewMessages();

    expect(inboxMessages.map((m) => m.id)).toEqual(["page-1", "page-2"]);
    // The nextLink is already absolute and fully encoded — passed through as the
    // path with no further query params bolted on.
    const followUp = graphRequest.mock.calls.find(([o]) => (o as { path: string }).path === nextLink);
    expect((followUp?.[0] as { query?: unknown }).query).toBeUndefined();
  });
});
