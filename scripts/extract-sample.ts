/**
 * Manual extraction calibration — NOT part of `npm test`.
 *
 * Runs the real extraction prompt against sample invoice PDFs and prints what
 * the model returns. This is the only way to check that the prompt actually
 * reads the client's invoice layout correctly (does it strip
 * "BWC-5126 - Wem Lane Office" down to "BWC-5126"? does it pick the issuing
 * supplier rather than "Bill to: Builderwest Pty Ltd"?), and it's the evidence
 * EXTRACTION_CONFIDENCE_THRESHOLD needs before it stops being a placeholder.
 *
 * Touches OpenRouter only — no Prime call, no Graph call, no mailbox. It does
 * write one audit_log row per run, which is why it runs migrations first.
 *
 * For the decision half — whether the pipeline then APPROVES or FLAGS each of
 * these — use `npm run pipeline:sample`, which carries on from extraction into
 * matching against a fake Prime.
 *
 * Usage:
 *   npm run extract:sample                 # all three dummy invoices in docs/
 *   npm run extract:sample -- path/to.pdf  # a specific PDF
 */
import { readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/db/migrate.js";
import { extractInvoiceFields } from "../src/lib/extraction/extractInvoice.js";
import { loadEnv } from "../src/config/env.js";
import { CLIENT_DUMMY_INVOICES } from "../tests/fixtures/clientDummyInvoices.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Sourced from the shared fixtures rather than listed here, so a new client
// sample is added in one place and both sample scripts pick it up.
const DEFAULT_SAMPLES = CLIENT_DUMMY_INVOICES.map((invoice) => join(REPO_ROOT, invoice.pdf));

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const samples = args.length > 0 ? args.map((arg) => resolve(arg)) : DEFAULT_SAMPLES;

  runMigrations();
  const env = loadEnv();
  console.log(`model: ${env.OPENROUTER_MODEL}\n`);

  for (const path of samples) {
    const filename = basename(path);
    console.log(`--- ${filename} ---`);

    const extraction = await extractInvoiceFields(readFileSync(path), filename, {});

    if (!extraction) {
      console.log("FAILED: model output did not parse against InvoiceExtractionSchema\n");
      continue;
    }

    console.log(JSON.stringify(extraction, null, 2));
    console.log("");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
