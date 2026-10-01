import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P1-B) باقة التقويم الجديدة على PostgreSQL 18: حالة تقويم + اتفاق أقساط ⇒ كل شدّة «مشمولة»
 * بلا فاتورة، وبلا عددٍ محدد من الشدّات (العلاج ليس ١٠ أو ١٢ زيارة). وخطةُ مريضٍ آخر أو خطةٌ ملغاة
 * لا تموّل الحالة — رفضٌ صريح عند الكتابة.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, openShift, addVisit, recordAdjustment, createOrthoCase,
  linkOrthoCasePlan, signClinicalVisit, getClinicalVisit, setPlanStatus,
} = db;
const { clinicDateString } = await import("../../lib/schedule");
const today = clinicDateString(new Date(), db.CLINIC_TIME_ZONE);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctorId = 0;
let sequence = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  doctorId = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. التقويم') RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function patientWithAgreement(installments = 3) {
  sequence += 1;
  const name = `مريض باقة ${sequence}`;
  const patientId = (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`PKG-${sequence}`, name]))[0].id;
  const planId = (await q<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, 'باقة تقويم ثابت', 900000) RETURNING id`,
    [patientId]))[0].id;
  for (let number = 1; number <= installments; number += 1) {
    await q(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor) VALUES ($1, $2, $3::date, 300000)`,
      [planId, number, today]);
  }
  return { patientId, planId, name };
}

function newCase(patientId: number, planId: number | null) {
  return createOrthoCase({
    patientId, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
    startDate: today, plannedMonths: 18, planId, note: null, createdBy: "doctor",
  });
}

async function adjustment(caseId: number, doneOn: string) {
  const saved = await recordAdjustment({
    caseId, visitId: null, doneOn, phase: null, upperWire: "016 NiTi", lowerWire: null,
    elastics: "none", elasticNote: null, done: "شدّة دورية", nextWeeks: 4, note: null,
    recordedBy: "doctor", actorRole: "doctor",
  });
  if (!saved.ok) throw new Error(saved.message);
  return saved;
}

describe("(P1-B) new orthodontic package", () => {
  it("refuses another patient's plan when opening the case", async () => {
    const mine = await patientWithAgreement();
    const other = await patientWithAgreement();
    const refused = await newCase(mine.patientId, other.planId);
    expect(refused).toEqual({ ok: false, message: "الخطة المختارة ليست لهذا المريض." });
    expect(await q(`SELECT id FROM ortho_cases WHERE patient_id = $1`, [mine.patientId])).toEqual([]);
  });

  it("an open-ended timeline: the 21st adjustment is included like the 1st, no invoice, no dues", async () => {
    const { patientId, planId, name } = await patientWithAgreement();
    const opened = await newCase(patientId, planId);
    if (!opened.ok) throw new Error(opened.message);
    /* عشرون شدّة سابقة (أكثر من أي «عدد زيارات» مفترض) مسجّلة متأخرةً بتواريخ ماضية. */
    for (let week = 20; week >= 1; week -= 1) {
      const doneOn = clinicDateString(new Date(Date.now() - week * 7 * 86_400_000), db.CLINIC_TIME_ZONE);
      await adjustment(opened.id, doneOn);
    }
    const visit = await addVisit({ patientName: name, patientPhone: null, note: null, patientId, doctorId });
    const saved = await adjustment(opened.id, today);
    expect(saved.visitId).toBe(visit.id);
    expect((await getClinicalVisit(visit.id))?.ortho?.adjustmentBillingClass).toBe("INCLUDED");
    const signed = await signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });
    expect(signed).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0, orthoBillingClass: "INCLUDED" });
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toEqual([]);
    expect((await q<{ n: number }>(`SELECT count(*)::int AS n FROM ortho_adjustments WHERE case_id = $1`, [opened.id]))[0].n).toBe(21);
  });

  it("linking afterwards: refused for a cancelled or foreign plan; audited; unlinking returns to OUTSIDE_CONTRACT", async () => {
    const { patientId, planId, name } = await patientWithAgreement();
    const other = await patientWithAgreement();
    const opened = await newCase(patientId, null);
    if (!opened.ok) throw new Error(opened.message);
    const visit = await addVisit({ patientName: name, patientPhone: null, note: null, patientId, doctorId });
    await adjustment(opened.id, today);
    expect((await getClinicalVisit(visit.id))?.ortho?.adjustmentBillingClass).toBe("OUTSIDE_CONTRACT");

    expect(await linkOrthoCasePlan({ caseId: opened.id, planId: other.planId, actor: "doctor", actorRole: "doctor" }))
      .toEqual({ ok: false, status: 409, message: "الخطة المختارة ليست لهذا المريض." });

    const linked = await linkOrthoCasePlan({ caseId: opened.id, planId, actor: "reception", actorRole: "reception" });
    expect(linked).toEqual({ ok: true, changed: true, funded: true });
    expect((await getClinicalVisit(visit.id))?.ortho?.adjustmentBillingClass).toBe("INCLUDED");
    const { rows: [audit] } = await getPool().query<{ actor: string; details: Record<string, unknown> }>(
      `SELECT actor, details FROM audit_log WHERE action = 'ortho.plan_link' AND entity_id = $1`, [String(opened.id)]);
    expect(audit).toMatchObject({ actor: "reception", details: { المريض: patientId, من_خطة: null, إلى_خطة: planId } });
    /* إعادة الطلب نفسه لا تكتب تدقيقًا ثانيًا. */
    expect(await linkOrthoCasePlan({ caseId: opened.id, planId, actor: "reception", actorRole: "reception" }))
      .toEqual({ ok: true, changed: false, funded: true });

    /* اتفاقٌ أُلغي لا يموّل الحالة — والشدّة تعود تحتاج قرار فوترة. */
    expect(await setPlanStatus(planId, "cancelled", { actor: "admin", actorRole: "admin", reason: "اختبار الإلغاء" })).toBe("ok");
    expect((await getClinicalVisit(visit.id))?.ortho?.adjustmentBillingClass).toBe("OUTSIDE_CONTRACT");
    expect(await linkOrthoCasePlan({ caseId: opened.id, planId, actor: "doctor", actorRole: "doctor" }))
      .toEqual({ ok: false, status: 409, message: "الخطة المختارة ملغاة — اختر خطة سارية." });

    expect(await linkOrthoCasePlan({ caseId: opened.id, planId: null, actor: "doctor", actorRole: "doctor" }))
      .toEqual({ ok: true, changed: true, funded: false });
    expect((await q<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'ortho.plan_link' AND entity_id = $1`, [String(opened.id)]))[0].n).toBe(2);
  });

  it("a plan without installments does not fund the case", async () => {
    const { patientId, planId } = await patientWithAgreement(0);
    const opened = await newCase(patientId, planId);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(await linkOrthoCasePlan({ caseId: opened.id, planId, actor: "doctor", actorRole: "doctor" }))
      .toEqual({ ok: true, changed: false, funded: false });
  });
});
