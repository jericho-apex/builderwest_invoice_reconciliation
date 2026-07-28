/**
 * The client's three dummy invoices, and the Prime data they are matched
 * against — the single source of truth shared by the offline regression test
 * (tests/pipeline/orchestrator.dryrun.test.ts) and the live-extraction proof
 * script (scripts/pipeline-sample.ts), so the two cannot drift apart.
 *
 * What the three PDFs in docs/ actually contain:
 *
 *   1_PO21266_CORRECT      Ryan Smith      PO21266  435.00 / 43.50 / 478.50  -> approve
 *   2_PO21267_INCORRECT_AMOUNT  Tobey Chan  PO21267  705.00 / 70.50 / 775.50  -> costMismatch
 *   3_INCORRECT_PO         Brittnii Woods  PO99999  775.00 / 77.50 / 852.50  -> noWorkOrder
 *
 * Two traps these fixtures exist to catch:
 *
 * - THE ATTENTION LINE. Invoices 2 and 3 print "Attention: Ryan Smith" while
 *   their actual issuers are Tobey Chan and Brittnii Woods. If extraction reads
 *   the Attention line instead of the header, invoice 2 resolves to Ryan Smith's
 *   contact and STILL produces costMismatch — the right outcome from the wrong
 *   supplier. That is why every expectation below pins supplierName and
 *   contactId, not just the outcome.
 *
 * - THE PLACEHOLDER ABN. All three print "00 000 000 000". Keying on it would
 *   resolve all three to whichever contact carries it. matching/abn.ts rejects
 *   it, so every supplier here must resolve by NAME — hence the
 *   supplierMatchStatus expectations.
 */

/**
 * Work orders as Prime would return them: JSON:API rows with STRING ids and
 * DOLLAR amounts (prime/workOrders.ts's mapWorkOrder multiplies by 100 — a
 * fixture written in cents produces a $47,850 work order and mismatches
 * everything).
 *
 * The amount fields mirror production exactly, including its inconsistent
 * typing: `costTotal` is the ex-GST cost as a JSON number, `costTaxTotal` is the
 * GST amount ALONE as a decimal string. The inc-GST figure the invoice prints is
 * the sum of the two, which is what COST_FIELD=costTotalIncTax compares against.
 * Both rows below were read from production Prime on 2026-07-28.
 *
 * `purchaseOrderNumber` sits at the top level rather than inside `attributes`
 * only because it is the stub's lookup key; the real field is the work order's
 * `label` (PRIME_WORK_ORDER_PO_FIELD, verified live).
 */
export const PRIME_WORK_ORDERS = [
  // 435.00 + 43.50 = 478.50 — exactly invoice 1's total, so it auto-approves.
  {
    id: "wo_stage1_po21266",
    purchaseOrderNumber: "PO21266",
    attributes: { costTotal: 435.0, costTaxTotal: "43.50", jobId: "job_bwc5126" },
  },
  // 405.00 + 40.50 = 445.50 against invoice 2's 775.50 -> cost mismatch. These
  // are the REAL Stage 2 figures, read from production; the earlier invented
  // 605.00 placeholder is retired.
  {
    id: "wo_stage2_po21267",
    purchaseOrderNumber: "PO21267",
    attributes: { costTotal: 405.0, costTaxTotal: "40.50", jobId: "job_bwc5126" },
  },
  // PO99999 is intentionally absent. That absence IS invoice 3's test.
] as const;

/** All three carry the same placeholder ABN, which is exactly why it must never be matched on. */
export const PRIME_CONTACTS = [
  { id: "contact_ryan_smith", attributes: { name: "Ryan Smith", abn: "00000000000" } },
  { id: "contact_tobey_chan", attributes: { name: "Tobey Chan", abn: "00000000000" } },
  { id: "contact_brittnii_woods", attributes: { name: "Brittnii Woods", abn: "00000000000" } },
] as const;

export interface ClientDummyInvoice {
  /** Repo-relative path to the PDF. */
  pdf: string;
  /** Short label for output tables. */
  label: string;
  /** What the extraction model must read off the page. */
  extraction: {
    supplierName: string;
    purchaseOrderNumber: string;
    jobNumber: string;
    exTaxAmount: number;
    taxAmount: number;
    totalAmount: number;
  };
  /** What the pipeline must then decide. */
  expected: {
    outcome: "approve" | "exception";
    /** Exception reason key (matches EXCEPTION_FOLDERS); undefined when approving. */
    reason?: "noWorkOrder" | "supplierNotFound" | "costMismatch";
    /** Terminal invoices.stage the worker should reach. */
    stage: "synced" | "exception";
    workOrderId?: string;
    contactId?: string;
    supplierMatchStatus: "matched_by_name" | "not_found" | "not_attempted";
    workOrderMatchStatus: "matched" | "not_found" | "ambiguous";
  };
}

export const CLIENT_DUMMY_INVOICES: readonly ClientDummyInvoice[] = [
  {
    pdf: "docs/Dummy_Invoice_1_PO21266_CORRECT.pdf",
    label: "1 CORRECT",
    extraction: {
      supplierName: "Ryan Smith",
      purchaseOrderNumber: "PO21266",
      jobNumber: "BWC-5126",
      exTaxAmount: 435.0,
      taxAmount: 43.5,
      totalAmount: 478.5,
    },
    expected: {
      outcome: "approve",
      stage: "synced",
      workOrderId: "wo_stage1_po21266",
      contactId: "contact_ryan_smith",
      supplierMatchStatus: "matched_by_name",
      workOrderMatchStatus: "matched",
    },
  },
  {
    pdf: "docs/Dummy_Invoice_2_PO21267_INCORRECT_AMOUNT.pdf",
    label: "2 INCORRECT AMOUNT",
    extraction: {
      supplierName: "Tobey Chan",
      purchaseOrderNumber: "PO21267",
      jobNumber: "BWC-5126",
      exTaxAmount: 705.0,
      taxAmount: 70.5,
      totalAmount: 775.5,
    },
    expected: {
      outcome: "exception",
      reason: "costMismatch",
      stage: "exception",
      workOrderId: "wo_stage2_po21267",
      // NOT contact_ryan_smith — that is the Attention line, and reading it
      // would still yield costMismatch. This is the assertion that catches it.
      contactId: "contact_tobey_chan",
      supplierMatchStatus: "matched_by_name",
      workOrderMatchStatus: "matched",
    },
  },
  {
    pdf: "docs/Dummy_Invoice_3_INCORRECT_PO.pdf",
    label: "3 INCORRECT PO",
    extraction: {
      supplierName: "Brittnii Woods",
      purchaseOrderNumber: "PO99999",
      jobNumber: "BWC-5126",
      exTaxAmount: 775.0,
      taxAmount: 77.5,
      totalAmount: 852.5,
    },
    expected: {
      outcome: "exception",
      reason: "noWorkOrder",
      stage: "exception",
      // The PO fails first, so the supplier is never looked up — even though
      // Brittnii Woods does exist in the contact fixtures above.
      supplierMatchStatus: "not_attempted",
      workOrderMatchStatus: "not_found",
    },
  },
];

/** Shapes a fixture row the way prime/workOrders.ts's mapWorkOrder returns it. */
export function toPrimeWorkOrder(row: (typeof PRIME_WORK_ORDERS)[number]) {
  return {
    id: row.id,
    costTotalCents: Math.round(row.attributes.costTotal * 100),
    // Number() because production sends this one as a decimal string, and the
    // fixtures mirror that.
    costTaxTotalCents: Math.round(Number(row.attributes.costTaxTotal) * 100),
    jobId: row.attributes.jobId,
  };
}

/** Shapes a fixture row the way prime/contacts.ts returns it. */
export function toPrimeContact(row: (typeof PRIME_CONTACTS)[number]) {
  return { id: row.id, name: row.attributes.name, abn: row.attributes.abn };
}
