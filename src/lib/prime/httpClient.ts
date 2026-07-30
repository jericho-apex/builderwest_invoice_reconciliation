import { loadEnv } from "../../config/env.js";
import { MAX_TRANSIENT_RETRIES } from "../../config/constants.js";
import { computeBackoffDelay, sleep } from "../queue/backoff.js";
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
    /** Seconds from Prime's `retry-after` header on a 429, if present. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "PrimeApiError";
  }
}

/**
 * Wraps a write payload in the envelope Prime's write endpoints require:
 * `{ attributes: { ... } }`.
 *
 * VERIFIED LIVE 2026-07-30, against production, on `POST /attachments`:
 *
 * - `{ attributes: {...} }`            -> 200, record created
 * - `{ ...fields }` (flat)             -> 500 Internal Error
 * - `{ data: { type, attributes } }`   -> 500 Internal Error
 *
 * The last one is the trap. Prime v2 speaks JSON:API on the way OUT — every read
 * in this client pulls fields from `data.attributes` — so the full JSON:API
 * envelope is the natural guess on the way IN, and it fails exactly as hard as
 * sending nothing at all.
 *
 * Why this cost a live run to find: Prime answers a *validation* failure with a
 * clean 422 naming each field (`"The attributes.file name field is required."` —
 * note the `attributes.` prefix, which is where the answer was hiding). But a flat
 * body does not fail validation, it crashes the handler before validation runs, and
 * the 500 body is nothing but an opaque correlation id. So the failure carried no
 * signal at all, while the empty-body 422 carried the whole answer.
 *
 * It lives here, next to primeRequest, because it is a property of Prime's
 * transport rather than of any one resource — and it is a named function rather
 * than an inline `{ attributes: body }` at three call sites so the evidence above
 * has somewhere to live.
 */
export function primeWriteBody(attributes: Record<string, unknown>): {
  attributes: Record<string, unknown>;
} {
  return { attributes };
}

/**
 * What to record when a call fails — `String(error)` plus, for a Prime failure, the
 * two things it actually carries.
 *
 * WHY THIS EXISTS. The AP-invoice create 500'd on the live run of 2026-07-30 and the
 * audit row held one string: "PrimeApiError: Prime API request failed: POST
 * /accounts-payable-invoices -> 500". The status and the response body were both
 * dropped by `String(error)` — and Prime's 500 body is the only content that call
 * returns: `{"message":"Internal Error: <uuid>"}`, the correlation id Prime support
 * needs to look the crash up on their side. A 422 body is worth even more, since it
 * names every field that failed. So the tick burned a live run and produced no
 * evidence of what Prime objected to.
 *
 * It lives here because PrimeApiError does, and takes `unknown` because the callers
 * that need it (the orchestrator's catch) are not Prime-specific.
 */
export function describeError(error: unknown): {
  error: string;
  primeStatus?: number;
  primeResponseBody?: unknown;
} {
  if (!(error instanceof PrimeApiError)) {
    return { error: String(error) };
  }
  return {
    error: String(error),
    primeStatus: error.status,
    // Omitted rather than set to undefined when Prime's body could not be parsed:
    // a `primeResponseBody: null` in the audit trail reads as "Prime answered with
    // nothing", which is a different fact from "we could not read the answer".
    ...(error.body === undefined ? {} : { primeResponseBody: error.body }),
  };
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
  // Concatenate onto the full base URL rather than `new URL(path, base)`:
  // a leading-slash path would reset to the host root and silently drop
  // PRIME_BASE_URL's "/api/prime/v2" segment.
  const base = env.PRIME_BASE_URL.replace(/\/$/, "");

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
    const release = await rateLimiter.acquire();
    try {
      const url = new URL(`${base}${options.path}`);
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

      const response = await fetch(url, { method: options.method ?? "GET", headers, body });

      if (!response.ok) {
        const responseBody = await response.json().catch(() => undefined);
        const retryAfterHeader = response.headers.get("retry-after");
        throw new PrimeApiError(
          `Prime API request failed: ${options.method ?? "GET"} ${options.path} -> ${response.status}`,
          response.status,
          responseBody,
          retryAfterHeader ? Number(retryAfterHeader) : undefined,
        );
      }

      if (response.status === 204) {
        return undefined as T;
      }
      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      if (!isRetryablePrimeError(error) || attempt === MAX_TRANSIENT_RETRIES - 1) {
        throw error;
      }
      // Prime documents a `retry-after` header on 429 — honor it in preference
      // to a blind exponential delay when present (matches the Graph client).
      const delayMs =
        error instanceof PrimeApiError && error.retryAfterSeconds !== undefined
          ? error.retryAfterSeconds * 1000
          : computeBackoffDelay(attempt);
      await sleep(delayMs);
    } finally {
      release();
    }
  }

  throw lastError;
}
