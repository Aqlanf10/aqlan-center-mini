import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf, loadMigrationFiles } from "../lib/migration-files";
import { PATIENT_APPOINTMENT_HISTORY_SQL } from "../lib/patient-appointment-history-schema";

describe("patient appointment history index provenance", () => {
  it("uses identical numbered/runtime bytes within the reviewed composed migration chain", async () => {
    const sql = readFileSync("migrations/0067_patient_appointment_history_index.sql", "utf8");
    expect(sql).toBe(PATIENT_APPOINTMENT_HISTORY_SQL);
    const files = await loadMigrationFiles();
    expect(files.find(file => file.version === "0067")).toEqual({
      version: "0067", name: "patient_appointment_history_index",
      filename: "0067_patient_appointment_history_index.sql", sql, checksum: checksumOf(sql),
    });
    expect(files.filter(file => file.version >= "0066").map(file => file.filename)).toEqual([
      "0066_agreement_delta_amendments.sql",
      "0067_patient_appointment_history_index.sql",
      "0068_collection_attempt_retirements.sql",
      "0069_unpaid_currency_transitions.sql",
      "0078_agreement_reconciliation.sql",
      "0087_agreement_reminder_metadata.sql",
      "0089_lab_shade_specification.sql",
      "0090_booking_request_preferences.sql",
      "0091_prescribing_doctor_identity.sql",
      "0092_prescribing_doctor_snapshot.sql",
      "0093_prescription_issuance_commands.sql",
      "0106_ortho_assessment_verifier_2_2.sql",
      "0108_ortho_assessment_intake.sql",
      "0109_ortho_adjustment_requests.sql",
      "0110_ortho_assessment_verifier_2_2_1.sql",
      "0111_ortho_case_study.sql",
      "0112_ortho_study_submissions.sql",
      "0113_ceph_completion_provenance.sql",
      "0114_ceph_completion_source_cas.sql",
      "0115_ortho_facial_revisions.sql",
      "0116_ortho_facial_submissions.sql",
      "0117_ortho_problem_sources.sql",
      "0118_ortho_problem_source_submissions.sql",
      "0119_ortho_space_ledger.sql",
      "0120_ortho_space_submissions.sql",
      "0121_ortho_retention_ledger.sql",
      "0122_ortho_retention_submissions.sql",
    ]);
  });

  it("adds only the measured index, without adopting a same-name object or changing rows", () => {
    const body = PATIENT_APPOINTMENT_HISTORY_SQL.replace(/^--.*$/gm, "").trim();
    expect(body).toBe("CREATE INDEX appointments_patient_history_idx\n  ON appointments (patient_id, scheduled_date, scheduled_time, id);");
    const db = readFileSync("lib/db.ts", "utf8");
    expect(db).toMatch(/applyRuntimeMigrationFiles\(getPool\(\),\s*\[\{\s*version:\s*"0067"/);
    expect(db).toContain("checksum: checksumOf(PATIENT_APPOINTMENT_HISTORY_SQL)");
  });
});
