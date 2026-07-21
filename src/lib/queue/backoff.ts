export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}

const DEFAULTS: Required<BackoffOptions> = {
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxAttempts: 5,
};

/** Exponential backoff with jitter, capped at maxDelayMs. attempt is 0-indexed. */
export function computeBackoffDelay(attempt: number, options: BackoffOptions = {}): number {
  const { baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...options };
  const exponential = baseDelayMs * 2 ** attempt;
  const capped = Math.min(exponential, maxDelayMs);
  const jitter = Math.random() * capped * 0.25;
  return capped - jitter / 2 + jitter;
}

/**
 * Retries `fn` on failures that `isRetryable` accepts, sleeping with
 * exponential backoff between attempts. Used by both the Prime and Graph
 * HTTP clients — each throttles independently and has its own Retry-After
 * semantics, but the backoff/retry shape is shared.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: BackoffOptions = {},
): Promise<T> {
  const { maxAttempts } = { ...DEFAULTS, ...options };

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === maxAttempts - 1) {
        throw error;
      }
      await sleep(computeBackoffDelay(attempt, options));
    }
  }

  // Unreachable — the loop above always either returns or throws — but
  // keeps the type checker satisfied without a non-null assertion.
  throw lastError;
}
