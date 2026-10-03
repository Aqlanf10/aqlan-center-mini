import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validateOperationalVerificationEnvironment } from "../lib/verification-target-policy.mjs";
import { PrescriptionIdentityConflict } from "../lib/prescription-identity";
import type { PrescriptionDraft } from "../lib/prescription";

// Validate the untouched inherited environment before selecting the actual
// in-memory PGlite adapter. No mocks, external connection or unlinked visit.
validateOperationalVerificationEnvironment(process.env);
vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("SKIP_SEED", "true");
const db = await import("../lib/db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;
let sequence = 0;
let doctorId: number;
const actor = "synthetic-pglite-rx-vitals";
const missingPatientId = 2_147_483_647;
const vitals = { bpSystolic: 120, bpDiastolic: 80, pulse: 72, temperature: 36.8, spo2: 98, glucose: 100, weightKg: 70.5 };

beforeAll(async () => {
  await db.ensureSchema();
  doctorId = (await q<{ id: number }>(`INSERT INTO parties (kind, name)
    VALUES ('doctor', 'Synthetic PGlite Rx/vitals doctor') RETURNING id`))[0].id;
}, 60_000);
afterAll(async () => {
  await db.resetPoolForTesting();
  vi.unstubAllEnvs();
});
async function fixture() {
  const patientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name, medical_alert)
    VALUES ($1, 'Synthetic PGlite patient', 'Synthetic previous alert') RETURNING id`, [`PGL-RXV-${++sequence}`]))[0].id;
  const visitId = (await q<{ id: number }>(`INSERT INTO visits (patient_id, patient_name, doctor_id, status)
    VALUES ($1, 'Synthetic PGlite patient', $2, 'done') RETURNING id`, [patientId, doctorId]))[0].id;
  // Returned SELECT rows establish existence even when affectedRows is zero.
  expect(await q("SELECT id FROM patients WHERE id = $1", [patientId])).toEqual([{ id: patientId }]);
  return { patientId, visitId };
}
const draft = (patientId: number, visitId: number | null): PrescriptionDraft => ({
  patientId, visitId, diagnosis: "Synthetic diagnosis", notes: "Synthetic instructions", instructionsLang: "both",
  items: [{ name: "Paracetamol 500mg", dose: "500mg", form: "Tablets", frequency: "every 8 hours", duration: "3 days", instructions: "Synthetic Arabic instruction", instructionsEn: "Synthetic English instruction" }],
});
async function drainCreationAudit(id: number) {
  await vi.waitFor(async () => {
    expect(await q("SELECT id FROM audit_log WHERE action = 'prescription.create' AND entity_id = $1", [String(id)])).toHaveLength(1);
  }, { timeout: 5_000, interval: 10 });
}

describe("actual PGlite prescription/vital patient existence", () => {
  it.each(["linked", "patient-only", "signed"])("saves a valid patient's %s prescription through the real local adapter", async mode => {
    const f = await fixture();
    if (mode === "signed") await q("UPDATE visits SET signed_at = NOW(), signed_by = $2 WHERE id = $1", [f.visitId, actor]);
    const input = draft(f.patientId, mode === "patient-only" ? null : f.visitId);
    const record = await db.savePrescription(input, actor, doctorId);
    expect(record).toMatchObject({ ...input, createdBy: actor, doctorPartyId: doctorId, status: "active" });
    expect(await db.getPrescription(record.id)).toEqual(record);
    await drainCreationAudit(record.id);
  });
  it("still rejects a genuinely missing prescription patient without a row or success audit", async () => {
    expect(await q("SELECT id FROM patients WHERE id = $1", [missingPatientId])).toEqual([]);
    const beforeRows = await q("SELECT * FROM prescriptions ORDER BY id");
    const beforeAudit = await q("SELECT * FROM audit_log WHERE action = 'prescription.create' ORDER BY id");
    await expect(db.savePrescription(draft(missingPatientId, null), actor, doctorId))
      .rejects.toBeInstanceOf(PrescriptionIdentityConflict);
    expect(await q("SELECT * FROM prescriptions ORDER BY id")).toEqual(beforeRows);
    expect(await q("SELECT * FROM audit_log WHERE action = 'prescription.create' ORDER BY id")).toEqual(beforeAudit);
  });
  it.each(["linked", "standalone"])("saves a valid patient's %s vitals through the real local adapter", async mode => {
    const f = await fixture();
    if (mode === "standalone") await q("UPDATE visits SET arrived_at = NOW() - INTERVAL '2 days' WHERE id = $1", [f.visitId]);
    const record = await db.recordVitals(f.patientId, vitals, actor, { medicalAlert: "Synthetic updated alert" });
    expect(record).toMatchObject({ ...vitals, patientId: f.patientId, visitId: mode === "linked" ? f.visitId : null, recordedBy: actor });
    expect((await db.listVitals(f.patientId)).find(row => row.id === record!.id)).toEqual(record);
    expect(await q("SELECT medical_alert FROM patients WHERE id = $1", [f.patientId]))
      .toEqual([{ medical_alert: "Synthetic updated alert" }]);
  });
  it("still returns null for genuinely missing vital patients without changing any reading or alert", async () => {
    expect(await q("SELECT id FROM patients WHERE id = $1", [missingPatientId])).toEqual([]);
    const beforeRows = await q("SELECT * FROM patient_vitals ORDER BY id");
    const beforeAlerts = await q("SELECT id, medical_alert FROM patients ORDER BY id");
    expect(await db.recordVitals(missingPatientId, vitals, actor, { medicalAlert: "Never saved" })).toBeNull();
    expect(await q("SELECT * FROM patient_vitals ORDER BY id")).toEqual(beforeRows);
    expect(await q("SELECT id, medical_alert FROM patients ORDER BY id")).toEqual(beforeAlerts);
  });
});
