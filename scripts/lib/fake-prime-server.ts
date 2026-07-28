/**
 * A throwaway loopback stand-in for Prime, so scripts/pipeline-sample.ts can run
 * the real matching stack without touching production.
 *
 * There is no Prime sandbox, and PRIME_DRY_RUN only gates WRITES — reads go
 * straight out. Rather than mock the finder functions (which would skip
 * buildEqQuery, primeRequest, the JSON:API Accept header and mapWorkOrder's
 * dollars->cents conversion — none of which any test currently exercises), this
 * stubs at the transport layer: point PRIME_BASE_URL at it and every layer above
 * runs unmodified.
 *
 * What green output here does and does not mean: the response shapes and the
 * OAuth password-grant contract below encode OUR assumptions, both flagged
 * unverified in prime/auth.ts and docs/prime-api-gaps.md. A pass proves our code
 * is self-consistent, not that Prime behaves this way.
 */
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import type { PRIME_CONTACTS, PRIME_WORK_ORDERS } from "../../tests/fixtures/clientDummyInvoices.js";

/** Every request the pipeline made, in order — the demo's wire-level evidence. */
export interface RecordedRequest {
  method: string;
  path: string;
  q: string | null;
  matchCount: number;
}

export interface FakePrime {
  /** Value to assign to PRIME_BASE_URL. */
  baseUrl: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export interface FakePrimeFixtures {
  workOrders: typeof PRIME_WORK_ORDERS;
  contacts: typeof PRIME_CONTACTS;
  /** Which work-order field carries the PO — mirrors PRIME_WORK_ORDER_PO_FIELD. */
  purchaseOrderField: string;
}

const API_PREFIX = "/api/prime/v2";

/** Inverse of lib/prime/query.ts's buildEqQuery: `'field'.eq('value')`, quotes un-doubled. */
function parseEqQuery(q: string): { field: string; value: string } | undefined {
  const match = /^'((?:[^']|'')+)'\.eq\('((?:[^']|'')*)'\)$/.exec(q);
  if (!match) {
    return undefined;
  }
  return { field: match[1]!.replace(/''/g, "'"), value: match[2]!.replace(/''/g, "'") };
}

export async function startFakePrime(fixtures: FakePrimeFixtures): Promise<FakePrime> {
  const requests: RecordedRequest[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const method = req.method ?? "GET";

    const send = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "Content-Type": "application/vnd.api.v2+json",
        "Content-Length": Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    if (method === "POST" && path === `${API_PREFIX}/oauth/token`) {
      requests.push({ method, path, q: null, matchCount: 0 });
      req.resume(); // drain the form body we don't need
      send(200, { access_token: "fake-token", expires_in: 3600 });
      return;
    }

    const isWorkOrders = path === `${API_PREFIX}/work-orders`;
    const isContacts = path === `${API_PREFIX}/contacts`;
    if (method !== "GET" || (!isWorkOrders && !isContacts)) {
      // Writes must never arrive: PRIME_DRY_RUN=true short-circuits them before
      // transport. If one does, fail loudly rather than pretend to accept it.
      send(404, { errors: [{ detail: `fake Prime has no route for ${method} ${path}` }] });
      return;
    }

    const q = url.searchParams.get("q");
    const parsed = q ? parseEqQuery(q) : undefined;
    if (!parsed) {
      // A stub that ignores `q` would return PO99999 a work order and silently
      // untest invoice 3. Reject rather than guess.
      requests.push({ method, path, q, matchCount: 0 });
      send(400, { errors: [{ detail: `unparseable q: ${q ?? "<missing>"}` }] });
      return;
    }

    const data = isWorkOrders
      ? fixtures.workOrders
          .filter((w) =>
            parsed.field === fixtures.purchaseOrderField
              ? w.purchaseOrderNumber === parsed.value
              : false,
          )
          .map((w) => ({ id: w.id, attributes: w.attributes }))
      : fixtures.contacts
          .filter((c) => {
            if (parsed.field === "name") return c.attributes.name === parsed.value;
            if (parsed.field === "abn") return c.attributes.abn === parsed.value;
            return false;
          })
          .map((c) => ({ id: c.id, attributes: c.attributes }));

    requests.push({ method, path, q, matchCount: data.length });
    send(200, { data });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}${API_PREFIX}`,
    requests,
    close: () => new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
  };
}
