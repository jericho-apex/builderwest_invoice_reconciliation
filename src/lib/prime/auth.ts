import { loadEnv } from "../../config/env.js";
import { logger } from "../../log/logger.js";

interface PrimeToken {
  accessToken: string;
  /** Epoch ms when the token expires. */
  expiresAt: number;
}

// Refresh this many seconds before actual expiry, to absorb request latency.
const REFRESH_SKEW_MS = 60_000;

let cachedToken: PrimeToken | undefined;
// Acts as a mutex: concurrent callers await the SAME in-flight refresh
// instead of each firing their own — a draining queue with several
// concurrent requests must never race multiple token refreshes near expiry.
let refreshInFlight: Promise<PrimeToken> | undefined;

interface PrimeTokenResponse {
  access_token: string;
  expires_in: number; // seconds
}

/**
 * OAuth2 password grant against Prime's auth endpoint (PRD §5.1: client_id +
 * client_secret + username + password -> bearer token).
 *
 * VERIFIED LIVE 2026-07-28 against production Prime: `POST {api_uri}/oauth/token`
 * with the form fields below returns 200 and
 * `{ token_type, expires_in, access_token, refresh_token }` (expires_in 21600s
 * = 6h), and the resulting bearer is accepted on `/work-orders` and
 * `/contacts`. The `Accept: application/vnd.api.v2+json` header is documented
 * as required on the token request too, not just on resource calls.
 */
async function fetchNewToken(): Promise<PrimeToken> {
  const env = loadEnv();
  // NB: concatenate, don't use `new URL("/oauth/token", base)` — a leading-slash
  // path resets to the host root and drops PRIME_BASE_URL's "/api.prime/v2"
  // path segment entirely. Confirmed live: the host-root path 404s, the full
  // base URL + "/oauth/token" is the one that issues a token.
  const tokenUrl = new URL(`${env.PRIME_BASE_URL.replace(/\/$/, "")}/oauth/token`);

  const body = new URLSearchParams({
    grant_type: "password",
    client_id: env.PRIME_CLIENT_ID,
    client_secret: env.PRIME_CLIENT_SECRET,
    username: env.PRIME_USERNAME,
    password: env.PRIME_PASSWORD,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/vnd.api.v2+json",
    },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "<no body>");
    throw new Error(`Prime token request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as PrimeTokenResponse;
  logger.info("prime token refreshed", { expiresInSeconds: data.expires_in });

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/** Returns a valid Prime bearer token, refreshing (and deduping concurrent refreshes) as needed. */
export async function getPrimeAccessToken(): Promise<string> {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt - REFRESH_SKEW_MS > now) {
    return cachedToken.accessToken;
  }

  if (!refreshInFlight) {
    refreshInFlight = fetchNewToken().finally(() => {
      refreshInFlight = undefined;
    });
  }

  cachedToken = await refreshInFlight;
  return cachedToken.accessToken;
}
