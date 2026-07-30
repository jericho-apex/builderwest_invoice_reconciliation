import { z } from "zod";
// Circular by design and safe: logger reads LOG_LEVEL through loadEnv, but only
// inside its function bodies, so nothing here runs at module-evaluation time.
import { logger } from "../log/logger.js";

const boolFromString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/**
 * Comma-separated list -> string[]. Blank entries and surrounding whitespace are
 * dropped, so a trailing comma or a line broken across an .env file is harmless.
 * An unset or empty variable yields an empty array, never `[""]` — which would
 * otherwise read as a one-entry allowlist that matches nothing.
 */
const csvList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
  );

const envSchema = z.object({
  // Prime Ecosystem API — production only, no sandbox tier for this pilot.
  PRIME_BASE_URL: z.string().url(),
  PRIME_CLIENT_ID: z.string().min(1),
  PRIME_CLIENT_SECRET: z.string().min(1),
  PRIME_USERNAME: z.string().min(1),
  PRIME_PASSWORD: z.string().min(1),
  PRIME_DRY_RUN: boolFromString.default("true"),

  // The work orders live writes are FENCED TO. Comma-separated Prime work-order
  // ids; empty means unrestricted.
  //
  // Builderwest authorized live write testing on 2026-07-29 against test claim
  // BWC-WA-6797, whose dummy work orders Tobey Chan created — and cleanup in
  // Prime and Xero is theirs to do once told the run is finished. Since there is
  // no Prime sandbox, PRIME_DRY_RUN=false writes to production, against a live
  // mailbox that could receive a genuine supplier invoice mid-test. So this is a
  // code-enforced fence, not a note in a runbook: approve.ts refuses to write for
  // any work order outside the list and routes the invoice to
  // Exceptions/Write blocked instead.
  //
  // Empty deliberately means unrestricted rather than "block everything",
  // because at go-live real invoices must be able to write. loadEnv() logs a
  // warning when that combination is live, so losing the fence cannot be silent.
  PRIME_TEST_WORK_ORDER_IDS: csvList,

  // Which queryable work-order field holds the purchase order number printed
  // on a supplier invoice. Prime's v2 docs list no `purchaseOrderNumber` field
  // (prime-api-gaps.md Q1) — verified live 2026-07-28 against production: the
  // PO number lives in the work order's `label`, and `'label'.eq(...)` returns
  // exactly one work order for PO21266 and PO21267 and zero for PO99999.
  //
  // Does NOT fail safe: querying a field Prime doesn't recognise returns a
  // 500, not an empty result set, so a wrong name here throws (after retries)
  // rather than routing to Exceptions/No work order.
  //
  // ANSWERED by the client 2026-07-29: POs always start with "PO", but suppliers
  // sometimes omit the prefix when printing one, and either should match. Prime's
  // labels are split the same way (test work orders "PO21343", most production
  // rows a bare "17651"). matching/purchaseOrder.ts bridges it by querying both
  // canonical forms and unioning; nothing here needs to change.
  PRIME_WORK_ORDER_PO_FIELD: z.string().min(1).default("label"),

  // Which Prime attachment type an uploaded invoice PDF is filed under. Tenant
  // data, not a business rule, hence env — the IDs differ per Prime tenant.
  //
  // CONFIRMED by the client 2026-07-29: "any trade invoice is submitted under
  // subcontractor invoices". Read from production 2026-07-28, the AP invoices that
  // already exist carry attachments of type 2903b377-… labelled "Invoices", but
  // that type is NOT returned by /attachment-types and so looks retired. The
  // default below is the active equivalent, "Subcontractor Invoices" — i.e. the
  // client's answer confirms what this already did, and no change was needed.
  PRIME_ATTACHMENT_TYPE_ID: z.string().min(1).default("7f38c5c1-d5dd-4981-8868-e79f4f3323e8"),

  COST_TOLERANCE_MODE: z.enum(["exact", "dollar", "percentage"]).default("exact"),
  COST_TOLERANCE_VALUE: z.coerce.number().default(0),

  // Which work-order figure the invoice total is compared against. PRD §9.6
  // asked the client to choose between `cost` and `costTaxTotal`; the live API
  // answered it instead (verified 2026-07-28): a work order carries `costTotal`
  // (ex-GST, 435 on PO21266) and `costTaxTotal` (the GST amount alone, "43.50"),
  // and no `cost` field at all. A supplier invoice's printed total is inc-GST,
  // so the like-for-like comparison is the sum — 435.00 + 43.50 = 478.50, which
  // is exactly invoice 1's total. See matching/compareCost.ts.
  COST_FIELD: z.enum(["costTotal", "costTotalIncTax"]).default("costTotalIncTax"),

  // TEST-RUN ONLY. When true, an invoice whose supplier cannot be resolved to
  // exactly one Prime contact continues to the cost check as "assumed" instead
  // of routing to Exceptions/Supplier not found. This exists because production
  // Prime holds four contacts named "Ryan Smith" (one User, one Client, two
  // Customer), which makes the client's own auto-approve dummy invoice
  // unmatchable until they dedupe.
  //
  // This switches OFF a control on a money path — it must never be true on
  // Render. loadEnv() below refuses to start if it is combined with
  // PRIME_DRY_RUN=false, so it cannot cause a live AP invoice to be approved
  // against a supplier nobody verified.
  ASSUME_SUPPLIER_MATCHED: boolFromString.default("false"),

  // Microsoft Graph
  GRAPH_TENANT_ID: z.string().min(1),
  GRAPH_CLIENT_ID: z.string().min(1),
  GRAPH_CLIENT_SECRET: z.string().min(1),
  GRAPH_MAILBOX_ADDRESS: z.string().min(1),
  GRAPH_SEND_MAIL_ENABLED: boolFromString.default("false"),
  GRAPH_TEST_RECIPIENT: z.string().optional(),

  // The outbound-email equivalent of PRIME_TEST_WORK_ORDER_IDS, and it defaults
  // to ON for the same reason: the pilot mailbox is live and the sample invoices
  // are from REAL subcontractors, so the auto-reply's natural recipient (the
  // message sender) is a real trade business. When true, every auto-reply is
  // redirected to GRAPH_TEST_RECIPIENT with the intended address preserved in the
  // audit row and stated in the email itself.
  //
  // Set it to false only at go-live, when replies are supposed to reach suppliers.
  // Unlike a Prime write, an email cannot be voided after the fact — which is why
  // the safe value is the default rather than something to remember to turn on.
  GRAPH_SEND_MAIL_REDIRECT_TO_TEST: boolFromString.default("true"),

  // OpenRouter (AI extraction/classification, targeting a Claude model)
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().min(1).default("anthropic/claude-sonnet-4.5"),

  // Worker behavior
  POLL_INTERVAL_MINUTES: z.coerce.number().positive().default(10),
  DB_PATH: z.string().min(1).default("./data/app.db"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

let cachedEnv: Env | undefined;

/**
 * Parses and validates process.env once, caching the result. Fails fast with
 * a readable error listing every missing/malformed variable, rather than
 * letting a bad config surface as a confusing runtime error deep in a client.
 */
export function loadEnv(): Env {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  // The one combination that could auto-approve a real AP invoice in production
  // Prime against an unverified supplier. Refuse to start rather than trust an
  // operator to remember which flags cancel each other out.
  if (parsed.data.ASSUME_SUPPLIER_MATCHED && !parsed.data.PRIME_DRY_RUN) {
    throw new Error(
      "ASSUME_SUPPLIER_MATCHED is true but PRIME_DRY_RUN is false — assuming an " +
        "unresolved supplier is a test-run device and must never reach the live " +
        "write path. Set one of them back.",
    );
  }

  // Required whenever outbound mail is on, not just when the redirect is: it is
  // the address the redirect sends to, and requiring it unconditionally means
  // turning the redirect back ON is never blocked by a missing value.
  if (parsed.data.GRAPH_SEND_MAIL_ENABLED && !parsed.data.GRAPH_TEST_RECIPIENT) {
    throw new Error(
      "GRAPH_SEND_MAIL_ENABLED is true but GRAPH_TEST_RECIPIENT is not set — " +
        "set a safe internal test recipient before enabling outbound email.",
    );
  }

  // Cached BEFORE the warning below, not after: logger.warn reads LOG_LEVEL via
  // loadEnv, so warning first would re-enter this function, fail the cache check,
  // re-parse, and warn again — forever.
  cachedEnv = parsed.data;

  // Not a refusal: an empty allowlist is the CORRECT production configuration,
  // since real invoices have to be able to write. But during the pilot it is
  // almost certainly a mistake — someone cleared the fence and left live writes
  // on — and deleting a line from .env should not be able to silently widen what
  // can be written to production Prime.
  if (!cachedEnv.PRIME_DRY_RUN && cachedEnv.PRIME_TEST_WORK_ORDER_IDS.length === 0) {
    logger.warn(
      "PRIME_DRY_RUN=false with an EMPTY PRIME_TEST_WORK_ORDER_IDS — live Prime " +
        "writes are enabled for EVERY matched work order, not just test ones. " +
        "This is correct only at go-live; during pilot testing set the allowlist.",
    );
  }

  // Same shape, same reasoning, different blast radius: this one reaches people
  // outside the company and cannot be undone once sent.
  if (cachedEnv.GRAPH_SEND_MAIL_ENABLED && !cachedEnv.GRAPH_SEND_MAIL_REDIRECT_TO_TEST) {
    logger.warn(
      "GRAPH_SEND_MAIL_ENABLED=true with GRAPH_SEND_MAIL_REDIRECT_TO_TEST=false — " +
        "auto-replies will be sent to the REAL sender of each invoice, which during " +
        "the pilot means real subcontractors. This is correct only at go-live.",
    );
  }

  return cachedEnv;
}
