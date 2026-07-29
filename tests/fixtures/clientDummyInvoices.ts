/**
 * The client's sample invoices, and the Prime data they are matched against —
 * the single source of truth shared by the offline regression test
 * (tests/pipeline/orchestrator.dryrun.test.ts) and the live-extraction proof
 * script (scripts/pipeline-sample.ts), so the two cannot drift apart.
 *
 * TWO GENERATIONS OF SAMPLE DATA, and they test different things.
 *
 * The original three are SYNTHETIC: "suppliers" are Builderwest staff
 * (contactType User), and all three print the placeholder ABN, so they exercise
 * name matching and nothing else.
 *
 *   1_PO21266_CORRECT           Ryan Smith      PO21266  435.00 / 43.50 / 478.50  -> approve
 *   2_PO21267_INCORRECT_AMOUNT  Tobey Chan      PO21267  705.00 / 70.50 / 775.50  -> costMismatch
 *   3_INCORRECT_PO              Brittnii Woods  PO99999  775.00 / 77.50 / 852.50  -> noWorkOrder
 *
 * The three Builderwest sent on 2026-07-29 are REAL invoices from real
 * subcontractors, all against test claim BWC-WA-6797, and they are the first
 * data that exercises ABN matching at all:
 *
 *   26.pdf           Hutchy Ceilings   PO21343  1095.00 / 109.50 / 1204.50  -> approve
 *   369.pdf          Beale 4           PO21342   360.00 /  36.00 /  396.00  -> costMismatch
 *   invoice_300.pdf  Rare Electrical   PO21340   600.00 /  60.00 /  660.00  -> approve
 *
 * The traps these fixtures exist to catch:
 *
 * - THE ATTENTION LINE. Synthetic invoices 2 and 3 print "Attention: Ryan Smith"
 *   while their actual issuers are Tobey Chan and Brittnii Woods. If extraction
 *   reads the Attention line instead of the header, invoice 2 resolves to Ryan
 *   Smith's contact and STILL produces costMismatch — the right outcome from the
 *   wrong supplier. That is why every expectation below pins supplierName and
 *   contactId, not just the outcome.
 *
 * - THE PLACEHOLDER ABN. All three synthetic invoices print "00 000 000 000".
 *   Keying on it would resolve them all to whichever contact carries it.
 *   matching/abn.ts rejects it, so those three must resolve by NAME.
 *
 * - THE PO UNDER "WO No". 369.pdf labels its purchase order "WO No: PO21342",
 *   while the extraction prompt tells the model workOrderRef is a SEPARATE field
 *   from purchaseOrderNumber. Verified live 2026-07-29: the model puts it in BOTH,
 *   so matching gets what it needs and choosePurchaseOrder just prefers the PO
 *   field. The fallback exists because that is model judgement, not a guarantee —
 *   a model honouring the prompt literally would leave purchaseOrderNumber null
 *   and send a valid invoice to Exceptions/No work order.
 *
 * - ABNs ARE EXTRACTED DIGITS-ONLY. The prompt asks for the ABN with spaces
 *   removed, so the model returns "39108785824" where the page prints
 *   "3910 8785 824". The `supplierAbn` values below are the PRINTED forms, which
 *   is what makes the offline run exercise normalizeAbn -> abnQueryCandidates
 *   rather than assuming a pre-normalized input.
 *
 * - THE MISSING DUE DATE. 26.pdf prints "Due in 30 Days" and leaves the due-date
 *   cell empty. dueDate is required before any Prime write, so without
 *   extraction/dueDate.ts deriving it the invoice never reaches the write path.
 *
 * - THE SUPPLIER NAME THAT DOES NOT MATCH. The real invoices print legal names
 *   ("Hutchy Ceilings Pty Ltd", "Rare Electrical PTY LTD") while Prime holds
 *   trading names ("Hutchy Ceilings", "Rare Electrical") — verified live. Under
 *   an exact `eq` the name lookup finds NOTHING for any of the three, so the ABN
 *   is the only thing that can resolve them. That is why their expected
 *   supplierMatchStatus is matched_by_abn: it is not a nicety, it is the only
 *   route that works.
 *
 * - THE TWO INVOICE NUMBERS. invoice_300.pdf heads with "Tax Invoice # 300" and
 *   repeats "Tax Invoice # 597" in its How-to-Pay block, and dates itself
 *   "29 July 2025" against a "30th August 2026" due date. The header number is
 *   the one to take; the date is extracted verbatim, inconsistency and all —
 *   second-guessing a supplier's document is not extraction's job.
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

  // ---- The real subcontractor invoices, claim BWC-WA-6797. Every figure and id
  // below was read from production Prime on 2026-07-29 via `npm run
  // discover:prime` — nothing here is invented, the same rule that retired the
  // earlier $605.00 placeholder. All three share one job, so a job-number
  // fallback would be catastrophic here in a way the PO never is.
  // 1095.00 + 109.50 = 1204.50 — exactly 26.pdf's total, so it auto-approves.
  {
    id: "9ef9ee58-1b33-4a94-84cf-c06edb8150be",
    purchaseOrderNumber: "PO21343",
    attributes: {
      costTotal: 1095.0,
      costTaxTotal: "109.50",
      jobId: "8be3459a-952c-4dcd-a8df-b44d40747185",
      assignedId: "c19c525c-9039-419c-8d62-7d84dc3db239",
    },
  },
  // 250.00 + 25.00 = 275.00 against 369.pdf's 396.00 -> cost mismatch. The work
  // order was raised for less than the supplier billed, which is precisely the
  // discrepancy this pilot exists to catch.
  {
    id: "4efb8d5a-33a4-4062-bda1-0dd0f7e7cd82",
    purchaseOrderNumber: "PO21342",
    attributes: {
      costTotal: 250.0,
      costTaxTotal: "25.00",
      jobId: "8be3459a-952c-4dcd-a8df-b44d40747185",
      assignedId: "899fad6a-d50c-451e-a586-74d4aeb5201d",
    },
  },
  // 600.00 + 60.00 = 660.00 — exactly invoice_300.pdf's total.
  {
    id: "48cb225f-5761-4e84-900b-5a27c8d1e49f",
    purchaseOrderNumber: "PO21340",
    attributes: {
      costTotal: 600.0,
      costTaxTotal: "60.00",
      jobId: "8be3459a-952c-4dcd-a8df-b44d40747185",
      assignedId: "0f2429f3-5a07-430d-98f7-0f376bf52d70",
    },
  },
] as const;

/**
 * The synthetic three carry the same placeholder ABN, which is exactly why it
 * must never be matched on. The real three carry valid ABNs stored the way
 * production actually stores them — ATO-GROUPED, verified live 2026-07-29. That
 * grouping is the fixture's most load-bearing detail: resolveSupplier normalizes
 * to digits, so against a digits-only fixture the ABN path would appear to work
 * here and fail in production. matching/abn.ts's abnQueryCandidates is what
 * bridges it.
 */
export const PRIME_CONTACTS = [
  { id: "contact_ryan_smith", attributes: { name: "Ryan Smith", abn: "00000000000" } },
  { id: "contact_tobey_chan", attributes: { name: "Tobey Chan", abn: "00000000000" } },
  { id: "contact_brittnii_woods", attributes: { name: "Brittnii Woods", abn: "00000000000" } },
  // Trading names, NOT the legal names the invoices print — that mismatch is why
  // the ABN is the only key that resolves these three.
  {
    id: "c19c525c-9039-419c-8d62-7d84dc3db239",
    attributes: { name: "Hutchy Ceilings", abn: "68 628 819 741" },
  },
  {
    id: "899fad6a-d50c-451e-a586-74d4aeb5201d",
    attributes: { name: "Beale 4 Maintenance", abn: "39 108 785 824" },
  },
  {
    id: "0f2429f3-5a07-430d-98f7-0f376bf52d70",
    attributes: { name: "Rare Electrical", abn: "23 676 709 185" },
  },
] as const;

export interface ClientDummyInvoice {
  /** Repo-relative path to the PDF. */
  pdf: string;
  /** Short label for output tables. */
  label: string;
  /** What the extraction model must read off the page. */
  extraction: {
    supplierName: string;
    /**
     * The ABN as PRINTED, spacing and all. Only meaningful when it is a real one
     * — the synthetic three print the placeholder, which must be rejected.
     */
    supplierAbn?: string;
    /**
     * Null when the invoice prints its PO under a label the prompt assigns to
     * workOrderRef instead (369.pdf's "WO No:"), in which case
     * choosePurchaseOrder has to recover it from `workOrderRef` below.
     */
    purchaseOrderNumber: string | null;
    workOrderRef?: string;
    jobNumber: string;
    exTaxAmount: number;
    taxAmount: number;
    totalAmount: number;
    invoiceNumber?: string;
    /** Load-bearing where a due date has to be derived from payment terms. */
    invoiceDate?: string;
    /** Null when the invoice prints no due date, stating payment terms instead. */
    dueDate?: string | null;
    paymentTermsDays?: number | null;
  };
  /** What the pipeline must then decide. */
  expected: {
    outcome: "approve" | "exception";
    /** Exception reason key (matches EXCEPTION_FOLDERS); undefined when approving. */
    reason?: "noWorkOrder" | "supplierNotFound" | "costMismatch" | "unreadable" | "writeBlocked";
    /** Terminal invoices.stage the worker should reach. */
    stage: "approved" | "exception";
    workOrderId?: string;
    contactId?: string;
    /** The PO the work-order lookup must end up keying off, wherever it was read from. */
    purchaseOrderUsed?: string;
    /** The due date that must be persisted — derived, when the invoice printed none. */
    dueDate?: string;
    supplierMatchStatus:
      | "matched_by_abn"
      | "matched_by_name"
      | "matched_by_assignment"
      | "not_found"
      | "not_attempted";
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
      stage: "approved",
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

  // ---- The real subcontractor invoices, Builderwest 2026-07-29 ----------------

  // The clean one, and the first invoice in this project to auto-approve off a
  // REAL supplier: valid ABN, and a work order raised for exactly what was
  // billed. It also carries the missing-due-date trap.
  {
    pdf: "docs/26.pdf",
    label: "26 HUTCHY CLEAN",
    extraction: {
      supplierName: "Hutchy Ceilings Pty Ltd",
      supplierAbn: "68 628 819 741",
      purchaseOrderNumber: "PO21343",
      jobNumber: "BWC-WA-6797",
      invoiceNumber: "26",
      invoiceDate: "2026-07-28",
      exTaxAmount: 1095.0,
      taxAmount: 109.5,
      totalAmount: 1204.5,
      // Prints "Due in 30 Days" and no date.
      dueDate: null,
      paymentTermsDays: 30,
    },
    expected: {
      outcome: "approve",
      stage: "approved",
      workOrderId: "9ef9ee58-1b33-4a94-84cf-c06edb8150be",
      contactId: "c19c525c-9039-419c-8d62-7d84dc3db239",
      // 2026-07-28 + 30 days. Without this the invoice cannot be written at all.
      dueDate: "2026-08-27",
      // NOT matched_by_name: Prime holds "Hutchy Ceilings", the invoice prints
      // "Hutchy Ceilings Pty Ltd", so the name lookup returns nothing.
      supplierMatchStatus: "matched_by_abn",
      workOrderMatchStatus: "matched",
    },
  },

  // The discrepancy the pilot exists to catch, on real data: the work order was
  // raised at $275.00 inc and the subcontractor billed $396.00. It also hides its
  // PO under "WO No:", so it only gets as far as the cost check if
  // choosePurchaseOrder recovered it.
  {
    pdf: "docs/369.pdf",
    label: "369 BEALE4 OVER",
    extraction: {
      // "Beale 4", not "Beale4": the logo is stylised but the model reads the
      // spaced form, which is also closer to Prime's "Beale 4 Maintenance".
      // Confirmed against the live model 2026-07-29.
      supplierName: "Beale 4",
      supplierAbn: "3910 8785 824",
      // The model reads "WO No: PO21342" into BOTH fields — verified live. So the
      // PO arrives where matching wants it and choosePurchaseOrder simply prefers
      // it. The fallback stays as insurance: the prompt explicitly tells the model
      // workOrderRef is a separate field, so a future model could honour that
      // literally and leave purchaseOrderNumber null. purchaseOrder.test.ts and
      // the orchestrator dry-run block cover that path directly.
      purchaseOrderNumber: "PO21342",
      workOrderRef: "PO21342",
      jobNumber: "BWC-WA-6797",
      invoiceNumber: "369",
      invoiceDate: "2026-07-28",
      exTaxAmount: 360.0,
      taxAmount: 36.0,
      totalAmount: 396.0,
      dueDate: null,
      paymentTermsDays: null,
    },
    expected: {
      outcome: "exception",
      reason: "costMismatch",
      stage: "exception",
      workOrderId: "4efb8d5a-33a4-4062-bda1-0dd0f7e7cd82",
      contactId: "899fad6a-d50c-451e-a586-74d4aeb5201d",
      // "Beale 4" on the invoice vs "Beale 4 Maintenance" in Prime — again only
      // the ABN can bridge it, and its printed grouping is non-standard too.
      supplierMatchStatus: "matched_by_abn",
      workOrderMatchStatus: "matched",
    },
  },

  // Second clean approval. Its PO and job number sit on one unlabelled line
  // ("PO21340 BWC-WA-6797"), and it prints two different invoice numbers — 300 in
  // the header, 597 in the How-to-Pay block. The header one is correct.
  {
    pdf: "docs/invoice_300.pdf",
    label: "300 RARE CLEAN",
    extraction: {
      supplierName: "Rare Electrical PTY LTD",
      supplierAbn: "23 676 709 185",
      purchaseOrderNumber: "PO21340",
      jobNumber: "BWC-WA-6797",
      invoiceNumber: "300",
      // Verbatim: the document really does date itself 2025 while its due date is
      // 2026. Extraction reports what is printed; second-guessing a supplier's
      // paperwork is not its job.
      invoiceDate: "2025-07-29",
      exTaxAmount: 600.0,
      taxAmount: 60.0,
      totalAmount: 660.0,
      dueDate: "2026-08-30",
      paymentTermsDays: null,
    },
    expected: {
      outcome: "approve",
      stage: "approved",
      workOrderId: "48cb225f-5761-4e84-900b-5a27c8d1e49f",
      contactId: "0f2429f3-5a07-430d-98f7-0f376bf52d70",
      dueDate: "2026-08-30",
      supplierMatchStatus: "matched_by_abn",
      workOrderMatchStatus: "matched",
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
    // Present only on the real work orders, and only used to break a same-name
    // supplier tie — never as a supplier lookup of its own.
    assignedId: "assignedId" in row.attributes ? row.attributes.assignedId : undefined,
  };
}

/** Shapes a fixture row the way prime/contacts.ts returns it. */
export function toPrimeContact(row: (typeof PRIME_CONTACTS)[number]) {
  return { id: row.id, name: row.attributes.name, abn: row.attributes.abn };
}
