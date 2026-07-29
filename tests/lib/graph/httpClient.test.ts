import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Graph's token fetch is the only thing graphRequest needs beyond fetch itself
// — stub it so these tests are pure URL-construction assertions.
vi.mock("../../../src/lib/graph/auth.js", () => ({
  getGraphAccessToken: () => Promise.resolve("fake-token"),
}));

const { graphRequest } = await import("../../../src/lib/graph/httpClient.js");

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve({ value: [] }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function requestedUrl(): string {
  return String(fetchMock.mock.calls[0][0]);
}

describe("graphRequest URL construction", () => {
  // Regression: `new URL(path, base)` treats a leading "/" as root-relative and
  // drops the base's "/v1.0" segment, so every call 404'd with Graph's
  // "Invalid version: users". This went unnoticed because the whole suite mocks
  // the Graph modules a level above this one.
  it("keeps the /v1.0 version segment for a root-relative path", async () => {
    await graphRequest({ method: "GET", path: "/users/invoices@example.com/messages" });

    expect(requestedUrl()).toBe(
      "https://graph.microsoft.com/v1.0/users/invoices@example.com/messages",
    );
  });

  it("appends query params after the version segment", async () => {
    await graphRequest({
      method: "GET",
      path: "/users/invoices@example.com/mailFolders/inbox/messages",
      query: { $select: "id,subject", $top: "100", $filter: undefined },
    });

    const url = new URL(requestedUrl());
    expect(url.pathname).toBe("/v1.0/users/invoices@example.com/mailFolders/inbox/messages");
    expect(url.searchParams.get("$select")).toBe("id,subject");
    expect(url.searchParams.get("$top")).toBe("100");
    // undefined values are omitted rather than serialized as "undefined"
    expect(url.searchParams.has("$filter")).toBe(false);
  });

  // mailbox.ts's listAllMessages feeds @odata.nextLink back in as `path`. It is
  // already absolute and fully encoded, so it must bypass the base URL entirely
  // — prefixing it would produce https://graph.microsoft.com/v1.0https://...
  it("passes an absolute @odata.nextLink through unchanged", async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/users/invoices@example.com/mailFolders/inbox/messages?$skiptoken=ABC123";

    await graphRequest({ method: "GET", path: nextLink });

    expect(requestedUrl()).toBe(nextLink);
  });
});
