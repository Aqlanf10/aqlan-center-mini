import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (TD-06 / TD-REG-009) ما كان يكتب بلا سطر تدقيق — على PostgreSQL 18 حقيقي.
 *
 * - تحصيل قسط الخطة (سند قبض + فاتورة) لم يكن يكتب سطرًا حين يأتي من زر الخطة؛
 *   الآن يُكتب **داخل معاملة السند** — سطرٌ واحد لكل سند، ولا شيء عند الإعادة بالمفتاح نفسه.
 * - تعديل بند خطة وحذفه النهائي لم يتركا أثرًا؛ الآن: ما تغيّر (من/إلى) وما حُذف (الخدمة
 *   والكمية والسعر) ومن فعل.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const {
  getPool, resetPoolForTesting, ensureSchema, openShift, recordPlanInstallment, createPlanV2,
  updatePlanItem, removePlanItem,
} = await import("../../lib/db");

let patientId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "td06", opening: { YER: 0, SAR: 0, USD: 0 } });
  const { rows: [patient] } = await getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ('TD06-1', 'مريض تدقيق') RETURNING id`,
  );
  patientId = patient.id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function auditRows(action: string, entityId: number | string) {
  const { rows } = await getPool().query<{ actor: string; actor_role: string | null; details: Record<string, unknown> }>(
    `SELECT actor, actor_role, details FROM audit_log WHERE action = $1 AND entity_id = $2 ORDER BY id`,
    [action, String(entityId)],
  );
  return rows;
}

describe("TD-06: plan installment collection writes its audit row in the receipt's transaction", () => {
  it("one payment.create row per receipt — none on an idempotent replay", async () => {
    const plan = await createPlanV2({
      patientId, title: "تقويم بأقساط", specialty: null, primaryDoctorId: null,
      billingMode: "installments", baseCurrency: "YER", startDate: "2026-01-01", note: null,
      items: [], installments: [{ dueDate: "2026-01-01", amountMinor: 3_000_000 }],
      createdBy: "td06",
    });
    if (!plan.ok) throw new Error("plan");
    const collect = () => recordPlanInstallment({
      planId: plan.planId, patientId, installmentNumber: 1, planTitle: "تقويم بأقساط",
      amountMinor: 3_000_000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      method: "cash", note: null, createdBy: "reception1", actorRole: "reception", idempotencyKey: "td06-installment-1",
    });
    const first = await collect();
    if ("reason" in first) throw new Error(first.reason);
    const replay = await collect();
    if ("reason" in replay) throw new Error(replay.reason);
    expect(replay).toMatchObject({ paymentId: first.paymentId, replayed: true });

    const rows = await auditRows("payment.create", first.paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "reception1", actor_role: "reception" });
    expect(rows[0].details).toMatchObject({ الخطة: plan.planId, قسط: 1, فاتورة_القسط: first.invoiceId, المبلغ: 3_000_000, العملة: "YER" });
  });
});

describe("TD-06: plan item edit and removal are audited with what changed", () => {
  let planId = 0;
  let itemIds: number[] = [];

  beforeAll(async () => {
    const item = (serviceName: string, unitPriceMinor: number) => ({
      serviceId: null, serviceName, category: null, toothCode: null, surfaces: null,
      quantity: 1, unitPriceMinor, billingRule: "per_session" as const, sessionCount: 1, note: null,
    });
    const plan = await createPlanV2({
      patientId, title: "خطة بنود", specialty: null, primaryDoctorId: null,
      billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-01-01", note: null,
      items: [item("حشوة تجميلية", 2_500_000), item("تنظيف", 1_000_000)], installments: [],
      createdBy: "td06",
    });
    if (!plan.ok) throw new Error("plan");
    planId = plan.planId;
    const { rows } = await getPool().query<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1 ORDER BY id`, [planId]);
    itemIds = rows.map((row) => row.id);
  });

  it("update: before/after of the fields that changed; nothing when nothing changed", async () => {
    expect(await updatePlanItem({ planId, itemId: itemIds[0], sessionCount: 3, note: "على جلستين", actor: "doctor1", actorRole: "doctor" }))
      .toEqual({ ok: true });
    const rows = await auditRows("plan.item_update", itemIds[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: "doctor1", actor_role: "doctor" });
    expect(rows[0].details).toMatchObject({
      الخطة: planId, عدد_الجلسات: { من: 1, إلى: 3 }, الملاحظة: { من: null, إلى: "على جلستين" },
    });

    // نفس القيم ⇒ لا سطر جديد.
    expect(await updatePlanItem({ planId, itemId: itemIds[0], sessionCount: 3, actor: "doctor1", actorRole: "doctor" })).toEqual({ ok: true });
    expect(await auditRows("plan.item_update", itemIds[0])).toHaveLength(1);
  });

  it("update of a missing item is refused (was a silent 200) and writes nothing", async () => {
    expect(await updatePlanItem({ planId, itemId: 987654, sessionCount: 2, actor: "doctor1", actorRole: "doctor" }))
      .toEqual({ ok: false, message: "البند غير موجود." });
    expect(await auditRows("plan.item_update", 987654)).toHaveLength(0);
  });

  it("removal: the removed service, quantity and price stay in the audit", async () => {
    expect(await removePlanItem(planId, itemIds[1], { actor: "reception1", actorRole: "reception" })).toEqual({ ok: true });
    const rows = await auditRows("plan.item_remove", itemIds[1]);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ الخطة: planId, الخدمة: "تنظيف", الكمية: 1, سعر_الوحدة: 1_000_000, عملة_الخطة: "YER" });
    const { rows: [left] } = await getPool().query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM plan_items WHERE plan_id = $1`, [planId]);
    expect(left.count).toBe(1);
  });
});
