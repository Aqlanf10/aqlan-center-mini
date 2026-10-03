import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PrescriptionIdentityConflict } from "../lib/prescription-identity";
import { VISIT_RECORD_REFERENCES } from "../lib/visit-record-identity";

// Source contracts supplement real PostgreSQL races; they do not prove lock behavior.
const source = readFileSync("lib/db.ts", "utf8");
const rx = source.slice(source.indexOf("export async function savePrescription("), source.indexOf("export async function getPrescription("));
const vitals = source.slice(source.indexOf("export async function recordVitals("), source.indexOf("export async function listVitals("));

describe("prescription/vitals identity contracts", () => {
  it("uses a narrow typed stale-identity error", () => {
    const conflict = new PrescriptionIdentityConflict();
    expect(conflict).toBeInstanceOf(Error);
    expect(conflict.code).toBe("identity_changed");
    expect(conflict.message).toContain("حدّث الشاشة");
    expect(new Error("identity_changed")).not.toBeInstanceOf(PrescriptionIdentityConflict);
  });
  it("fences a supplied prescription owner before insertion and audits after commit", () => {
    expect(rx.indexOf("FOR KEY SHARE")).toBeLessThan(rx.indexOf("FOR SHARE"));
    expect(rx.indexOf("FOR SHARE")).toBeLessThan(rx.indexOf("INSERT INTO prescriptions"));
    expect(rx).toContain("visits[0].patient_id !== draft.patientId");
    expect(rx).toContain("if (draft.visitId !== null)");
    expect(rx).not.toMatch(/signed_at|status\s*=/);
    expect(rx.indexOf('client.query("COMMIT")')).toBeLessThan(rx.indexOf("void recordAudit("));
  });
  it("keeps standalone/latest unsigned local-day vitals and the transactional alert update", () => {
    expect(vitals).toContain("SELECT id FROM patients WHERE id = $1 FOR KEY SHARE");
    expect(vitals).not.toContain("FOR UPDATE");
    expect(vitals).toContain("v.patient_id = $1 AND v.signed_at IS NULL");
    expect(vitals).toContain("ORDER BY v.id DESC LIMIT 1 FOR SHARE");
    expect(vitals).not.toMatch(/v\.status\s*=/);
    expect(vitals).toContain("visits[0]?.id ?? null");
    expect(vitals.indexOf("FOR SHARE")).toBeLessThan(vitals.indexOf("INSERT INTO patient_vitals"));
    expect(vitals.indexOf("UPDATE patients SET medical_alert")).toBeLessThan(vitals.indexOf('client.query("COMMIT")'));
  });
  it("preserves both existing relink footprints and unsigned detach policies", () => {
    for (const table of ["prescriptions", "patient_vitals"]) {
      expect(VISIT_RECORD_REFERENCES.find(r => r.table === table)).toMatchObject({
        table, mismatch: "r.patient_id IS DISTINCT FROM $2::int", deletion: "detach",
      });
    }
  });
});
