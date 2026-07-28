import { randomUUID } from "node:crypto";
import { loadEnv } from "../../config/env.js";
import { PRIME_ATTACHMENT_STATUS, PRIME_ATTACHMENT_OBJECT_TYPE } from "../../config/constants.js";
import { logger } from "../../log/logger.js";
import { primeRequest } from "./httpClient.js";
import { appendAuditLog } from "../../db/repositories/auditLog.js";
import type { AuditContext } from "./workOrders.js";

// JSON:API — the created resource's id is at data.id. The previous shape read a
// top-level `attachmentId`, which does not exist on the response, so even a
// successful upload returned undefined and the AP invoice referenced nothing.
interface PrimeAttachmentApiResponse {
  data: { id: string };
}

export const DRY_RUN_ID_PREFIX = "dryrun-";

export interface UploadAttachmentInput {
  /** Raw PDF bytes — base64-encoded here, since Prime takes the content inline. */
  pdf: Buffer;
  filename: string;
  /** The Job this attachment hangs off. Prime attaches to the job, not the work order. */
  jobId: string;
}

/**
 * Uploads the invoice PDF to Prime's Attachments API and returns its id, which
 * the AP invoice then references (PRD §5.1 — "attachment must exist before the
 * invoice references it").
 *
 * Shape verified against production on 2026-07-28 by reading the attachments
 * real AP invoices already carry: JSON rather than multipart, `file` as base64,
 * `attachmentStatus: "Published"`, and `objectType: "Job"` with `objectId` equal
 * to the AP invoice's own jobId on every one of them. The earlier multipart form
 * was a guess and would have been rejected.
 *
 * Size note: Prime's single-POST limit is 25 MB and base64 inflates ~33%, so
 * ~18 MB of PDF. Graph's inline-attachment fetch gives out well before that, so
 * it remains the binding constraint on large invoices (analyze.md §3.3).
 *
 * Gated by PRIME_DRY_RUN: with no Prime sandbox for this pilot, a fabricated id
 * is returned (and logged) instead of ever calling Prime. This is the ONLY place
 * that gate needs to exist for uploads — callers never check it themselves.
 */
export async function uploadAttachment(
  input: UploadAttachmentInput,
  context: AuditContext,
): Promise<string> {
  const env = loadEnv();

  const body = {
    fileName: input.filename,
    attachmentTypeId: env.PRIME_ATTACHMENT_TYPE_ID,
    attachmentStatus: PRIME_ATTACHMENT_STATUS,
    objectType: PRIME_ATTACHMENT_OBJECT_TYPE,
    objectId: input.jobId,
    file: input.pdf.toString("base64"),
  };

  // The base64 payload is the entire invoice — never logged and never audited.
  // Everything else about the request is, since these lines are what a human
  // reviews before dry-run is switched off.
  const { file: _file, ...loggableBody } = body;
  const loggable = { body: loggableBody, fileBytes: input.pdf.byteLength };

  if (env.PRIME_DRY_RUN) {
    const fakeId = `${DRY_RUN_ID_PREFIX}attachment-${randomUUID()}`;
    logger.info("[dry-run] would upload attachment to Prime", { ...loggable, fakeId });
    appendAuditLog({
      ...context,
      eventType: "prime.upload_attachment.dry_run",
      detail: { ...loggable, fakeId },
    });
    return fakeId;
  }

  const response = await primeRequest<PrimeAttachmentApiResponse>({
    method: "POST",
    path: "/attachments",
    body,
  });

  appendAuditLog({
    ...context,
    eventType: "prime.upload_attachment",
    detail: { ...loggable, attachmentId: response.data.id },
  });

  return response.data.id;
}
