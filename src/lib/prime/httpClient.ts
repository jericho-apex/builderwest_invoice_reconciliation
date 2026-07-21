import { loadEnv } from "../../config/env.js";
import { MAX_TRANSIENT_RETRIES } from "../../config/constants.js";
import { retryWithBackoff } from "../queue/backoff.js";
import { getPrimeAccessToken } from "./auth.js";
import { PrimeRateLimiter } from "./rateLimiter.js";

// Single shared instance for the process — this worker runs as one
// long-lived instance (Render Background Worker, numInstances: 1), so one
// in-memory rate limiter correctly represents the whole app's Prime usage.
const rateLimiter = new PrimeRateLimiter();

export class PrimeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "PrimeApiError";
  }
}

export function isRetryablePrimeError(error: unknown): boolean {
  if (error instanceof PrimeApiError) {
    return error.status === 429 || error.status >= 500;
  }
  // Network-level failures (fetch throws a TypeError on connection failure).
  return error instanceof TypeError;
}

interface PrimeRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Set when the body is already form/multipart-encoded and must not be JSON.stringify'd. */
  rawBody?: BodyInit;
}

/**
 * Low-level Prime v2 REST call: auth, required Accept header, rate limiting,
 * and retry-with-backoff on transient failures (429/5xx/network). Callers
 * (workOrders.ts, contacts.ts, apInvoices.ts, attachments.ts) own audit
 * logging and dry-run gating for write operations — this layer is
 * transport-only and reusable for both reads and writes.
 */
export async function primeRequest<T>(options: PrimeRequestOptions): Promise<T> {
  const env = loadEnv();

  return retryWithBackoff(
    async () => {
      const release = await rateLimiter.acquire();
      try {
        const url = new URL(options.path, env.PRIME_BASE_URL);
        for (const [key, value] of Object.entries(options.query ?? {})) {
          if (value !== undefined) {
            url.searchParams.set(key, value);
          }
        }

        const token = await getPrimeAccessToken();
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.api.v2+json",
        };

        let body: BodyInit | undefined;
        if (options.rawBody !== undefined) {
          body = options.rawBody;
        } else if (options.body !== undefined) {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(options.body);
        }

        const response = await fetch(url, {
          method: options.method ?? "GET",
          headers,
          body,
        });

        if (!response.ok) {
          const responseBody = await response.json().catch(() => undefined);
          throw new PrimeApiError(
            `Prime API request failed: ${options.method ?? "GET"} ${options.path} -> ${response.status}`,
            response.status,
            responseBody,
          );
        }

        if (response.status === 204) {
          return undefined as T;
        }
        return (await response.json()) as T;
      } finally {
        release();
      }
    },
    isRetryablePrimeError,
    { maxAttempts: MAX_TRANSIENT_RETRIES },
  );
}
