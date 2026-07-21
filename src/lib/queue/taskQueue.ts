import { logger } from "../../log/logger.js";

/**
 * Runs `worker` over every item with at most `concurrency` in flight at
 * once. One item's failure is logged and does not stop the rest — a single
 * malformed message shouldn't block an entire storm-day batch. Prime's own
 * concurrency cap is enforced independently inside its rate limiter; this
 * queue controls how many pipeline runs (each making their own Prime/Graph/
 * OpenRouter calls) are active at the application level.
 */
export async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const index = nextIndex++;
    if (index >= items.length) {
      return;
    }

    try {
      await worker(items[index] as T);
    } catch (error) {
      logger.error("queue item failed", { error: String(error) });
    }

    return runNext();
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
}
