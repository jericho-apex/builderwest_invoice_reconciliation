import { getDb } from "../client.js";

export interface AuditLogInput {
  invoiceId?: number;
  messageId?: string;
  eventType: string;
  detail?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Appends one row to the durable audit trail — every Prime/Graph/OpenRouter
 * call and every folder move goes through this function. Append-only: this
 * table is never updated, only inserted into. Do not use it to derive
 * "current state" — that's what invoices.stage is for.
 */
export function appendAuditLog(input: AuditLogInput): void {
  getDb()
    .prepare(
      `INSERT INTO audit_log (invoice_id, message_id, event_type, detail, is_error)
       VALUES (@invoiceId, @messageId, @eventType, @detail, @isError)`,
    )
    .run({
      invoiceId: input.invoiceId ?? null,
      messageId: input.messageId ?? null,
      eventType: input.eventType,
      detail: input.detail ? JSON.stringify(input.detail) : null,
      isError: input.isError ? 1 : 0,
    });
}
