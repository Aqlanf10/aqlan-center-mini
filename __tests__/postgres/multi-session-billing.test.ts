import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P1-D) العلاج متعدد الجلسات على PostgreSQL 18: علاج عصب ٣٦ بندٌ واحد بثلاث جلسات — يُفوتَر مرةً
 * واحدة وفق قاعدة البند، لا ثلاث مرات. إجراءٌ حرّ بنفس الخدمة والسن والبند جارٍ (أو متعدد الجلسات)
 * يُرفض توقيعه برسالة تطلب ربطه ببنده؛ والبند أحادي الجلسة يبقى على المطابقة القديمة.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, createPlanV2, addVisit, setVisitProcedures,
  signClinicalVisit, getClinicalVisit,
} = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctorId = 0;
let endoService = 0;
let crownService = 0;
let scalingService = 0;
let sequence = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctorId = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. العصب') RETURNING id`))[0].id;
  const service = async (name: string, category: string, price: number) => (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, $2, TRUE, TRUE, $3) RETURNING id`,
    [name, price, category]))[0].id;
  endoService = await service("علاج عصب", "endo", 60000);
  crownService = await service("تاج زيركون", "crown", 90000);
  scalingService = await service("تنظيف", "preventive", 10000);
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function patientWithPlan() {
  sequence += 1;
  const name = `مريض جلسات ${sequence}`;
  const patientId = (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`MS-${sequence}`, name]))[0].id;
  const plan = await createPlanV2({
    patientId, title: "خطة العلاج", specialty: null, primaryDoctorId: doctorId, billingMode: "per_procedure",
    baseCurrency: "YER", startDate: "2026-09-01", note: null, createdBy: "admin",
    items: [
      { serviceId: endoService, serviceName: "علاج عصب", category: "endo", toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: 60000, billingRule: "on_completion", sessionCount: 3, note: null },
      { serviceId: crownService, serviceName: "تاج زيركون", category: "crown", toothCode: 21, surfaces: null, quantity: 1, unitPriceMinor: 90000, billingRule: "on_start", sessionCount: 2, note: null },
      { serviceId: scalingService, serviceName: "تنظيف", category: "preventive", toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 10000, billingRule: "on_completion", sessionCount: 1, note: null },
    ],
    installments: [],
  });
  if (!plan.ok) throw new Error(plan.message);
  await q(`UPDATE treatment_plans SET consent_at = NOW() WHERE id = $1`, [plan.planId]);
  const items = await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1 ORDER BY id`, [plan.planId]);
  return { patientId, name, endoItem: items[0].id, crownItem: items[1].id, scalingItem: items[2].id };
}

async function visitWith(patientId: number, name: string, lines: { serviceId: number; toothCode: number | null; price: number; planItemId: number | null }[]) {
  const visit = await addVisit({ patientName: name, patientPhone: null, note: null, patientId });
  await q(`UPDATE visits SET doctor_id = $2, diagnosis = 'متابعة' WHERE id = $1`, [visit.id, doctorId]);
  await setVisitProcedures({
    visitId: visit.id,
    procedures: lines.map((line) => ({
      serviceId: line.serviceId, toothCode: line.toothCode, surfaces: null, quantity: 1, unitPriceMinor: line.price,
      priceReason: null, doctorId, note: null, planItemId: line.planItemId,
    })),
  });
  return visit.id;
}

const sign = (visitId: number) => signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctorId });

async function invoicedTotal(patientId: number): Promise<number> {
  return (await q<{ total: number }>(
    `SELECT COALESCE(SUM(total_minor), 0)::int AS total FROM invoices WHERE patient_id = $1 AND status <> 'cancelled'`, [patientId]))[0].total;
}

describe("(P1-D) one root canal, three sessions, one charge", () => {
  it("a free RCT line while the RCT item is in progress is refused — no second full charge", async () => {
    const { patientId, name, endoItem } = await patientWithPlan();
    const first = await visitWith(patientId, name, [{ serviceId: endoService, toothCode: 36, price: 60000, planItemId: endoItem }]);
    expect(await sign(first)).toMatchObject({ reason: null, duesMinor: 0, sessionsCompleted: 1 });
    await q(`UPDATE visits SET status = 'done' WHERE id = $1`, [first]);

    const second = await visitWith(patientId, name, [{ serviceId: endoService, toothCode: 36, price: 60000, planItemId: null }]);
    expect((await getClinicalVisit(second))?.planWarning).toMatch(/جلسة 2 من 3/);
    const refused = await sign(second);
    expect(refused.reason).toBe("plan_session_unlinked");
    expect(refused.sessionConflicts).toEqual([expect.stringMatching(/علاج عصب — سن 36.*جلسة 2 من 3/)]);
    expect(await invoicedTotal(patientId)).toBe(0);
    expect((await q(`SELECT signed_at FROM visits WHERE id = $1`, [second]))[0].signed_at).toBeNull();

    /* الربط ببنده يكمل الجلسة الثانية بلا فاتورة، والثالثة تُفوتر البند مرةً واحدة. */
    await setVisitProcedures({
      visitId: second,
      procedures: [{ serviceId: endoService, toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: 60000, priceReason: null, doctorId, note: null, planItemId: endoItem }],
    });
    expect(await sign(second)).toMatchObject({ reason: null, duesMinor: 0 });
    await q(`UPDATE visits SET status = 'done' WHERE id = $1`, [second]);
    const third = await visitWith(patientId, name, [{ serviceId: endoService, toothCode: 36, price: 60000, planItemId: endoItem }]);
    expect(await sign(third)).toMatchObject({ reason: null, duesMinor: 60000 });
    expect(await invoicedTotal(patientId)).toBe(60000);
    expect((await q(`SELECT status FROM plan_items WHERE id = $1`, [endoItem]))[0].status).toBe("done");
  });

  it("a free line for a planned multi-session crown is refused too — it would close the whole item after one visit", async () => {
    const { patientId, name, crownItem } = await patientWithPlan();
    const visit = await visitWith(patientId, name, [{ serviceId: crownService, toothCode: 21, price: 90000, planItemId: null }]);
    const refused = await sign(visit);
    expect(refused.reason).toBe("plan_session_unlinked");
    expect(refused.sessionConflicts).toEqual([expect.stringMatching(/تاج زيركون — سن 21.*جلسة 1 من 2/)]);
    expect((await q(`SELECT status FROM plan_items WHERE id = $1`, [crownItem]))[0].status).toBe("planned");
    expect(await invoicedTotal(patientId)).toBe(0);
  });

  it("a single-session planned item keeps the old matching: done, invoiced once at the line price", async () => {
    const { patientId, name, scalingItem } = await patientWithPlan();
    const visit = await visitWith(patientId, name, [{ serviceId: scalingService, toothCode: null, price: 10000, planItemId: null }]);
    expect(await sign(visit)).toMatchObject({ reason: null, duesMinor: 10000, planItemsDone: 1 });
    expect((await q(`SELECT status FROM plan_items WHERE id = $1`, [scalingItem]))[0].status).toBe("done");
  });

  it("the same service on another tooth is not a conflict", async () => {
    const { patientId, name } = await patientWithPlan();
    const visit = await visitWith(patientId, name, [{ serviceId: endoService, toothCode: 46, price: 60000, planItemId: null }]);
    expect(await sign(visit)).toMatchObject({ reason: null, duesMinor: 60000 });
  });

  it("(review) a single-session planned item with the same service and tooth is still matched — the multi-session one stays open", async () => {
    const { patientId, name, crownItem } = await patientWithPlan();
    const planId = (await q<{ plan_id: number }>(`SELECT plan_id FROM plan_items WHERE id = $1`, [crownItem]))[0].plan_id;
    const single = (await q<{ id: number }>(
      `INSERT INTO plan_items (plan_id, service_id, service_name, tooth_code, quantity, unit_price_minor, billing_rule, session_count, sort_order)
       VALUES ($1, $2, 'تاج زيركون', 21, 1, 90000, 'on_completion', 1, 99) RETURNING id`, [planId, crownService]))[0].id;
    const visit = await visitWith(patientId, name, [{ serviceId: crownService, toothCode: 21, price: 90000, planItemId: null }]);
    expect(await sign(visit)).toMatchObject({ reason: null, duesMinor: 90000, planItemsDone: 1 });
    expect(await q(`SELECT id, status FROM plan_items WHERE id = ANY($1::int[]) ORDER BY id`, [[crownItem, single]]))
      .toEqual([{ id: crownItem, status: "planned" }, { id: single, status: "done" }]);
  });
});
