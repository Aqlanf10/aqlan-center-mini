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
