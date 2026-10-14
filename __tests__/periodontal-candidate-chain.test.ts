import { describe, expect, it } from "vitest";
import { periodontalCandidateMigrationVersion } from "./postgres/_periodontal-fixture";

const baseline = () => Array.from({ length: 40 }, (_, index) => ({
  version: String(index + 1).padStart(4, "0"), filename: `${String(index + 1).padStart(4, "0")}_baseline.sql`,
}));
const invoice = { version: "0041", filename: "0041_invoice_clinical_linkage.sql" };
const legacy = { version: "0042", filename: "0042_legacy_treatment_agreements.sql" };

const coverage = { version: "0043", filename: "0043_legacy_treatment_coverage.sql" };

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
  it("preserves immutable coverage0043 and selects only test-only0044", () => {
    expect(periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, coverage])).toBe("0044");
  });
  it("does not weaken gap, ordering, suffix or future-baseline guards", () => {
    expect(() => periodontalCandidateMigrationVersion(baseline().slice(1))).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, coverage])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, legacy])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, { ...coverage, filename: "0043_unreviewed.sql" }])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, coverage, { version: "0044", filename: "0044_future.sql" }])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline().slice(0, 39), invoice])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), legacy])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), { ...invoice, filename: "0041_unreviewed.sql" }])).toThrow();
    expect(() => periodontalCandidateMigrationVersion([...baseline(), invoice, legacy, { version: "0043", filename: "0043_future.sql" }])).toThrow();
  });
  it("recognizes only the root-allocated0059 extension without filling reserved gaps",()=>{
    const files=[...baseline(),invoice,legacy,coverage,{version:"0059",filename:"0059_invoice_debt_installments.sql"}];
    expect(periodontalCandidateMigrationVersion(files)).toBe("0060");
    expect(periodontalCandidateMigrationVersion([...files,{version:"0060",filename:"0060_historical_treatment_documents.sql"}])).toBe("0061");
    const corrections=[...files,{version:"0060",filename:"0060_historical_treatment_documents.sql"},{version:"0061",filename:"0061_invoice_correction_lineage.sql"}];
    expect(periodontalCandidateMigrationVersion(corrections)).toBe("0062");
    expect(()=>periodontalCandidateMigrationVersion([...corrections.slice(0,-1),{version:"0061",filename:"0061_unreviewed.sql"}])).toThrow();
    expect(()=>periodontalCandidateMigrationVersion([...files,{version:"0060",filename:"0060_unreviewed.sql"}])).toThrow();
    expect(()=>periodontalCandidateMigrationVersion([...files.slice(0,43),{version:"0059",filename:"0059_unreviewed.sql"}])).toThrow();
  });
});
