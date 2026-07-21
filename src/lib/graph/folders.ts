import { loadEnv } from "../../config/env.js";
import { logger } from "../../log/logger.js";
import { graphRequest } from "./httpClient.js";
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

/**
 * Resolves a (possibly nested) Outlook folder path to its Graph folder ID,
 * creating any missing segments along the way — idempotent, per PRD §4.5
 * ("the app creates these subfolders via Graph if they do not exist").
 */
export async function getOrCreateFolderId(folderPath: string): Promise<string> {
  const cached = folderIdCache.get(folderPath);
  if (cached) {
    return cached;
  }

  const segments = folderPath.split("/");
  let parentId: string | undefined;
  let accumulatedPath = "";

  for (const segment of segments) {
    accumulatedPath = accumulatedPath ? `${accumulatedPath}/${segment}` : segment;

    const cachedSegment = folderIdCache.get(accumulatedPath);
    if (cachedSegment) {
      parentId = cachedSegment;
      continue;
    }

    let folderId = await findFolderByName(segment, parentId);
    if (!folderId) {
      folderId = await createFolder(segment, parentId);
      logger.info("created Outlook folder", { folderPath: accumulatedPath });
    }

    folderIdCache.set(accumulatedPath, folderId);
    parentId = folderId;
  }

  if (!parentId) {
    throw new Error(`Failed to resolve or create folder path: ${folderPath}`);
  }
  return parentId;
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
