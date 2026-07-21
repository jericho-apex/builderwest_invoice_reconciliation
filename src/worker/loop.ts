import { loadEnv } from "../config/env.js";
import { PRIME_RATE_LIMITS } from "../config/constants.js";
import { getInFlightInvoices } from "../db/repositories/invoices.js";
import { pollForNewMessages } from "../lib/graph/mailbox.js";
import { runWithConcurrency } from "../lib/queue/taskQueue.js";
import { logger } from "../log/logger.js";
import { processMessage, driveInvoice } from "../pipeline/orchestrator.js";
import { handleRetryFolderMessage } from "../pipeline/retry.js";

// Matches Prime's own max-concurrent limit — going higher just means more
// pipeline runs queued up waiting on the same Prime rate limiter for no
// benefit.
const TICK_CONCURRENCY = PRIME_RATE_LIMITS.maxConcurrent;

/**
 * One full tick: resume anything orphaned by a crash, then poll for new
 * work and drain it. Exported standalone (not just via startWorkerLoop) so
 * it can be invoked directly for manual/supervised test runs.
 */
export async function runTick(): Promise<void> {
  logger.info("tick starting");

  const inFlight = getInFlightInvoices();
  if (inFlight.length > 0) {
    logger.info("resuming in-flight invoices", { count: inFlight.length });
    await runWithConcurrency(inFlight, TICK_CONCURRENCY, (invoice) => driveInvoice(invoice.id));
  }

  const { inboxMessages, retryMessages } = await pollForNewMessages();
  logger.info("poll complete", {
    inboxCount: inboxMessages.length,
    retryCount: retryMessages.length,
  });

  await runWithConcurrency(retryMessages, TICK_CONCURRENCY, handleRetryFolderMessage);
  await runWithConcurrency(inboxMessages, TICK_CONCURRENCY, processMessage);

  logger.info("tick complete");
}

export interface WorkerLoopHandle {
  stop: () => void;
}

/**
 * Sleeps for `ms` unless cancelled first — used so a shutdown signal breaks
 * the between-ticks wait immediately, rather than blocking for up to a full
 * POLL_INTERVAL_MINUTES (which could easily outlast the process manager's
 * grace period before it escalates to a hard kill).
 */
function interruptibleSleep(ms: number): { promise: Promise<void>; cancel: () => void } {
  let resolveFn!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  const timeoutHandle = setTimeout(resolveFn, ms);
  return {
    promise,
    cancel: () => {
      clearTimeout(timeoutHandle);
      resolveFn();
    },
  };
}

/** Starts the poll -> enqueue -> drain tick loop on POLL_INTERVAL_MINUTES, running until stop() is called. */
export function startWorkerLoop(): WorkerLoopHandle {
  const env = loadEnv();
  const intervalMs = env.POLL_INTERVAL_MINUTES * 60_000;
  let stopped = false;
  let cancelCurrentSleep: (() => void) | undefined;

  async function tickLoop(): Promise<void> {
    while (!stopped) {
      try {
        await runTick();
      } catch (error) {
        logger.error("tick failed", { error: String(error) });
      }

      if (stopped) {
        break;
      }

      const sleep = interruptibleSleep(intervalMs);
      cancelCurrentSleep = sleep.cancel;
      await sleep.promise;
      cancelCurrentSleep = undefined;
    }
  }

  void tickLoop();

  return {
    stop: () => {
      stopped = true;
      cancelCurrentSleep?.();
    },
  };
}
