import { loadEnv } from "../../config/env.js";
import { RETRY_FOLDER } from "../../config/constants.js";
import { graphRequest } from "./httpClient.js";
import { getOrCreateFolderId } from "./folders.js";
import { getLatestProcessedTimestamp } from "../../db/repositories/processedMessages.js";

export interface GraphMessageSummary {
  id: string;
  receivedDateTime: string;
  subject: string;
  hasAttachments: boolean;
  /** Graph's truncated body preview — evidence for classification, never for extraction. */
  bodyPreview?: string;
  from?: { emailAddress: { address: string; name?: string } };
}

export interface GraphFileAttachment {
  id: string;
  name: string;
  contentType: string;
  /** Base64-encoded bytes — Graph's simple attachment payload. Large
   * attachments (beyond Graph's inline size threshold) need the $value /
   * chunked-download path instead; this is a known limitation flagged in
   * the implementation plan's risks, not yet handled here. */
  contentBytes: string;
}

interface GraphListResponse<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

// How far back to look on the very first run, when no checkpoint exists yet
// (avoids scanning the mailbox's entire history).
const FIRST_RUN_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Safety buffer subtracted from the checkpoint to tolerate clock skew and
// Graph indexing lag — overlap is harmless, processed_messages dedupes it.
const CHECKPOINT_SAFETY_BUFFER_MS = 15 * 60 * 1000;

// bodyPreview is here for the classifier: subject + sender alone is too little
// to tell an invoice from a job note, and Graph returns the preview on the list
// call for free (it is a truncated ~255-char string, not the full body, so it
// costs nothing extra to select).
const MESSAGE_SELECT_FIELDS = "id,receivedDateTime,subject,from,hasAttachments,bodyPreview";

async function listAllMessages(
  folderId: string,
  filter: string | undefined,
): Promise<GraphMessageSummary[]> {
  const env = loadEnv();
  const results: GraphMessageSummary[] = [];

  let path = `/users/${env.GRAPH_MAILBOX_ADDRESS}/mailFolders/${folderId}/messages`;
  let query: Record<string, string | undefined> | undefined = {
    $filter: filter,
    $select: MESSAGE_SELECT_FIELDS,
    $orderby: "receivedDateTime asc",
    $top: "100",
  };

  for (;;) {
    const response = await graphRequest<GraphListResponse<GraphMessageSummary>>({
      method: "GET",
      path,
      query,
    });
    results.push(...response.value);

    const nextLink = response["@odata.nextLink"];
    if (!nextLink) {
      break;
    }
    // The nextLink is already a complete absolute URL with all query params
    // encoded — pass it straight through as the path, no further query.
    path = nextLink;
    query = undefined;
  }

  return results;
}

export interface PollResult {
  inboxMessages: GraphMessageSummary[];
  retryMessages: GraphMessageSummary[];
}

/**
 * Polls both the Inbox (checkpoint-filtered, so a growing mailbox is never
 * re-listed in full) and the Retry folder (fully listed every tick — it
 * should normally be near-empty). Kept as two separate arrays, not merged:
 * a message found in Retry gets different handling upstream (retry
 * detection, pipeline/retry.ts) than one found fresh in Inbox.
 *
 * IMPORTANT operational note: retries MUST go through the dedicated Retry
 * folder, not by dragging the email back into Inbox. Graph's
 * receivedDateTime never changes when a message moves folders, so an old
 * message dropped back into Inbox would sit before the checkpoint below and
 * never be picked up. The Retry folder has no such filter — it's listed in
 * full every tick specifically to avoid this blind spot.
 */
export async function pollForNewMessages(): Promise<PollResult> {
  const checkpoint = getLatestProcessedTimestamp();
  const since = checkpoint
    ? new Date(new Date(checkpoint).getTime() - CHECKPOINT_SAFETY_BUFFER_MS)
    : new Date(Date.now() - FIRST_RUN_LOOKBACK_MS);

  const inboxFilter = `receivedDateTime gt ${since.toISOString()} and hasAttachments eq true`;
  const inboxMessages = await listAllMessages("inbox", inboxFilter);

  // The Retry listing sends NO $filter, and screens for attachments in code.
  //
  // Graph answers 400 InefficientFilter to `$filter=hasAttachments eq true`
  // combined with `$orderby=receivedDateTime`: when the two are combined, the
  // ordered property must also be constrained by the filter so the store can
  // use an index. The Inbox poll satisfies that via its `receivedDateTime gt`
  // checkpoint; a Retry listing has no checkpoint clause to satisfy it with, so
  // the same shape is rejected. Dropping $orderby instead would work, but the
  // ordering is worth more than a server-side test on a folder that is listed
  // in full anyway precisely because it should be near-empty.
  const retryFolderId = await getOrCreateFolderId(RETRY_FOLDER);
  const retryMessages = (await listAllMessages(retryFolderId, undefined)).filter(
    (message) => message.hasAttachments,
  );

  return { inboxMessages, retryMessages };
}

/** Re-fetches a single message's summary — used when resuming an in-flight invoice and when composing the missing-data auto-reply, where only the messageId is on hand. */
export async function getMessageById(messageId: string): Promise<GraphMessageSummary> {
  const env = loadEnv();
  return graphRequest<GraphMessageSummary>({
    method: "GET",
    path: `/users/${env.GRAPH_MAILBOX_ADDRESS}/messages/${messageId}`,
    query: { $select: MESSAGE_SELECT_FIELDS },
  });
}

/** Fetches every attachment on a message and returns only the PDF ones. */
export async function getPdfAttachments(messageId: string): Promise<GraphFileAttachment[]> {
  const env = loadEnv();
  const response = await graphRequest<GraphListResponse<GraphFileAttachment>>({
    method: "GET",
    path: `/users/${env.GRAPH_MAILBOX_ADDRESS}/messages/${messageId}/attachments`,
  });

  return response.value.filter((attachment) => attachment.contentType === "application/pdf");
}
