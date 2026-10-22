import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf, loadMigrationFiles } from "../lib/migration-files";
import { PATIENT_APPOINTMENT_HISTORY_SQL } from "../lib/patient-appointment-history-schema";

describe("patient appointment history index provenance", () => {
  it("uses identical numbered/runtime bytes, with reserved 0066 absent", async () => {
    const sql = readFileSync("migrations/0067_patient_appointment_history_index.sql", "utf8");
    expect(sql).toBe(PATIENT_APPOINTMENT_HISTORY_SQL);
    const files = await loadMigrationFiles();
    expect(files.find(file => file.version === "0067")).toEqual({
      version: "0067", name: "patient_appointment_history_index",
      filename: "0067_patient_appointment_history_index.sql", sql, checksum: checksumOf(sql),
    });
    expect(files.some(file => file.version === "0066")).toBe(false);
  });

  it("adds only the measured index, without adopting a same-name object or changing rows", () => {
    const body = PATIENT_APPOINTMENT_HISTORY_SQL.replace(/^--.*$/gm, "").trim();
    expect(body).toBe("CREATE INDEX appointments_patient_history_idx\n  ON appointments (patient_id, scheduled_date, scheduled_time, id);");
    const db = readFileSync("lib/db.ts", "utf8");
    expect(db).toMatch(/applyRuntimeMigrationFiles\(getPool\(\),\s*\[\{\s*version:\s*"0067"/);
    expect(db).toContain("checksum: checksumOf(PATIENT_APPOINTMENT_HISTORY_SQL)");
  });
});
