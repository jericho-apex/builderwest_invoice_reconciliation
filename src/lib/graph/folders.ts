import { loadEnv } from "../../config/env.js";
import { logger } from "../../log/logger.js";
import { graphRequest, GraphApiError } from "./httpClient.js";
import { appendAuditLog, type AuditLogInput } from "../../db/repositories/auditLog.js";

type AuditContext = Pick<AuditLogInput, "invoiceId" | "messageId">;

interface GraphFolder {
  id: string;
  displayName: string;
}

interface GraphListResponse<T> {
  value: T[];
}

function escapeODataStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function folderCollectionPath(mailbox: string, parentId: string | undefined): string {
  return parentId
    ? `/users/${mailbox}/mailFolders/${parentId}/childFolders`
    : `/users/${mailbox}/mailFolders`;
}

async function findFolderByName(name: string, parentId: string | undefined): Promise<string | undefined> {
  const env = loadEnv();
  const response = await graphRequest<GraphListResponse<GraphFolder>>({
    method: "GET",
    path: folderCollectionPath(env.GRAPH_MAILBOX_ADDRESS, parentId),
    query: { $filter: `displayName eq '${escapeODataStringLiteral(name)}'` },
  });
  return response.value[0]?.id;
}

async function createFolder(name: string, parentId: string | undefined): Promise<string> {
  const env = loadEnv();
  const response = await graphRequest<GraphFolder>({
    method: "POST",
    path: folderCollectionPath(env.GRAPH_MAILBOX_ADDRESS, parentId),
    body: { displayName: name },
  });
  return response.id;
}

// Cache resolved folder IDs (keyed by full path, e.g. "Exceptions/No work
// order") for the life of the process — avoids repeated lookups on every
// move, per the plan's risk note about wasted Graph calls on by-name
// resolution.
const folderIdCache = new Map<string, string>();

// In-flight resolutions, keyed the same way. The cache above only helps once a
// path has FINISHED resolving; invoices are driven concurrently
// (PRIME_RATE_LIMITS.maxConcurrent), so several can be midway through resolving
// the same path with nothing resolved to cache yet. Sharing the promise means
// one lookup-and-create per path per process, no matter how many callers ask at
// once.
const inFlightResolutions = new Map<string, Promise<string>>();

/** Resolves one path segment under a known parent, creating it if absent. */
async function resolveSegment(name: string, parentId: string | undefined): Promise<string> {
  const existing = await findFolderByName(name, parentId);
  if (existing) {
    return existing;
  }

  try {
    const created = await createFolder(name, parentId);
    logger.info("created Outlook folder", { displayName: name });
    return created;
  } catch (error) {
    // 409 means the folder appeared between our lookup and our create — either
    // another process, or Graph's own list indexing lagging its writes. It is
    // success reported as a conflict, so look the folder up again and use it.
    //
    // This crashed a live tick: two invoices routing to different
    // Exceptions/* subfolders both created the "Exceptions" parent at once, one
    // won, and the loser's 409 stranded its invoice at a terminal stage with the
    // email still in the Inbox.
    if (error instanceof GraphApiError && error.status === 409) {
      const raced = await findFolderByName(name, parentId);
      if (raced) {
        logger.info("Outlook folder already existed (409, resolved by lookup)", {
          displayName: name,
        });
        return raced;
      }
    }
    throw error;
  }
}

/**
 * Resolves a (possibly nested) Outlook folder path to its Graph folder ID,
 * creating any missing segments along the way — idempotent, per PRD §4.5
 * ("the app creates these subfolders via Graph if they do not exist").
 *
 * Recursive rather than iterative so each ANCESTOR path goes through this same
 * function, and therefore through the same cache and in-flight dedupe: two
 * callers racing for "Exceptions/Cost mismatch" and "Exceptions/No work order"
 * share one resolution of "Exceptions" between them.
 */
export async function getOrCreateFolderId(folderPath: string): Promise<string> {
  const cached = folderIdCache.get(folderPath);
  if (cached) {
    return cached;
  }

  const alreadyResolving = inFlightResolutions.get(folderPath);
  if (alreadyResolving) {
    return alreadyResolving;
  }

  const segments = folderPath.split("/");
  const leaf = segments[segments.length - 1]!;
  const parentPath = segments.slice(0, -1).join("/");

  const resolution = (async () => {
    const parentId = parentPath ? await getOrCreateFolderId(parentPath) : undefined;
    const folderId = await resolveSegment(leaf, parentId);
    folderIdCache.set(folderPath, folderId);
    return folderId;
  })().finally(() => {
    // Cleared on failure too, so a transient error doesn't poison the path for
    // the rest of the process's life.
    inFlightResolutions.delete(folderPath);
  });

  inFlightResolutions.set(folderPath, resolution);
  return resolution;
}

/** Moves a message into the given (possibly nested) Outlook folder path. */
export async function moveMessage(
  messageId: string,
  destinationFolderPath: string,
  context: AuditContext,
): Promise<void> {
  const env = loadEnv();
  const folderId = await getOrCreateFolderId(destinationFolderPath);

  await graphRequest<void>({
    method: "POST",
    path: `/users/${env.GRAPH_MAILBOX_ADDRESS}/messages/${messageId}/move`,
    body: { destinationId: folderId },
  });

  appendAuditLog({
    ...context,
    eventType: "graph.move_message",
    detail: { messageId, destinationFolderPath },
  });
}
