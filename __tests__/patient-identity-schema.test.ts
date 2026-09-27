import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATIENT_IDENTITY_SQL } from "../lib/patient-identity-schema";

describe("(PAT-3) patient identity schema", () => {
  it("keeps migration 0028 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0028_patient_identity.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(PATIENT_IDENTITY_SQL.trim());
  });
});
