import { describe, it, expect, beforeEach, vi } from "vitest";

const graphRequest = vi.fn();
vi.mock("../../../src/lib/graph/httpClient.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/graph/httpClient.js")>(
    "../../../src/lib/graph/httpClient.js",
  );
  return {
    GraphApiError: actual.GraphApiError,
    graphRequest: (...args: unknown[]) => graphRequest(...args),
  };
});

vi.mock("../../../src/config/env.js", () => ({
  loadEnv: () => ({ GRAPH_MAILBOX_ADDRESS: "invoices@example.com" }),
}));

vi.mock("../../../src/db/repositories/auditLog.js", () => ({
  appendAuditLog: () => 1,
}));

const { GraphApiError } = await import("../../../src/lib/graph/httpClient.js");
const { getOrCreateFolderId } = await import("../../../src/lib/graph/folders.js");

interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: { displayName: string };
}

// The folder-id cache lives for the process, so every test uses distinct names.
let uniqueSuffix = 0;
function freshPath(path: string): string {
  uniqueSuffix += 1;
  return path.replace(/#/g, String(uniqueSuffix));
}

function isCreate(options: RequestOptions): boolean {
  return options.method === "POST";
}

/** Names that exist in the fake mailbox; a create adds to it. */
let existing: Set<string>;

function createdNames(): string[] {
  return graphRequest.mock.calls
    .map(([options]) => options as RequestOptions)
    .filter(isCreate)
    .map((options) => options.body!.displayName);
}

beforeEach(() => {
  graphRequest.mockReset();
  existing = new Set<string>();
  graphRequest.mockImplementation((options: RequestOptions) => {
    if (isCreate(options)) {
      const name = options.body!.displayName;
      if (existing.has(name)) {
        return Promise.reject(
          new GraphApiError("Graph API request failed: POST /mailFolders -> 409", 409, {
            error: { code: "ErrorFolderExists" },
          }),
        );
      }
      existing.add(name);
      return Promise.resolve({ id: `id-${name}`, displayName: name });
    }
    const filter = options.query?.$filter ?? "";
    const name = /displayName eq '(.*)'/.exec(filter)?.[1]?.replace(/''/g, "'");
    return Promise.resolve({
      value: name && existing.has(name) ? [{ id: `id-${name}`, displayName: name }] : [],
    });
  });
});

describe("getOrCreateFolderId", () => {
  it("creates each missing segment of a nested path", async () => {
    const id = await getOrCreateFolderId(freshPath("Exceptions#/Cost mismatch#"));

    expect(id).toBe("id-Cost mismatch1");
    expect(createdNames()).toEqual(["Exceptions1", "Cost mismatch1"]);
  });

  // The live failure: two invoices routing to different Exceptions/* subfolders
  // both created the "Exceptions" parent at the same instant. The loser's 409
  // stranded its invoice at a terminal stage with the email still in the Inbox.
  it("shares one parent resolution between concurrent callers", async () => {
    const path = freshPath("Exceptions#");

    const [a, b, c] = await Promise.all([
      getOrCreateFolderId(`${path}/Cost mismatch`),
      getOrCreateFolderId(`${path}/No work order`),
      getOrCreateFolderId(`${path}/Unreadable`),
    ]);

    expect(a).toBe("id-Cost mismatch");
    expect(b).toBe("id-No work order");
    expect(c).toBe("id-Unreadable");
    // The parent is created exactly once despite three simultaneous callers.
    expect(createdNames().filter((name) => name === path)).toHaveLength(1);
  });

  it("treats a 409 on create as success and resolves by lookup", async () => {
    const name = freshPath("Exceptions#");
    // Someone else created it after our lookup came back empty: the create is
    // rejected, but the folder is there to be found.
    graphRequest.mockImplementationOnce(() => Promise.resolve({ value: [] }));
    graphRequest.mockImplementationOnce(() => {
      existing.add(name);
      return Promise.reject(new GraphApiError("... -> 409", 409, undefined));
    });

    await expect(getOrCreateFolderId(name)).resolves.toBe(`id-${name}`);
  });

  it("rethrows a 409 that no subsequent lookup can explain", async () => {
    graphRequest.mockImplementationOnce(() => Promise.resolve({ value: [] }));
    graphRequest.mockImplementationOnce(() =>
      Promise.reject(new GraphApiError("... -> 409", 409, undefined)),
    );
    graphRequest.mockImplementationOnce(() => Promise.resolve({ value: [] }));

    await expect(getOrCreateFolderId(freshPath("Phantom#"))).rejects.toThrow(/409/);
  });

  it("rethrows non-409 failures rather than swallowing them", async () => {
    graphRequest.mockImplementationOnce(() => Promise.resolve({ value: [] }));
    graphRequest.mockImplementationOnce(() =>
      Promise.reject(new GraphApiError("... -> 403", 403, undefined)),
    );

    await expect(getOrCreateFolderId(freshPath("Forbidden#"))).rejects.toThrow(/403/);
  });

  // A poisoned in-flight entry would make every later call for that path fail
  // for the life of the process, long after the transient cause had cleared.
  it("does not cache a failed resolution", async () => {
    const name = freshPath("Transient#");
    graphRequest.mockImplementationOnce(() => Promise.resolve({ value: [] }));
    graphRequest.mockImplementationOnce(() =>
      Promise.reject(new GraphApiError("... -> 500", 500, undefined)),
    );

    await expect(getOrCreateFolderId(name)).rejects.toThrow(/500/);
    await expect(getOrCreateFolderId(name)).resolves.toBe(`id-${name}`);
  });

  it("serves a resolved path from cache without asking Graph again", async () => {
    const name = freshPath("Processed#");

    await getOrCreateFolderId(name);
    const callsAfterFirst = graphRequest.mock.calls.length;
    await getOrCreateFolderId(name);

    expect(graphRequest.mock.calls).toHaveLength(callsAfterFirst);
  });
});
