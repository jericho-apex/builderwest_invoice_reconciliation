import { sleep } from "../queue/backoff.js";
import { PRIME_RATE_LIMITS } from "../../config/constants.js";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 250;

/**
 * Sliding-window + concurrency limiter tuned to Prime's published limits
 * (60 calls/min, 5 concurrent, 5,000/day). A 150-200 invoice storm-day burst
 * is ~1,000-1,400 calls, which this drains steadily over ~15-20 minutes
 * rather than slamming the API. Single shared instance across the process —
 * this is a single long-lived worker (Render Background Worker), not a pool
 * of processes, so one in-memory limiter is the correct model.
 */
export class PrimeRateLimiter {
  private readonly recentCallTimestamps: number[] = [];
  private readonly dailyCallTimestamps: number[] = [];
  private activeCalls = 0;

  /** Blocks until a slot is available, then reserves it. Call the returned function when the request completes. */
  async acquire(): Promise<() => void> {
    for (;;) {
      this.prune();

      const hasConcurrencySlot = this.activeCalls < PRIME_RATE_LIMITS.maxConcurrent;
      const hasMinuteSlot = this.recentCallTimestamps.length < PRIME_RATE_LIMITS.callsPerMinute;
      const hasDailySlot = this.dailyCallTimestamps.length < PRIME_RATE_LIMITS.callsPerDay;

      if (hasConcurrencySlot && hasMinuteSlot && hasDailySlot) {
        const now = Date.now();
        this.recentCallTimestamps.push(now);
        this.dailyCallTimestamps.push(now);
        this.activeCalls++;
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.activeCalls--;
        };
      }

      await sleep(POLL_INTERVAL_MS);
    }
  }

  private prune(): void {
    const now = Date.now();
    this.pruneOlderThan(this.recentCallTimestamps, now - MINUTE_MS);
    this.pruneOlderThan(this.dailyCallTimestamps, now - DAY_MS);
  }

  private pruneOlderThan(timestamps: number[], cutoff: number): void {
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }
  }
}
