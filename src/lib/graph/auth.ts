import { loadEnv } from "../../config/env.js";
import { logger } from "../../log/logger.js";

interface GraphToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

const REFRESH_SKEW_MS = 60_000;
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

let cachedToken: GraphToken | undefined;
// Mutex, same rationale as Prime's auth.ts — a draining queue with several
// concurrent Graph calls must never race multiple token refreshes near expiry.
let refreshInFlight: Promise<GraphToken> | undefined;

interface GraphTokenResponse {
  access_token: string;
  expires_in: number; // seconds
}

/**
 * Microsoft Graph client-credentials (app-only) flow — no human mailbox
 * login. Standard Microsoft identity platform v2.0 token endpoint; unlike
 * Prime's auth, this shape is fully documented and not a guess.
 */
async function fetchNewToken(): Promise<GraphToken> {
  const env = loadEnv();
  const tokenUrl = `https://login.microsoftonline.com/${env.GRAPH_TENANT_ID}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.GRAPH_CLIENT_ID,
    client_secret: env.GRAPH_CLIENT_SECRET,
    scope: GRAPH_SCOPE,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "<no body>");
    throw new Error(`Graph token request failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as GraphTokenResponse;
  logger.info("graph token refreshed", { expiresInSeconds: data.expires_in });

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function getGraphAccessToken(): Promise<string> {
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
