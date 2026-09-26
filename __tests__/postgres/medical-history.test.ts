import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/** (PAT-2) التاريخ الطبي بنسخٍ لا تُعدَّل، والعلامات الحيوية بسجلٍّ مؤرَّخ — على PostgreSQL 18. */

assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, saveMedicalHistory, listMedicalHistory, recordVitals, listVitals, deletePatientCascade, mergeDuplicatePatient } = await import("../../lib/db");
const { normalizeMedicalHistory } = await import("../../lib/medical-history");

let patientId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  ({ rows: [{ id: patientId }] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ('MH-1', 'مريض التاريخ الطبي') RETURNING id`));
}, 120_000);
afterAll(async () => { await resetPoolForTesting(); });

const history = (extra: Record<string, unknown>) => {
  const parsed = normalizeMedicalHistory(extra);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};

describe("(PAT-2) medical history versions", () => {
  it("saves each update as a new version and lists the newest first", async () => {
    await saveMedicalHistory(patientId, history({ answers: { diabetes: "yes" }, bloodGroup: "A+" }), "reception");
    await saveMedicalHistory(patientId, history({ answers: { diabetes: "yes", anticoagulants: "yes" },
      allergies: [{ substance: "بنسلين", severity: "severe" }], asaClass: "II", patientConfirmed: true }), "doctor");
    const versions = await listMedicalHistory(patientId);
    expect(versions.map((row) => row.recordedBy)).toEqual(["doctor", "reception"]);
    expect(versions[0]).toMatchObject({ asaClass: "II", patientConfirmed: true, allergies: [{ substance: "بنسلين", severity: "severe" }] });
    expect(versions[0].answers.anticoagulants).toBe("yes");
    expect(versions[1].bloodGroup).toBe("A+");
  });

  it("is append-only: an old version can be neither changed nor deleted", async () => {
    const [latest] = await listMedicalHistory(patientId);
    await expect(getPool().query(`UPDATE patient_medical_history SET notes = 'x' WHERE id = $1`, [latest.id])).rejects.toThrow();
    await expect(getPool().query(`DELETE FROM patient_medical_history WHERE id = $1`, [latest.id])).rejects.toThrow();
  });

  it("returns null for a missing patient", async () => {
    expect(await saveMedicalHistory(999999, history({}), "x")).toBeNull();
  });
});

describe("(PAT-2) vital signs", () => {
  it("records readings with time and author, linked to today's open visit", async () => {
    const { rows: [visit] } = await getPool().query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, status, arrived_at) VALUES ('م', $1, 'seated', NOW()) RETURNING id`, [patientId]);
    const saved = await recordVitals(patientId, { bpSystolic: 150, bpDiastolic: 95, pulse: 88, temperature: 37.2, spo2: 98, glucose: 180, weightKg: 72.5 }, "nurse");
    expect(saved).toMatchObject({ visitId: visit.id, bpSystolic: 150, temperature: 37.2, weightKg: 72.5, recordedBy: "nurse" });
    expect((await listVitals(patientId))[0].id).toBe(saved!.id);
    await expect(getPool().query(`UPDATE patient_vitals SET pulse = 60 WHERE id = $1`, [saved!.id])).rejects.toThrow();
  });

  it("the database refuses impossible readings even if the app misses them", async () => {
    await expect(getPool().query(
      `INSERT INTO patient_vitals (patient_id, pulse, recorded_by) VALUES ($1, 999, 'x')`, [patientId])).rejects.toThrow();
  });

  it("deleting the patient takes the history and vitals with it", async () => {
    const { rows: [temp] } = await getPool().query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('MH-2', 'مؤقت') RETURNING id`);
    await saveMedicalHistory(temp.id, history({}), "x");
    await recordVitals(temp.id, { bpSystolic: null, bpDiastolic: null, pulse: 70, temperature: null, spo2: null, glucose: null, weightKg: null }, "x");
    await getPool().query(`DELETE FROM patients WHERE id = $1`, [temp.id]);
    expect(await listMedicalHistory(temp.id)).toEqual([]);
  });

  it("the app refuses to delete a patient file that carries a medical history", async () => {
    const result = await deletePatientCascade(patientId, { actor: "admin", actorRole: "admin", reason: "تجربة" });
    expect(result).toMatchObject({ ok: false, reason: "has_clinical_history" });
    expect(result.counts?.medicalHistory).toBeGreaterThan(0);
  });
});

describe("(PAT-2) merging duplicate files", () => {
  it("moves the duplicate's history and vitals to the kept file — the append-only guard allows re-homing, not edits", async () => {
    const { rows: [keep] } = await getPool().query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('MH-K', 'الملف الأصلي') RETURNING id`);
    const { rows: [dup] } = await getPool().query<{ id: number }>(
      `INSERT INTO patients (patient_number, full_name) VALUES ('MH-D', 'الملف المكرر') RETURNING id`);
    await saveMedicalHistory(dup.id, history({ allergies: [{ substance: "لاتكس", severity: "severe" }] }), "reception");
    await recordVitals(dup.id, { bpSystolic: 120, bpDiastolic: 80, pulse: null, temperature: null, spo2: null, glucose: null, weightKg: null }, "nurse");

    const result = await mergeDuplicatePatient(dup.id, keep.id, { actor: "admin", actorRole: "admin", reason: "تكرار" });
    expect(result.ok).toBe(true);
    const moved = await listMedicalHistory(keep.id);
    expect(moved).toHaveLength(1);
    expect(moved[0].allergies).toEqual([{ substance: "لاتكس", severity: "severe" }]);
    expect(moved[0].recordedBy).toBe("reception");
    expect(await listVitals(keep.id)).toHaveLength(1);
    // النقل لا يفتح باب التعديل: تغيير الحقول مع المريض ما زال مرفوضًا.
    await expect(getPool().query(
      `UPDATE patient_medical_history SET notes = 'x' WHERE id = $1`, [moved[0].id])).rejects.toThrow();
  });

  it("deleting a visit unlinks its vitals instead of failing on the append-only guard", async () => {
    const { rows: [visit] } = await getPool().query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, status, arrived_at) VALUES ('م', $1, 'seated', NOW()) RETURNING id`, [patientId]);
    const saved = await recordVitals(patientId, { bpSystolic: null, bpDiastolic: null, pulse: 72, temperature: null, spo2: null, glucose: null, weightKg: null }, "nurse");
    expect(saved?.visitId).toBe(visit.id);
    await getPool().query(`DELETE FROM visits WHERE id = $1`, [visit.id]);
    const after = (await listVitals(patientId)).find((row) => row.id === saved!.id);
    expect(after).toMatchObject({ visitId: null, pulse: 72 });
  });
});
