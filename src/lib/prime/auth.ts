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
 * ASSUMPTION FLAGGED FOR VERIFICATION: the exact token endpoint path and
 * response field names below follow the standard OAuth2 Resource Owner
 * Password Credentials shape, since the PRD excerpt available while building
 * this did not specify Prime's exact endpoint path. Confirm this against
 * Prime's actual API reference (from the vendor) before relying on it — if
 * the path or field names differ, only this function needs to change.
 */
async function fetchNewToken(): Promise<PrimeToken> {
  const env = loadEnv();
  // NB: concatenate, don't use `new URL("/oauth/token", base)` — a leading-slash
  // path resets to the host root and drops PRIME_BASE_URL's "/api/prime/v2"
  // path segment entirely (verified against the base URL in .env.example).
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
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
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
