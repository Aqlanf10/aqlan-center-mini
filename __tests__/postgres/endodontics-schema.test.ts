import { ENDODONTICS_SQL } from "../../lib/endodontics-schema";
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

  it("accepts exactly the permanent and primary FDI sets", async () => {
    for (let code = 0; code <= 99; code++) {
      const valid = (Math.floor(code / 10) >= 1 && Math.floor(code / 10) <= 4 && code % 10 >= 1 && code % 10 <= 8)
        || (Math.floor(code / 10) >= 5 && Math.floor(code / 10) <= 8 && code % 10 >= 1 && code % 10 <= 5);
      const statement = `INSERT INTO endo_treatments (patient_id, case_id, tooth_code, status, completed_at, created_by) VALUES ($1, $2, $3, 'completed', NOW(), 'test')`;
      if (valid) await q(statement, [patientId, caseId, code]);
      else await rejects(statement, [patientId, caseId, code]);
    }
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
    await rejects(`INSERT INTO endo_addenda (endo_visit_id, request_key, body, author) VALUES ($1, 'empty-addendum', '   ', 'dr')`, [endoVisitId]);
    await q(`INSERT INTO endo_addenda (endo_visit_id, request_key, body, author) VALUES ($1, 'first-addendum', 'تصحيح', 'dr')`, [endoVisitId]);
    await rejects(`DELETE FROM endo_visits WHERE id = $1`, [endoVisitId]);
    await rejects(`DELETE FROM visits WHERE id = $1`, [visitId]);
  });
});


describe("endo_addenda — immutable correction history", () => {
  it("requires bounded established request-key syntax and one row per record/key", async () => {
    const [record] = await q<{ id: number }>(`SELECT id FROM endo_visits ORDER BY id LIMIT 1`);
    const insert = `INSERT INTO endo_addenda (endo_visit_id, request_key, body, author) VALUES ($1, $2, 'correction', 'synthetic doctor')`;
    for (const key of [null, "short", "has a space", "x".repeat(129), "invalid/key"]) await rejects(insert, [record.id, key]);
    await q(insert, [record.id, "endo.addendum:request-001"]);
    await expect(getPool().query(insert, [record.id, "endo.addendum:request-001"])).rejects.toMatchObject({ code: "23505" });
    const raced = await Promise.allSettled(Array.from({ length: 5 }, () => getPool().query(insert, [record.id, "endo.addendum:concurrent"])));
    expect(raced.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(raced.filter((result) => result.status === "rejected")).toHaveLength(4);
  });
  it("scopes keys to the endodontic record, not to unrelated records", async () => {
    const [v] = await q<{ id: number }>(`INSERT INTO visits (patient_name, patient_id) VALUES ('synthetic key scope', $1) RETURNING id`, [patientId]);
    const [record] = await q<{ id: number }>(`INSERT INTO endo_visits (treatment_id, visit_id, recorded_by) VALUES ($1, $2, 'synthetic doctor') RETURNING id`, [treatmentId, v.id]);
    await q(`INSERT INTO endo_addenda (endo_visit_id, request_key, body, author) VALUES ($1, 'endo.addendum:request-001', 'independent correction', 'synthetic doctor')`, [record.id]);
  });
  it("blocks content, attribution, timestamp rewrites and deletion; preserves data on schema replay", async () => {
    const [record] = await q<{ id: number }>(`SELECT id FROM endo_visits ORDER BY id LIMIT 1`);
    const [created] = await q<{ id: number; body: string; author: string; created_at: Date }>(
      `INSERT INTO endo_addenda (endo_visit_id, request_key, body, author) VALUES ($1, 'original-correction', 'original correction', 'synthetic doctor') RETURNING *`, [record.id]);
    for (const set of ["body = 'replacement'", "author = 'other'", "created_at = NOW()", "endo_visit_id = endo_visit_id", "request_key = 'replacement-key'"]) {
      await expect(getPool().query(`UPDATE endo_addenda SET ${set} WHERE id = $1`, [created.id])).rejects.toThrow(/append-only/);
    }
    await expect(getPool().query(`DELETE FROM endo_addenda WHERE id = $1`, [created.id])).rejects.toThrow(/append-only/);
    await getPool().query(ENDODONTICS_SQL);
    await getPool().query(ENDODONTICS_SQL);
    const [after] = await q(`SELECT * FROM endo_addenda WHERE id = $1`, [created.id]);
    expect(after).toEqual(created);
    await expect(getPool().query(`DELETE FROM endo_addenda WHERE id = $1`, [created.id])).rejects.toThrow(/append-only/);
  });
  it("does not block the intentional reset TRUNCATE path", async () => {
    const before = await q(`SELECT * FROM endo_addenda ORDER BY id`);
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      await client.query("TRUNCATE TABLE endo_addenda RESTART IDENTITY");
      expect((await client.query("SELECT * FROM endo_addenda")).rows).toHaveLength(0);
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect(await q(`SELECT * FROM endo_addenda ORDER BY id`)).toEqual(before);
  });
});
