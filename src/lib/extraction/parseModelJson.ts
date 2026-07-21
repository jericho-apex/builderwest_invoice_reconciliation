import type { ZodType } from "zod";

/**
 * Parses a model's raw text response as JSON and validates it against the
 * given schema. Strips a markdown code fence if the model wrapped its JSON
 * in one despite being told not to. Returns undefined (never throws) on any
 * parse or validation failure — callers treat that the same as a
 * low-confidence result, routing to Exceptions/Unreadable rather than
 * guessing.
 */
export function parseModelJson<T>(raw: string, schema: ZodType<T>): T | undefined {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/```$/, "")
    .trim();

  try {
    const json: unknown = JSON.parse(stripped);
    const result = schema.safeParse(json);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}
