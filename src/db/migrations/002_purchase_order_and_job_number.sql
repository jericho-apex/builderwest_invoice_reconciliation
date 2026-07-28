-- The client's supplier invoices identify work via a purchase order number
-- (e.g. "PO21266") plus a job number (e.g. "BWC-5126"), not the single
-- work-order reference the original schema assumed. These are separate
-- identifiers and must be stored separately:
--
--   * purchase order number — the ONLY key work-order matching uses. One PO
--     names one work order.
--   * job number — NOT used for matching (a job carries many work orders, so
--     it cannot identify one). Captured because it is the most likely route to
--     the `jobId` that attachment upload and AP-invoice create both require
--     (docs/prime-api-gaps.md Q3), and because it is useful context for a
--     human working an exception folder.
--
-- extracted_work_order_ref is retained for invoices that print an explicit
-- work-order reference. It is audit data only and no longer drives matching.
ALTER TABLE invoices ADD COLUMN extracted_purchase_order_number TEXT;
ALTER TABLE invoices ADD COLUMN extracted_job_number TEXT;
