import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { TEST_USERS, authedMutation, harness } from "./_server";

/**
 * (FIN-3) PATCH /api/plans/[id]: إلغاء الخطة وإحياء الملغاة بسببٍ مكتوب، وكل تغييرٍ في التدقيق
 * باسم من فعله. و«اكتملت» (زر الشاشة الوحيد) لا تحتاج سببًا.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let planId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'حالة الخطة') RETURNING id`, [`FIN3H-${Date.now()}`]);
  ({ rows: [{ id: planId }] } = await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, start_date, created_by)
     VALUES ($1, 'خطة الحالات', 100000, 'YER', CURRENT_DATE, 't') RETURNING id`, [patient.id]));
}, 120_000);
afterAll(async () => { await db?.end(); });

const patch = (body: Record<string, unknown>) =>
  authedMutation(`/api/plans/${planId}`, h.sessions.reception, "PATCH", JSON.stringify(body));

describe("(FIN-3) plan status over HTTP", () => {
  it("cancel and reactivate need a reason; completing does not; every change is audited with its actor", async () => {
    const noReason = await patch({ status: "cancelled" });
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as { message: string }).message).toBe("اكتب سبب إلغاء الخطة.");

    expect((await patch({ status: "cancelled", reason: "انسحب المريض" })).status).toBe(200);

    const revive = await patch({ status: "active" });
    expect(revive.status).toBe(400);
    expect((await revive.json() as { message: string }).message).toBe("اكتب سبب إعادة تفعيل الخطة الملغاة.");
    expect((await patch({ status: "active", reason: "عاد المريض" })).status).toBe(200);

    expect((await patch({ status: "completed" })).status).toBe(200);

    const { rows } = await db.query<{ actor: string; details: Record<string, unknown> }>(
      `SELECT actor, details FROM audit_log WHERE action = 'plan.status' AND entity_id = $1 ORDER BY id`, [String(planId)]);
    expect(rows.map((row) => [row.details.من, row.details.إلى, row.details.السبب ?? null])).toEqual([
      ["active", "cancelled", "انسحب المريض"],
      ["cancelled", "active", "عاد المريض"],
      ["active", "completed", null],
    ]);
    expect(new Set(rows.map((row) => row.actor))).toEqual(new Set([TEST_USERS.reception.username]));
  });
});
