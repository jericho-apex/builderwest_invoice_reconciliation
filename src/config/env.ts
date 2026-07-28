import { z } from "zod";

const boolFromString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const envSchema = z.object({
  // Prime Ecosystem API — production only, no sandbox tier for this pilot.
  PRIME_BASE_URL: z.string().url(),
  PRIME_CLIENT_ID: z.string().min(1),
  PRIME_CLIENT_SECRET: z.string().min(1),
  PRIME_USERNAME: z.string().min(1),
  PRIME_PASSWORD: z.string().min(1),
  PRIME_DRY_RUN: boolFromString.default("true"),
  PRIME_TEST_WORK_ORDER_ID: z.string().optional(),

  // Which queryable work-order field holds the purchase order number printed
  // on a supplier invoice. UNCONFIRMED — Prime's v2 docs do not list a PO
  // field (prime-api-gaps.md Q1), and this is now the ONLY key work-order
  // matching uses, so a wrong name means nothing ever matches. Kept as config
  // (like COST_FIELD) so the vendor's answer needs no code change. Fails safe:
  // a bad field name yields zero matches -> Exceptions/No work order.
  PRIME_WORK_ORDER_PO_FIELD: z.string().min(1).default("purchaseOrderNumber"),

  COST_TOLERANCE_MODE: z.enum(["exact", "dollar", "percentage"]).default("exact"),
  COST_TOLERANCE_VALUE: z.coerce.number().default(0),
  COST_FIELD: z.enum(["cost", "costTaxTotal"]).default("costTaxTotal"),

  // Microsoft Graph
  GRAPH_TENANT_ID: z.string().min(1),
  GRAPH_CLIENT_ID: z.string().min(1),
  GRAPH_CLIENT_SECRET: z.string().min(1),
  GRAPH_MAILBOX_ADDRESS: z.string().min(1),
  GRAPH_SEND_MAIL_ENABLED: boolFromString.default("false"),
  GRAPH_TEST_RECIPIENT: z.string().optional(),

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

  if (parsed.data.GRAPH_SEND_MAIL_ENABLED && !parsed.data.GRAPH_TEST_RECIPIENT) {
    throw new Error(
      "GRAPH_SEND_MAIL_ENABLED is true but GRAPH_TEST_RECIPIENT is not set — " +
        "set a safe internal test recipient before enabling outbound email.",
    );
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}
