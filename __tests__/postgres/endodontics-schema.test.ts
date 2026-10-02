import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (ENDO-1) قيود مخطط علاج العصب تُفرض في القاعدة نفسها — على PostgreSQL 18.
 *
 * نوبةٌ جارية واحدة لكل (مريض، سن)، وسجلٌّ واحد لكل (نوبة، زيارة)، وقناةٌ واحدة بالاسم في السجل،
 * وأطوالٌ ودرجاتٌ ضمن حدود، والإيقاف بلا سبب مرفوض، والحذف مقيَّد لا متتابع.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { ensureSchema, getPool, resetPoolForTesting } = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}
const rejects = (sql: string, params: unknown[] = []) => expect(getPool().query(sql, params)).rejects.toBeDefined();

let patientId = 0;
let otherPatientId = 0;
let caseId = 0;
let visitId = 0;
let treatmentId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const patient = async (n: string) => (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [n]))[0].id;
  patientId = await patient("P-ENDO-1");
  otherPatientId = await patient("P-ENDO-2");
  caseId = (await q<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'endodontics', 'علاج عصب ٣٦', 'admin') RETURNING id`, [patientId]))[0].id;
  visitId = (await q<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id) VALUES ('P-ENDO-1', $1) RETURNING id`, [patientId]))[0].id;
  treatmentId = (await q<{ id: number }>(
    `INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 36, 'admin') RETURNING id`, [patientId, caseId]))[0].id;
});

afterAll(async () => { await resetPoolForTesting(); });

describe("endo_treatments", () => {
  it("one in-progress episode per patient × tooth; the same tooth of another patient is independent", async () => {
    await rejects(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 36, 'admin')`, [patientId, caseId]);
    const otherCase = (await q<{ id: number }>(
      `INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'endodontics', 'x', 'admin') RETURNING id`, [otherPatientId]))[0].id;
    await q(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 36, 'admin')`, [otherPatientId, otherCase]);
    // another tooth of the same patient is fine
    await q(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 46, 'admin')`, [patientId, caseId]);
  });

  it("a finished episode frees the tooth for a new (re)treatment episode", async () => {
    await q(`UPDATE endo_treatments SET status = 'completed', completed_at = NOW() WHERE id = $1`, [treatmentId]);
    const again = await q(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, kind, created_by) VALUES ($1, $2, 36, 'retreatment', 'admin') RETURNING id`, [patientId, caseId]);
    expect(again).toHaveLength(1);
    await q(`UPDATE endo_treatments SET status = 'abandoned', completed_at = NOW(), outcome = 'x' WHERE id = $1`, [again[0] && (again[0] as { id: number }).id]);
    treatmentId = (await q<{ id: number }>(
      `INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 36, 'admin') RETURNING id`, [patientId, caseId]))[0].id;
  });

  it("rejects bad tooth, kind, status, completed_at mismatch and abandon without a reason", async () => {
    await rejects(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, created_by) VALUES ($1, $2, 99, 'a')`, [patientId, caseId]);
    await rejects(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, kind, created_by) VALUES ($1, $2, 17, 'x', 'a')`, [patientId, caseId]);
    await rejects(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, status, created_by) VALUES ($1, $2, 17, 'done', 'a')`, [patientId, caseId]);
    await rejects(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, status, created_by) VALUES ($1, $2, 17, 'completed', 'a')`, [patientId, caseId]);
    await rejects(`INSERT INTO endo_treatments (patient_id, case_id, tooth_code, status, completed_at, created_by) VALUES ($1, $2, 17, 'abandoned', NOW(), 'a')`, [patientId, caseId]);
  });

  it("the patient or case cannot be deleted from under a treatment (RESTRICT)", async () => {
    await rejects(`DELETE FROM clinical_cases WHERE id = $1`, [caseId]);
    await rejects(`DELETE FROM patients WHERE id = $1`, [patientId]);
  });
});

describe("endo_visits / canals / addenda", () => {
  let endoVisitId = 0;
  it("one record per (treatment, visit)", async () => {
    endoVisitId = (await q<{ id: number }>(
      `INSERT INTO endo_visits (treatment_id, visit_id, recorded_by) VALUES ($1, $2, 'dr') RETURNING id`, [treatmentId, visitId]))[0].id;
    await rejects(`INSERT INTO endo_visits (treatment_id, visit_id, recorded_by) VALUES ($1, $2, 'dr')`, [treatmentId, visitId]);
  });
  it("mobility, canals-found and next-visit bounds", async () => {
    const v2 = (await q<{ id: number }>(`INSERT INTO visits (patient_name, patient_id) VALUES ('x', $1) RETURNING id`, [patientId]))[0].id;
    await rejects(`INSERT INTO endo_visits (treatment_id, visit_id, recorded_by, mobility_grade) VALUES ($1, $2, 'dr', 4)`, [treatmentId, v2]);
    await rejects(`INSERT INTO endo_visits (treatment_id, visit_id, recorded_by, canals_found) VALUES ($1, $2, 'dr', 9)`, [treatmentId, v2]);
    await rejects(`INSERT INTO endo_visits (treatment_id, visit_id, recorded_by, next_visit_weeks) VALUES ($1, $2, 'dr', 60)`, [treatmentId, v2]);
  });
  it("canal label shape, uniqueness per record, working-length and taper bounds", async () => {
    await q(`INSERT INTO endo_canal_records (endo_visit_id, canal_label, working_length_mm) VALUES ($1, 'MB', 20.5)`, [endoVisitId]);
    await rejects(`INSERT INTO endo_canal_records (endo_visit_id, canal_label) VALUES ($1, 'MB')`, [endoVisitId]);
    await rejects(`INSERT INTO endo_canal_records (endo_visit_id, canal_label) VALUES ($1, 'm b')`, [endoVisitId]);
    await rejects(`INSERT INTO endo_canal_records (endo_visit_id, canal_label, working_length_mm) VALUES ($1, 'ML', 0)`, [endoVisitId]);
    await rejects(`INSERT INTO endo_canal_records (endo_visit_id, canal_label, working_length_mm) VALUES ($1, 'ML', 41)`, [endoVisitId]);
    await rejects(`INSERT INTO endo_canal_records (endo_visit_id, canal_label, taper_percent) VALUES ($1, 'ML', 30)`, [endoVisitId]);
    const [row] = await q<{ working_length_mm: string }>(`SELECT working_length_mm FROM endo_canal_records WHERE endo_visit_id = $1`, [endoVisitId]);
    expect(row.working_length_mm).toBe("20.5");
  });
  it("addenda need text, and the parent record cannot be deleted from under them", async () => {
    await rejects(`INSERT INTO endo_addenda (endo_visit_id, body, author) VALUES ($1, '   ', 'dr')`, [endoVisitId]);
    await q(`INSERT INTO endo_addenda (endo_visit_id, body, author) VALUES ($1, 'تصحيح', 'dr')`, [endoVisitId]);
    await rejects(`DELETE FROM endo_visits WHERE id = $1`, [endoVisitId]);
    await rejects(`DELETE FROM visits WHERE id = $1`, [visitId]);
  });
});
