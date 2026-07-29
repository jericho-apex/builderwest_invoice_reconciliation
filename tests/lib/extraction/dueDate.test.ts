import { describe, it, expect } from "vitest";
import { resolveDueDate } from "../../../src/lib/extraction/dueDate.js";

describe("resolveDueDate", () => {
  it("uses the printed due date whenever the invoice prints one", () => {
    expect(resolveDueDate("2026-07-28", "2026-08-30", 30)).toEqual({
      value: "2026-08-30",
      source: "extracted",
    });
  });

  // The case this module exists for: 26.pdf (Hutchy Ceilings) prints
  // "Due in 30 Days" in its terms column and leaves the due-date cell empty, so
  // approve.ts's pre-flight would refuse to write and route it to a human.
  it("derives the due date from payment terms when no date is printed", () => {
    expect(resolveDueDate("2026-07-28", null, 30)).toEqual({
      value: "2026-08-27",
      source: "payment_terms",
    });
  });

  it("crosses month and year boundaries correctly", () => {
    expect(resolveDueDate("2026-12-20", null, 30).value).toBe("2027-01-19");
    // 2028 is a leap year: 29 Feb exists, so +30 from 5 Feb lands on 6 Mar.
    expect(resolveDueDate("2028-02-05", null, 30).value).toBe("2028-03-06");
  });

  it("treats an empty printed due date as absent rather than as a value", () => {
    expect(resolveDueDate("2026-07-28", "", 14)).toEqual({
      value: "2026-08-11",
      source: "payment_terms",
    });
  });

  it("accepts same-day terms", () => {
    expect(resolveDueDate("2026-07-28", null, 0)).toEqual({
      value: "2026-07-28",
      source: "payment_terms",
    });
  });

  it("gives up when there is nothing to derive from", () => {
    // No terms stated.
    expect(resolveDueDate("2026-07-28", null, null)).toEqual({ value: null, source: "absent" });
    // Terms stated but no invoice date to count from.
    expect(resolveDueDate(null, null, 30)).toEqual({ value: null, source: "absent" });
    expect(resolveDueDate(null, null, null)).toEqual({ value: null, source: "absent" });
  });

  // Every refusal below routes the invoice to Exceptions/Unreadable, which is the
  // safe side: a human reads the invoice rather than Prime being sent a payment
  // date derived from something we could not actually parse.
  it("refuses an invoice date that is not an ISO calendar date", () => {
    for (const invoiceDate of ["28/07/2026", "2026-7-28", "July 28 2026", "2026-07", ""]) {
      expect(resolveDueDate(invoiceDate, null, 30)).toEqual({ value: null, source: "absent" });
    }
  });

  // Date.UTC silently rolls 2026-02-31 forward to 2026-03-03. Requiring the
  // round-trip means an impossible printed date is refused, not quietly shifted.
  it("refuses an impossible calendar date rather than rolling it over", () => {
    expect(resolveDueDate("2026-02-31", null, 30)).toEqual({ value: null, source: "absent" });
    expect(resolveDueDate("2026-13-01", null, 30)).toEqual({ value: null, source: "absent" });
  });

  it("refuses terms that are negative, fractional or implausibly long", () => {
    expect(resolveDueDate("2026-07-28", null, -30)).toEqual({ value: null, source: "absent" });
    expect(resolveDueDate("2026-07-28", null, 30.5)).toEqual({ value: null, source: "absent" });
    // Far more likely a misread invoice number than an agreement to pay in 2039.
    expect(resolveDueDate("2026-07-28", null, 4_820)).toEqual({ value: null, source: "absent" });
  });

  it("accepts terms right up to the one-year bound", () => {
    expect(resolveDueDate("2026-07-28", null, 365).value).toBe("2027-07-28");
    expect(resolveDueDate("2026-07-28", null, 366)).toEqual({ value: null, source: "absent" });
  });

  // The worker runs on Render in UTC but may be developed against anywhere; a due
  // date that shifts by a day depending on the host would be a real defect.
  it("does the arithmetic in UTC so the result cannot drift with the host timezone", () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14
      expect(resolveDueDate("2026-07-28", null, 30).value).toBe("2026-08-27");
      process.env.TZ = "Pacific/Midway"; // UTC-11
      expect(resolveDueDate("2026-07-28", null, 30).value).toBe("2026-08-27");
    } finally {
      process.env.TZ = original;
    }
  });
});
