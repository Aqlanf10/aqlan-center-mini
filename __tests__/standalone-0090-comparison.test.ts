import { describe, expect, it } from "vitest";
import { normalizedRegistryCountDigest as digest } from "./helpers/standalone-0090-comparison";

const original = "\n-- schema_migrations (3)\n\n-- patients (1)\nINSERT INTO patients (\"full_name\") VALUES ('synthetic-one');\n";
const addedRegistry = original.replace("schema_migrations (3)", "schema_migrations (4)");

describe("0090 witness registry-count comparison", () => {
  it("accepts only the verified generated registry-count difference", () => {
    expect(digest(original, 3)).toBe(digest(addedRegistry, 4));
  });
  it("detects a changed application row and any other table-count change", () => {
    expect(digest(original, 3)).not.toBe(digest(addedRegistry.replace("synthetic-one", "synthetic-two"), 4));
    expect(digest(original, 3)).not.toBe(digest(addedRegistry.replace("patients (1)", "patients (2)"), 4));
  });
  it("rejects missing, duplicated, malformed, or unverified count comments", () => {
    expect(() => digest(original.replace("-- schema_migrations (3)", "-- missing"), 3)).toThrow();
    expect(() => digest(`${original}\n-- schema_migrations (3)\n`, 3)).toThrow();
    expect(() => digest(original.replace("(3)", "(03)"), 3)).toThrow();
    expect(() => digest(original, 4)).toThrow();
    expect(() => digest(`${original}INSERT INTO notes VALUES ('\n-- schema_migrations (3)\n');`, 3)).toThrow();
  });
});
