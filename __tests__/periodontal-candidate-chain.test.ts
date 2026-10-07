import { describe, expect, it } from "vitest";
import { periodontalCandidateMigrationVersion } from "./postgres/_periodontal-fixture";

const baseline = () => Array.from({ length: 40 }, (_, index) => ({
  version: String(index + 1).padStart(4, "0"), filename: `${String(index + 1).padStart(4, "0")}_baseline.sql`,
}));
const invoice = { version: "0041", filename: "0041_invoice_clinical_linkage.sql" };
const legacy = { version: "0042", filename: "0042_legacy_treatment_agreements.sql" };

describe("inactive periodontal candidate uses a reviewed collision-free test-only version", () => {
  it("keeps the pre-invoice baseline at test-only 0041", () => {
    expect(periodontalCandidateMigrationVersion(baseline())).toBe("0041");
  });
  it("preserves invoice 0041 and proposes test-only 0042", () => {
    expect(periodontalCandidateMigrationVersion([...baseline(), invoice])).toBe("0042");
  });
  it("preserves legacy 0042 when present and proposes test-only 0043", () => {
    expect(periodontalCandidateMigrationVersion([...baseline(), invoice, legacy])).toBe("0043");
  });
  it("does not weaken gap, ordering, suffix or future-baseline guards", () => {
    expect(() => periodontalCandidateMigrationVersion(baseline().slice(1))).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline().slice(0, 39), invoice])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), legacy])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), { ...invoice, filename: "0041_unreviewed.sql" }])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, { version: "0043", filename: "0043_future.sql" }])).toThrow();
  });
});
