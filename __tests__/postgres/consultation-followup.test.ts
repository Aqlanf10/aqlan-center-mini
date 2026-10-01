import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (P1-E) عروض العلاج المعلّقة على PostgreSQL 18: خطةٌ سارية بلا موافقة تظهر للمتابعة،
 * والموافَق عليها أو الملغاة لا تظهر؛ وتسجيل التواصل يطبع الخطة ويُدقَّق دون أن يمسّ مبلغًا أو قسطًا.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { ensureSchema, getPool, resetPoolForTesting, listPendingProposals, recordProposalContact } = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let pending = 0;
let consented = 0;
let cancelled = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  const doctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. الكشف') RETURNING id`))[0].id;
  const patient = (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, phone) VALUES ('CF-1', 'مريض جديد', '777000111') RETURNING id`))[0].id;
  const plan = async (title: string, extra = "") => (await q<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, primary_doctor_id, created_at${extra ? ", " + extra.split("=")[0] : ""})
     VALUES ($1, $2, 450000, 'SAR', $3, NOW() - INTERVAL '10 days'${extra ? ", " + extra.split("=")[1] : ""}) RETURNING id`,
    [patient, title, doctor]))[0].id;
  pending = await plan("خطة تجميل");
  consented = await plan("خطة موافَق عليها", "consent_at=NOW()");
  cancelled = await plan("خطة ملغاة", "status='cancelled'");
  await q(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor) VALUES ($1, 1, CURRENT_DATE, 450000)`, [pending]);
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(P1-E) pending treatment proposals", () => {
  it("lists only active, unconsented plans — money only when allowed, in the plan's own currency", async () => {
    const withMoney = await listPendingProposals({ includeMoney: true });
    expect(withMoney.map((row) => row.planId)).toEqual([pending]);
    expect(withMoney[0]).toMatchObject({
      patientName: "مريض جديد", patientPhone: "777000111", title: "خطة تجميل", doctorName: "د. الكشف",
      totalMinor: 450000, currency: "SAR", lastContactOn: null,
    });
    expect((await listPendingProposals({ includeMoney: false }))[0].totalMinor).toBeNull();
  });

  it("an installment reminder is not a proposal contact; WhatsApp follows the patient's consent", async () => {
    await q(`UPDATE treatment_plans SET last_reminder_at = NOW() WHERE id = $1`, [pending]);
    expect((await listPendingProposals({ includeMoney: true }))[0]).toMatchObject({ lastContactOn: null, whatsappAllowed: true });
    const patientId = (await q<{ patient_id: number }>(`SELECT patient_id FROM treatment_plans WHERE id = $1`, [pending]))[0].patient_id;
    await q(`INSERT INTO patient_contact_consents (patient_id, channel, granted, source, recorded_by) VALUES ($1, 'whatsapp', FALSE, 'phone', 'reception')`, [patientId]);
    expect((await listPendingProposals({ includeMoney: true }))[0].whatsappAllowed).toBe(false);
  });

  it("recording a contact audits the note — no amount, installment or reminder stamp changes", async () => {
    const before = await q(`SELECT total_minor::text, last_reminder_at, (SELECT json_agg(row_to_json(i)) FROM plan_installments i WHERE i.plan_id = $1) AS inst FROM treatment_plans WHERE id = $1`, [pending]);
    const saved = await recordProposalContact({ planId: pending, note: "سيرد بعد العيد", actor: "reception", actorRole: "reception" });
    expect(saved.ok).toBe(true);
    expect((await listPendingProposals({ includeMoney: true }))[0].lastContactOn).not.toBeNull();
    expect(await q(`SELECT total_minor::text, last_reminder_at, (SELECT json_agg(row_to_json(i)) FROM plan_installments i WHERE i.plan_id = $1) AS inst FROM treatment_plans WHERE id = $1`, [pending])).toEqual(before);
    const [audit] = await q<{ actor: string; details: Record<string, unknown> }>(
      `SELECT actor, details FROM audit_log WHERE action = 'plan.proposal_contact' AND entity_id = $1`, [String(pending)]);
    expect(audit).toMatchObject({ actor: "reception", details: { الملاحظة: "سيرد بعد العيد" } });
  });

  it("a consented, cancelled or missing plan is refused in Arabic", async () => {
    for (const planId of [consented, cancelled]) {
      expect(await recordProposalContact({ planId, note: null, actor: "reception", actorRole: "reception" }))
        .toEqual({ ok: false, status: 409, message: expect.stringMatching(/ليست عرضًا معلّقًا/) });
    }
    expect(await recordProposalContact({ planId: 999999, note: null, actor: "reception", actorRole: "reception" }))
      .toEqual({ ok: false, status: 404, message: "الخطة غير موجودة." });
  });
});
