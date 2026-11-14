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
  it("accepts the complete saved-study, space and retention journal chain and rejects missing or renamed dependencies", async () => {
    const files = await loadMigrationFiles();
    expect(files).toHaveLength(97);
    expect(() => periodontalCandidateMigrationVersion(files.filter(file => file.version !== "0106"))).toThrow();
    expect(files.at(-1)?.filename).toBe("0132_ortho_adjustment_auxiliaries.sql");
    expect(files.at(-2)?.filename).toBe("0128_expense_commands.sql");
    expect(files.at(-3)?.filename).toBe("0126_commission_case_participations.sql");
    expect(periodontalCandidateMigrationVersion(files)).toBe("9000");
    // 0126 follows the reviewed tail 0125 on the composed chain; it never fills a removed predecessor.
    expect(() => periodontalCandidateMigrationVersion(files.filter(file => file.version !== "0125"))).toThrow();
    // 0128 follows 0126 directly and 0132 follows 0128; 0127 and 0129–0131 are never filled here.
    expect(() => periodontalCandidateMigrationVersion(files.filter(file => file.version !== "0126"))).toThrow();
    expect(periodontalCandidateMigrationVersion(files.filter(file => file.version !== "0132"))).toBe("9000");
    // Heads pushed before 0128 existed: 0132 directly after 0126.
    expect(periodontalCandidateMigrationVersion(files.filter(file => file.version !== "0128"))).toBe("9000");
    expect(() => periodontalCandidateMigrationVersion([...files.filter(file => file.version !== "0132"), files.at(-3)!])).toThrow();
    expect(files.slice(-11, -3).map(file => file.filename)).toEqual([
      "0118_ortho_problem_source_submissions.sql",
      "0119_ortho_space_ledger.sql",
      "0120_ortho_space_submissions.sql",
      "0121_ortho_retention_ledger.sql",
      "0122_ortho_retention_submissions.sql",
      "0123_ortho_study_export_archive.sql",
      "0124_ceph_correction_lineage.sql",
      "0125_ortho_case_reopen.sql",
    ]);
    // Every dependency remains mandatory when its successor is present.
    for (const version of ["0090", "0091", "0092", "0093", "0117", "0118", "0119", "0120", "0121", "0122", "0123", "0124", "0125", "0126"]) {
      expect(() => periodontalCandidateMigrationVersion(files.filter(file => file.version !== version))).toThrow();
    }
    // Reviewed intermediate tails remain valid without admitting unknown successors.
    for (const version of ["0118", "0119", "0120", "0121", "0122", "0123", "0124", "0125"]) {
      expect(periodontalCandidateMigrationVersion(files.filter(file => file.version <= version))).toBe("9000");
    }

    expect(() => periodontalCandidateMigrationVersion(files.filter(file => file.version !== "0111"))).toThrow();
    for (const version of ["0074", "0079", "0080", "0081", "0082", "0090", "0091", "0092", "0093", "0106", "0110", "0111", "0112", "0113", "0114", "0115", "0116", "0117", "0118", "0119", "0120", "0121", "0122", "0123", "0124", "0125", "0126", "0128", "0132"]) {
      expect(() => periodontalCandidateMigrationVersion(files.map(file => file.version === version
        ? { ...file, filename: `${version}_unknown.sql` } : file))).toThrow();
    }
  });

  it("accepts the exact composed 0066–0069 chain and reviewed branch variants, retaining sentinel 9000", async () => {
    // The orthodontic/Rx chain without the finance additions (0074, 0079–0082, 0126) and 0132, which follows 0126.
    const files = (await loadMigrationFiles()).filter(file => !["0074", "0079", "0080", "0081", "0082", "0090", "0091", "0092", "0093", "0106", "0110", "0111", "0112", "0113", "0114", "0115", "0116", "0117", "0118", "0119", "0120", "0121", "0122", "0123", "0124", "0125", "0126", "0128", "0132"].includes(file.version));
    expect(files).toHaveLength(68);
    expect(files[67]).toMatchObject({ version: "0109", filename: "0109_ortho_adjustment_requests.sql" });
    expect(files[66]).toMatchObject({ version: "0108", filename: "0108_ortho_assessment_intake.sql" });
    expect(files[65]).toMatchObject({ version: "0089", filename: "0089_lab_shade_specification.sql" });
    expect(files[64]).toMatchObject({ version: "0087", filename: "0087_agreement_reminder_metadata.sql" });
    expect(files[63]).toMatchObject({ version: "0078", filename: "0078_agreement_reconciliation.sql" });
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
    expect(periodontalCandidateMigrationVersion(files.filter(file => !["0066", "0068", "0069", "0078", "0087", "0089"].includes(file.version)))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,59))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,58))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,57))).toBe("9000");
    expect(()=>periodontalCandidateMigrationVersion([...files,{version:"0067",filename:"0067_unknown.sql"}])).toThrow();
    for (let index = 40; index < files.length; index++) {
      expect(()=>periodontalCandidateMigrationVersion(files.map((file,n)=>n===index?{...file,filename:`${file.version}_unknown.sql`}:file))).toThrow();
      if(index < files.length-1 && !["0067", "0089", "0108"].includes(files[index].version)) expect(()=>periodontalCandidateMigrationVersion(files.filter((_,n)=>n!==index))).toThrow();
    }
  });
  it("accepts the finance chain (0074, 0079–0082, 0126) without the orthodontic/Rx additions, retaining sentinel 9000", async () => {
    const files = (await loadMigrationFiles()).filter(file => !["0090", "0091", "0092", "0093", "0106", "0108", "0109", "0110", "0111", "0112", "0113", "0114", "0115", "0116", "0117", "0118", "0119", "0120", "0121", "0122", "0123", "0124", "0125", "0132"].includes(file.version));
    expect(files).toHaveLength(73);
    expect(files[72]).toMatchObject({ version: "0128", filename: "0128_expense_commands.sql" });
    expect(files[71]).toMatchObject({ version: "0126", filename: "0126_commission_case_participations.sql" });
    expect(files[70]).toMatchObject({ version: "0089", filename: "0089_lab_shade_specification.sql" });
    expect(files[69]).toMatchObject({ version: "0087", filename: "0087_agreement_reminder_metadata.sql" });
    expect(files[68]).toMatchObject({ version: "0082", filename: "0082_invoice_service_additions.sql" });
    expect(files[67]).toMatchObject({ version: "0081", filename: "0081_invoice_archive.sql" });
    expect(files[66]).toMatchObject({ version: "0080", filename: "0080_patient_numbering.sql" });
    expect(files[65]).toMatchObject({version:"0079",filename:"0079_ortho_followup_coverage.sql"});
    expect(files[64]).toMatchObject({ version: "0078", filename: "0078_agreement_reconciliation.sql" });
    expect(files[63]).toMatchObject({version:"0074",filename:"0074_lab_work_intents.sql"});
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
    expect(periodontalCandidateMigrationVersion(files.filter(file => !["0066", "0068", "0069", "0074", "0078", "0079", "0080", "0081", "0082", "0087", "0089", "0126", "0128"].includes(file.version)))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,59))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,58))).toBe("9000");
    expect(periodontalCandidateMigrationVersion(files.slice(0,57))).toBe("9000");
    expect(()=>periodontalCandidateMigrationVersion([...files,{version:"0067",filename:"0067_unknown.sql"}])).toThrow();
    for (let index = 40; index < files.length; index++) {
      expect(()=>periodontalCandidateMigrationVersion(files.map((file,n)=>n===index?{...file,filename:`${file.version}_unknown.sql`}:file))).toThrow();
      if(index < files.length-1 && !["0067","0074","0079","0080"].includes(files[index].version)) expect(()=>periodontalCandidateMigrationVersion(files.filter((_,n)=>n!==index))).toThrow();
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
