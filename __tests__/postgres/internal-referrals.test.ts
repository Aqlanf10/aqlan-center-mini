import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { ensureSchema, getPool, resetPoolForTesting, createInternalReferral, createReferral, listPatientReferrals } = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let patientId = 0;
let otherPatientId = 0;
let referringDoctor = 0;
let receivingDoctor = 0;
let labId = 0;
let sourceCaseId = 0;
let wrongCaseId = 0;

const draft = () => ({
  patientId, doctorPartyId: referringDoctor, actor: "referring-doctor", actorRole: "doctor",
  toSpecialty: "endodontics" as const, reason: "علاج عصب قبل متابعة التقويم",
  teeth: "21", urgency: "soon" as const, sourceCaseId, targetCaseId: null,
  sourcePlanItemId: null, toPartyId: receivingDoctor, clinicalNotes: "صورة الأشعة في ملف المريض",
  requestKey: "123e4567-e89b-42d3-a456-426614174001",
});

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  referringDoctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. عقلان') RETURNING id`))[0].id;
  receivingDoctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. محمد') RETURNING id`))[0].id;
  labId = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('lab', 'مختبر') RETURNING id`))[0].id;
  patientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('REF-IN-1', 'مريض الإحالة') RETURNING id`))[0].id;
  otherPatientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('REF-IN-2', 'مريض آخر') RETURNING id`))[0].id;
  sourceCaseId = (await q<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'orthodontics', 'تقويم ٢١', 'doctor') RETURNING id`, [patientId]))[0].id;
  wrongCaseId = (await q<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'orthodontics', 'حالة مريض آخر', 'doctor') RETURNING id`, [otherPatientId]))[0].id;
}, 180_000);

afterAll(async () => { await resetPoolForTesting(); });

describe("REF-1 internal referral foundation on PostgreSQL 18", () => {
  it("creates one same-patient clinical handoff and one audit, with no financial rows", async () => {
    const before = await q<{ invoices: string; payments: string }>(
      `SELECT (SELECT COUNT(*)::text FROM invoices WHERE patient_id = $1) AS invoices,
              (SELECT COUNT(*)::text FROM payments WHERE patient_id = $1) AS payments`, [patientId]);
    const result = await createInternalReferral(draft());
    expect(result.ok && result.created).toBe(true);
    if (!result.ok) return;
    expect(result.referral).toMatchObject({ patientId, kind: "internal", sourceCaseId,
      toPartyId: receivingDoctor, toName: "د. محمد", workflowState: "sent", status: "sent" });
    expect(await q<{ invoices: string; payments: string }>(
      `SELECT (SELECT COUNT(*)::text FROM invoices WHERE patient_id = $1) AS invoices,
              (SELECT COUNT(*)::text FROM payments WHERE patient_id = $1) AS payments`, [patientId])).toEqual(before);
    expect(await q<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_log WHERE entity = 'patient' AND entity_id = $1::text AND action = 'referral.create'`, [patientId]))
      .toEqual([{ action: "referral.create", actor: "referring-doctor" }]);
  });

  it("repeating the same request returns the same referral without a second audit", async () => {
    const result = await createInternalReferral(draft());
    expect(result.ok && result.created).toBe(false);
    expect(await q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM patient_referrals WHERE patient_id = $1 AND kind = 'internal'`, [patientId]))
      .toEqual([{ count: "1" }]);
    expect(await q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM audit_log WHERE entity = 'patient' AND entity_id = $1::text AND action = 'referral.create'`, [patientId]))
      .toEqual([{ count: "1" }]);
    expect(await createInternalReferral({ ...draft(), reason: "طلب مختلف" })).toEqual({ ok: false, reason: "key_conflict" });
  });

  it("rejects a case from another patient and a lab as receiving doctor", async () => {
    expect(await createInternalReferral({ ...draft(), requestKey: "123e4567-e89b-42d3-a456-426614174002", sourceCaseId: wrongCaseId }))
      .toEqual({ ok: false, reason: "bad_case" });
    expect(await createInternalReferral({ ...draft(), requestKey: "123e4567-e89b-42d3-a456-426614174003", toPartyId: labId }))
      .toEqual({ ok: false, reason: "bad_target_doctor" });
    expect(await q<{ count: string }>(`SELECT COUNT(*)::text AS count FROM patient_referrals WHERE patient_id = $1 AND kind = 'internal'`, [patientId]))
      .toEqual([{ count: "1" }]);
  });

  it("keeps external referral rows and their read model working", async () => {
    const external = await createReferral({ patientId, doctorPartyId: referringDoctor, actor: "referring-doctor",
      toName: "مركز خارجي", toSpecialty: "radiology", reason: "صورة CBCT", teeth: "21", urgency: "routine" });
    expect(external).toMatchObject({ kind: "external", workflowState: null, toPartyId: null });
    expect((await listPatientReferrals(patientId)).map((item) => item.kind).sort()).toEqual(["external", "internal"]);
  });
});
