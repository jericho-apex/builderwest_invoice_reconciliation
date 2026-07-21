import { randomUUID } from "node:crypto";
import { loadEnv } from "../../config/env.js";
import { logger } from "../../log/logger.js";
import { primeRequest } from "./httpClient.js";
import { appendAuditLog } from "../../db/repositories/auditLog.js";
import type { AuditContext } from "./workOrders.js";

interface PrimeAttachmentApiResponse {
  attachmentId: string;
}

export const DRY_RUN_ID_PREFIX = "dryrun-";

/**
 * Uploads the invoice PDF to Prime's Attachments API and returns its
 * attachmentId, which the AP invoice record must reference (PRD §5.1 —
 * "attachment must exist before the invoice references it").
 *
 * Gated by PRIME_DRY_RUN: with no Prime sandbox for this pilot, a fabricated
 * attachmentId is returned (and logged) instead of ever calling Prime, so
 * the rest of the pipeline can be exercised safely. This is the ONLY place
 * that gate needs to exist for uploads — callers never need to check
 * PRIME_DRY_RUN themselves.
 */
export async function uploadAttachment(
  pdfBuffer: Buffer,
  filename: string,
  context: AuditContext,
): Promise<string> {
  const env = loadEnv();

  if (env.PRIME_DRY_RUN) {
    const fakeId = `${DRY_RUN_ID_PREFIX}attachment-${randomUUID()}`;
    logger.info("[dry-run] would upload attachment to Prime", { filename, fakeId });
    appendAuditLog({
      ...context,
      eventType: "prime.upload_attachment.dry_run",
      detail: { filename, fakeId },
    });
    return fakeId;
  }

  const form = new FormData();
  // Uint8Array.from copies into a plain ArrayBuffer-backed array — Buffer's
  // underlying buffer is typed ArrayBufferLike (which can be a
  // SharedArrayBuffer), which BlobPart's stricter DOM typing rejects.
  form.set("file", new Blob([Uint8Array.from(pdfBuffer)], { type: "application/pdf" }), filename);

  const response = await primeRequest<PrimeAttachmentApiResponse>({
    method: "POST",
    path: "/attachments",
    rawBody: form,
  });

  appendAuditLog({
    ...context,
    eventType: "prime.upload_attachment",
    detail: { filename, attachmentId: response.attachmentId },
  });

  return response.attachmentId;
}
