import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (FIN-3) من غيّر حالة خطة العلاج أو الفاتورة، ومن أيّ حالةٍ إلى أيّ حالة، ولماذا؟
 *
 * كان PATCH /api/plans/[id] يلغي الخطة أو يعيد تفعيلها بلا فاعلٍ ولا سبب في السجل — والفعل
 * «plan.status» مسجَّلٌ في قائمة التدقيق ولا يكتبه أحد. وتعليم الفاتورة «مسدّدة» أو إعادتها
 * «مفتوحة» يدويًّا (للمدير) لا يترك أثرًا. الآن كل تغييرٍ سطرُ تدقيقٍ **في معاملته نفسها**،
 * والتغيير بلا أثرٍ (الحالة نفسها) لا يكتب سطرًا.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, setPlanStatus, setInvoiceStatus } = await import("../../lib/db");

let patientId: number;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  ({ rows: [{ id: patientId }] } = await getPool().query(
    `INSERT INTO patients (patient_number, full_name) VALUES ('FIN3-1', 'مريض الحالات') RETURNING id`));
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function trail(entity: string, id: number) {
  const { rows } = await getPool().query<{ action: string; actor: string; actor_role: string | null; details: Record<string, unknown> }>(
    `SELECT action, actor, actor_role, details FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id`,
    [entity, String(id)]);
  return rows.map((row) => ({ action: row.action, actor: row.actor, role: row.actor_role, ...row.details }));
}

const reception = { actor: "reception1", actorRole: "reception" };

describe("(FIN-3) plan status changes are audited", () => {
  it("cancel (with reason) → reactivate → complete: each step names actor, from/to and reason", async () => {
    const { rows: [plan] } = await getPool().query<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, start_date, created_by)
       VALUES ($1, 'تقويم', 100000, 'YER', CURRENT_DATE, 't') RETURNING id`, [patientId]);
    expect(await setPlanStatus(plan.id, "cancelled", { ...reception, reason: "المريض انسحب" })).toBe(true);
    expect(await setPlanStatus(plan.id, "active", { ...reception, reason: "عاد المريض" })).toBe(true);
    expect(await setPlanStatus(plan.id, "active", reception)).toBe(true); // بلا تغيير — لا سطر
    expect(await setPlanStatus(plan.id, "completed", { actor: "dr.aqlan", actorRole: "admin" })).toBe(true);
    expect(await trail("treatment_plans", plan.id)).toEqual([
      { action: "plan.status", actor: "reception1", role: "reception", من: "active", إلى: "cancelled", السبب: "المريض انسحب" },
      { action: "plan.status", actor: "reception1", role: "reception", من: "cancelled", إلى: "active", السبب: "عاد المريض" },
      { action: "plan.status", actor: "dr.aqlan", role: "admin", من: "active", إلى: "completed" },
    ]);
  });

  it("an unknown plan changes nothing and writes nothing", async () => {
    expect(await setPlanStatus(999_999, "cancelled", { ...reception, reason: "x" })).toBe(false);
    expect(await trail("treatment_plans", 999_999)).toEqual([]);
  });
});

describe("(FIN-3) manual invoice status changes are audited", () => {
  it("marking paid then open again records both, with the net amount; a cancelled invoice cannot be revived", async () => {
    const { rows: [invoice] } = await getPool().query<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by)
       VALUES ('FIN3-INV-1', $1, 30000, 5000, 'YER', 't') RETURNING id`, [patientId]);
    const admin = { actor: "dr.aqlan", actorRole: "admin" };
    expect((await setInvoiceStatus(invoice.id, "paid", admin))?.status).toBe("paid");
    expect((await setInvoiceStatus(invoice.id, "open", admin))?.status).toBe("open");
    expect(await trail("invoice", invoice.id)).toEqual([
      { action: "invoice.status", actor: "dr.aqlan", role: "admin", من: "open", إلى: "paid", الصافي: "25,000 ر.ي" },
      { action: "invoice.status", actor: "dr.aqlan", role: "admin", من: "paid", إلى: "open", الصافي: "25,000 ر.ي" },
    ]);
    await getPool().query(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [invoice.id]);
    expect(await setInvoiceStatus(invoice.id, "open", admin)).toBeNull();
    expect((await trail("invoice", invoice.id)).length).toBe(2);
  });
});
