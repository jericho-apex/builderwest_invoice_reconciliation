import { describe, it, expect } from "vitest";
import { parseModelJson } from "../../../src/lib/extraction/parseModelJson.js";
import { ClassificationSchema } from "../../../src/lib/extraction/schemas.js";

describe("parseModelJson", () => {
  it("parses plain JSON matching the schema", () => {
    const result = parseModelJson('{"category":"invoice","confidence":0.95}', ClassificationSchema);
    expect(result).toEqual({ category: "invoice", confidence: 0.95 });
  });

  it("strips a markdown code fence the model wasn't supposed to add", () => {
    const result = parseModelJson(
      '```json\n{"category":"job_note","confidence":0.6}\n```',
      ClassificationSchema,
    );
    expect(result).toEqual({ category: "job_note", confidence: 0.6 });
  });

  it("returns undefined (never throws) on malformed JSON — routes to the exception path, not a crash", () => {
    expect(parseModelJson("this is not json", ClassificationSchema)).toBeUndefined();
  });

  it("returns undefined when the JSON is valid but doesn't match the schema (e.g. an invalid enum value)", () => {
    const result = parseModelJson('{"category":"not_a_real_category","confidence":0.5}', ClassificationSchema);
    expect(result).toBeUndefined();
  });

  it("returns undefined when confidence is out of the valid 0-1 range", () => {
    const result = parseModelJson('{"category":"invoice","confidence":1.5}', ClassificationSchema);
    expect(result).toBeUndefined();
  });
});
