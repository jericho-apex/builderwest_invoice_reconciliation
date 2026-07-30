import { describe, it, expect } from "vitest";
import { PrimeApiError, describeError } from "../../../src/lib/prime/httpClient.js";

/**
 * What a failed Prime call leaves behind in the audit trail.
 *
 * WHY THIS EXISTS. The AP-invoice create returned 500 on the live run of
 * 2026-07-30 and the only trace was `String(error)`:
 * `"PrimeApiError: Prime API request failed: POST /accounts-payable-invoices -> 500"`.
 * The status and the response body were both dropped, and Prime's 500 body is the
 * one thing that call carries — an opaque correlation id, which is precisely what
 * Prime support needs to look the crash up on their side. A 422 body is even more
 * valuable: it names every field that failed.
 *
 * So the run cost a tick and produced no evidence. These assertions are what stop
 * the next 500 doing the same.
 */
describe("describeError", () => {
  it("keeps Prime's status and response body, not just the message", () => {
    const error = new PrimeApiError(
      "Prime API request failed: POST /accounts-payable-invoices -> 500",
      500,
      { message: "Internal Error: 0d1f7c9e-3b2a-4c11-9f6d-8a5b2e4c7d90", status_code: 500 },
    );

    expect(describeError(error)).toEqual({
      error: "PrimeApiError: Prime API request failed: POST /accounts-payable-invoices -> 500",
      primeStatus: 500,
      primeResponseBody: { message: "Internal Error: 0d1f7c9e-3b2a-4c11-9f6d-8a5b2e4c7d90", status_code: 500 },
    });
  });

  // The correlation id has to survive being written to the audit table, which
  // JSON-serializes the detail — so it must be reachable from the serialized form,
  // not hidden on a non-enumerable Error property.
  it("carries the correlation id through JSON serialization", () => {
    const detail = describeError(
      new PrimeApiError("boom", 500, { message: "Internal Error: abc-123" }),
    );

    expect(JSON.stringify(detail)).toContain("Internal Error: abc-123");
  });

  // A 422 names the fields. That is the diagnostic that cracked the /attachments
  // 500 (see primeWriteBody) and it must not be thrown away either.
  it("keeps a validation body's field errors", () => {
    const detail = describeError(
      new PrimeApiError("boom", 422, {
        errors: { "attributes.dueDate": ["The attributes.due date field is required."] },
      }),
    );

    expect(detail.primeResponseBody).toMatchObject({
      errors: { "attributes.dueDate": ["The attributes.due date field is required."] },
    });
  });

  // Non-Prime failures still have to describe themselves, since the orchestrator's
  // catch is not Prime-specific.
  it("falls back to the string form for any other error", () => {
    expect(describeError(new Error("something local broke"))).toEqual({
      error: "Error: something local broke",
    });
    expect(describeError("a bare string")).toEqual({ error: "a bare string" });
  });

  // A Prime error whose body could not be parsed (fetch's .json() failing on an
  // HTML error page) must not add a misleading `primeResponseBody: undefined` key
  // that reads as "Prime returned nothing".
  it("omits the response body when there wasn't one", () => {
    const detail = describeError(new PrimeApiError("boom", 502, undefined));

    expect(detail).toEqual({ error: "PrimeApiError: boom", primeStatus: 502 });
    expect("primeResponseBody" in detail).toBe(false);
  });
});
