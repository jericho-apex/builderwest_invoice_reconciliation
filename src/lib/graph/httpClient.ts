import { MAX_TRANSIENT_RETRIES } from "../../config/constants.js";
import { computeBackoffDelay, sleep } from "../queue/backoff.js";
import { getGraphAccessToken } from "./auth.js";

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";

export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

function isRetryableGraphError(error: unknown): boolean {
  if (error instanceof GraphApiError) {
    return error.status === 429 || error.status >= 500;
  }
  return error instanceof TypeError;
}

interface GraphRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

/**
 * Low-level Graph v1.0 call: app-only auth + retry with backoff on
 * transient failures. Graph throttles independently from Prime, with its
 * own `Retry-After` semantics — honored here in preference to a blind
 * exponential delay whenever the header is present.
 */
export async function graphRequest<T>(options: GraphRequestOptions): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_TRANSIENT_RETRIES; attempt++) {
    try {
      const url = new URL(options.path, GRAPH_BASE_URL);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined) {
          url.searchParams.set(key, value);
        }
      }

      const token = await getGraphAccessToken();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };

      let body: string | undefined;
      if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(options.body);
      }

      const response = await fetch(url, { method: options.method ?? "GET", headers, body });

      if (!response.ok) {
        const responseBody = await response.json().catch(() => undefined);
        const retryAfterHeader = response.headers.get("Retry-After");
        throw new GraphApiError(
          `Graph API request failed: ${options.method ?? "GET"} ${options.path} -> ${response.status}`,
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
      if (!isRetryableGraphError(error) || attempt === MAX_TRANSIENT_RETRIES - 1) {
        throw error;
      }

      const delayMs =
        error instanceof GraphApiError && error.retryAfterSeconds !== undefined
          ? error.retryAfterSeconds * 1000
          : computeBackoffDelay(attempt);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
