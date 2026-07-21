-- Cheap dedupe at the message level, before classification even runs. A
-- message that turns out to be a non-invoice (job-note, claim instruction)
-- never gets an `invoices` row at all — this table is the only trace of it.
CREATE TABLE processed_messages (
  message_id    TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  cleared_at    TEXT -- set when a human moves the item back to Inbox/Retry, making it eligible again
);

-- One row per invoice (one per PDF attachment — attachment_index handles the
-- rare case of multiple invoice PDFs on one email). `stage` is the mutable
-- current-state column that makes a worker restart mid-approval resumable
-- instead of re-creating a duplicate AP invoice in Prime.
--
-- stage values:
--   received -> classified -> extracted -> matched
--     -> attachment_uploaded -> ap_created -> approved_pending_sync -> synced
--   or: exception:<reason>  (reason matches one of the EXCEPTION_FOLDERS keys)
CREATE TABLE invoices (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id                  TEXT NOT NULL,
  attachment_index            INTEGER NOT NULL DEFAULT 0,
  stage                       TEXT NOT NULL DEFAULT 'received',

  -- Raw extracted fields (PDF -> strict JSON via OpenRouter/Claude)
  extracted_supplier_name     TEXT,
  extracted_supplier_abn      TEXT,
  extracted_invoice_number    TEXT,
  extracted_invoice_date      TEXT,
  extracted_due_date          TEXT,
  extracted_ex_tax_amount_cents INTEGER,
  extracted_tax_amount_cents  INTEGER,
  extracted_total_amount_cents INTEGER,
  extracted_work_order_ref    TEXT,
  extraction_confidence       REAL,

  -- Prime-side identifiers, persisted immediately after each Prime write
  -- returns (one write at a time, never batched) so a restart can resume
  -- from the last completed step instead of restarting the approve flow.
  prime_work_order_id         TEXT,
  prime_contact_id            TEXT,
  prime_attachment_id         TEXT,
  prime_ap_invoice_id         TEXT,
  is_synced                   INTEGER NOT NULL DEFAULT 0,
  synced_finance_system_name  TEXT,
  synced_finance_system_reference TEXT,
  sync_attempt_count          INTEGER NOT NULL DEFAULT 0,
  last_sync_check_at          TEXT,

  exception_reason            TEXT,

  created_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  UNIQUE (message_id, attachment_index)
);

CREATE INDEX idx_invoices_stage ON invoices (stage);
CREATE INDEX idx_invoices_message_id ON invoices (message_id);

-- Work order match, supplier match, and cost comparison detail for a single
-- invoice's matching attempt. An invoice that gets retried can accumulate
-- more than one match_results row — the latest one is authoritative.
CREATE TABLE match_results (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id             INTEGER NOT NULL REFERENCES invoices (id),

  work_order_match_status TEXT NOT NULL, -- 'matched' | 'not_found'
  work_order_id           TEXT,

  supplier_match_status   TEXT NOT NULL, -- 'matched_by_abn' | 'matched_by_name' | 'not_found'
  supplier_contact_id     TEXT,

  cost_field_used         TEXT,          -- 'cost' | 'costTaxTotal' (config value, see COST_FIELD)
  invoice_total_cents     INTEGER,
  work_order_cost_cents   INTEGER,
  cost_difference_cents   INTEGER,
  within_tolerance        INTEGER,       -- 0 | 1

  decision                TEXT NOT NULL, -- 'approve' | 'exception'
  exception_reason        TEXT,

  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_match_results_invoice_id ON match_results (invoice_id);

-- Append-only. Never updated, only inserted — one row per Prime/Graph/
-- OpenRouter call and every folder move. This is the durable audit trail
-- the PRD requires; do not use it to derive "current state" (that's what
-- invoices.stage is for).
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER,
  message_id  TEXT,
  event_type  TEXT NOT NULL,
  detail      TEXT, -- JSON blob
  is_error    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_audit_log_invoice_id ON audit_log (invoice_id);
CREATE INDEX idx_audit_log_message_id ON audit_log (message_id);
CREATE INDEX idx_audit_log_event_type ON audit_log (event_type);
