import { loadMigrationFiles } from "../lib/migration-files";
import { describe, expect, it } from "vitest";
import { periodontalCandidateMigrationVersion } from "./postgres/_periodontal-fixture";

const baseline = () => Array.from({ length: 40 }, (_, index) => ({
  version: String(index + 1).padStart(4, "0"), filename: `${String(index + 1).padStart(4, "0")}_baseline.sql`,
}));
const invoice = { version: "0041", filename: "0041_invoice_clinical_linkage.sql" };
const legacy = { version: "0042", filename: "0042_legacy_treatment_agreements.sql" };

const coverage = { version: "0043", filename: "0043_legacy_treatment_coverage.sql" };

describe("inactive periodontal candidate uses a reviewed collision-free test-only version", () => {
  it("accepts the exact composed 0066–0069 chain and reviewed branch variants, retaining sentinel 9000", async () => {
    const files = await loadMigrationFiles();
    expect(files).toHaveLength(63);
    expect(files[62]).toMatchObject({ version: "0069", filename: "0069_unpaid_currency_transitions.sql" });
    expect(files[61]).toMatchObject({ version: "0068", filename: "0068_collection_attempt_retirements.sql" });
    expect(files[60]).toMatchObject({ version: "0067", filename: "0067_patient_appointment_history_index.sql" });
    expect(files[59]).toMatchObject({ version: "0066", filename: "0066_agreement_delta_amendments.sql" });
    expect(files[58]).toMatchObject({ version: "0065", filename: "0065_inventory_purchase_receipts.sql" });
    expect(files[57]).toMatchObject({version:"0064",filename:"0064_approved_agreement_principal.sql"});
    expect(periodontalCandidateMigrationVersion(files)).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,62))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,61))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,60))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.filter(file => file.version !== "0067"))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.filter(file => !["0066", "0068", "0069"].includes(file.version)))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,59))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,58))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,57))).toBe("9000");
    expect(()=>periodontalCandidateMigrationVersion([...files,{version:"0067",filename:"0067_unknown.sql"}])).toThrow();
    for (let index = 40; index < files.length; index++) {
      expect(()=>periodontalCandidateMigrationVersion(files.map((file,n)=>n===index?{...file,filename:`${file.version}_unknown.sql`}:file))).toThrow();
      if(index < files.length-1 && files[index].version !== "0067") expect(()=>periodontalCandidateMigrationVersion(files.filter((_,n)=>n!==index))).toThrow();
    }
  });
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
  it("accepts only the exact composed HR/invoice chain and keeps the candidate test-only", () => {
    const hr = ["0045_hr_staff.sql", "0046_hr_tasks.sql", "0048_hr_contracts_attendance_leaves.sql", "0049_hr_payroll_disbursements.sql", "0050_hr_payroll_integrity.sql", "0056_hr_employment_history.sql", "0057_hr_schedule_policy_versions.sql", "0058_hr_temporal_write_receipts.sql"].map(filename => ({ version: filename.slice(0, 4), filename }));
    const files = [...baseline(), invoice, legacy, coverage, ...hr, {version:"0059",filename:"0059_invoice_debt_installments.sql"}, {version:"0060",filename:"0060_historical_treatment_documents.sql"}, {version:"0061",filename:"0061_invoice_correction_lineage.sql"}];
    expect(periodontalCandidateMigrationVersion(files)).toBe("0062");
    for (let index = 43; index < files.length; index++) {
      const changed = files.map((file, n) => n === index ? { ...file, filename: `${file.version}_unreviewed.sql` } : file);
      expect(() => periodontalCandidateMigrationVersion(changed)).toThrow();
      expect(() => periodontalCandidateMigrationVersion(files.filter((_, n) => n !== index))).toThrow();
    }
    const reordered = [...files]; [reordered[43], reordered[44]] = [reordered[44], reordered[43]];
    expect(() => periodontalCandidateMigrationVersion(reordered)).toThrow();
  });
});
