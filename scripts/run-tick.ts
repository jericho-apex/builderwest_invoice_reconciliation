/**
 * Runs exactly ONE worker tick and exits — the manual trigger for a supervised
 * end-to-end run. NOT part of `npm test`.
 *
 * runTick() is exported from worker/loop.ts precisely so it can be driven this
 * way; the alternative is `npm run dev`, which starts the POLL_INTERVAL_MINUTES
 * loop and has to be interrupted by hand at the right moment. For a supervised
 * test you want one tick, deterministically, with the process ending afterwards.
 *
 * This is the FULL pipeline: real Graph poll, real folder moves, real OpenRouter
 * extraction, real Prime reads, and real Prime WRITES unless PRIME_DRY_RUN is on.
 * It is the only runner that can change anything outside this repo.
 *
 * Two guards, because a manual trigger is easy to fire without re-reading the env:
 *
 *   1. It prints the mode banner BEFORE doing anything, so a run against
 *      production with writes enabled is never a surprise after the fact.
 *   2. Live writes with an EMPTY PRIME_TEST_WORK_ORDER_IDS is refused outright.
 *      loadEnv() only warns there, which is right for the deployed worker (an
 *      empty fence IS the go-live setting) but wrong for an ad-hoc local trigger
 *      against a live mailbox: a genuine supplier invoice arriving mid-test would
 *      be approved and pushed. --unfenced is the deliberate override.
 *
 * Usage:
 *   npm run tick:once              # one tick, honouring .env.local
 *   npm run tick:once -- --unfenced  # allow live writes with no work-order fence
 */
import { runMigrations } from "../src/db/migrate.js";
import { loadEnv } from "../src/config/env.js";
import { runTick } from "../src/worker/loop.js";
import { getInFlightInvoices } from "../src/db/repositories/invoices.js";

async function main(): Promise<void> {
  const unfenced = process.argv.slice(2).includes("--unfenced");

  runMigrations();
  const env = loadEnv();

  const writeMode = env.PRIME_DRY_RUN
    ? "DRY RUN — no Prime write endpoint will be called"
    : "*** LIVE WRITES TO PRODUCTION PRIME ***";
  const fence =
    env.PRIME_TEST_WORK_ORDER_IDS.length > 0
      ? env.PRIME_TEST_WORK_ORDER_IDS.join(", ")
      : "(empty = UNRESTRICTED)";

  console.log("--- one worker tick ---");
  console.log(`  prime writes:     ${writeMode}`);
  console.log(`  write fence:      ${fence}`);
  console.log(`  prime base url:   ${env.PRIME_BASE_URL}`);
  console.log(`  mailbox:          ${env.GRAPH_MAILBOX_ADDRESS}`);
  console.log(
    `  send mail:        ${env.GRAPH_SEND_MAIL_ENABLED}` +
      (env.GRAPH_SEND_MAIL_ENABLED
        ? env.GRAPH_SEND_MAIL_REDIRECT_TO_TEST
          ? ` (redirected to ${env.GRAPH_TEST_RECIPIENT})`
          : " *** REPLIES GO TO REAL SUPPLIERS ***"
        : ""),
  );
  console.log(`  assume supplier:  ${env.ASSUME_SUPPLIER_MATCHED}`);
  console.log(`  cost:             ${env.COST_FIELD} / ${env.COST_TOLERANCE_MODE}`);
  console.log(`  model:            ${env.OPENROUTER_MODEL}`);
  console.log(`  in-flight to resume: ${getInFlightInvoices().length}`);
  console.log("");

  if (!env.PRIME_DRY_RUN && env.PRIME_TEST_WORK_ORDER_IDS.length === 0 && !unfenced) {
    console.error(
      "REFUSING TO RUN: PRIME_DRY_RUN=false with an empty PRIME_TEST_WORK_ORDER_IDS.\n" +
        "Every invoice in the mailbox would be written to production Prime, including any\n" +
        "genuine supplier invoice that happens to arrive during the run. Either set the\n" +
        "fence to the test work orders, or pass --unfenced if that is genuinely intended.",
    );
    process.exitCode = 1;
    return;
  }

  await runTick();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
