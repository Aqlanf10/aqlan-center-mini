import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (P0-1) إعداد عمولة الطبيب على HTTP الحقيقي — التطبيق المبني نفسه.
 *
 * ما لا يثبته اختبار المكتبة: أن المسار يرفض الإعداد الخاطئ برسالةٍ عربية بدل أن
 * يحفظه «مُصحَّحًا» بالافتراضي، وأن تغيير النسبة من الشاشة يُدوَّن باسم من غيّر
 * بقيمته قبل وبعد وسريانه، ويُسجَّل في السجل الزمني الذي يقرؤه التقرير.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorUserId = 0;
let doctorPartyId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [user] } = await db.query<{ id: number; party_id: number }>(
    `SELECT id, party_id FROM users WHERE username = 'secdoctora'`,
  );
  doctorUserId = user.id;
  doctorPartyId = user.party_id;
}, 240_000);

afterAll(async () => {
  await db?.end();
});

async function patchUser(body: unknown) {
  return authedMutation(`/api/users/${doctorUserId}`, h.sessions.admin, "PATCH", JSON.stringify(body));
}

describe("إعداد العمولة المتقدّم — تحقّق صارم", () => {
  it("نسبة ١٥٠٪ تُرفض برسالة — لا تُستبدل بالافتراضي ٣٠٪ بصمت", async () => {
    const response = await patchUser({ commissionConfig: { calculationMode: "percentage", defaultPercent: 150 } });
    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.message).toContain("بين 0 و100");
    const { rows: [user] } = await db.query<{ commission_config: string | null }>(
      `SELECT commission_config FROM users WHERE id = $1`, [doctorUserId],
    );
    expect(user.commission_config ?? "").not.toContain("150");
  });

  it("«المبلغ الثابت» غير المنفَّذ يُرفض بدل أن يُحفظ إعدادٌ لا يفعل ما يقوله", async () => {
    const response = await patchUser({ commissionConfig: { calculationMode: "fixed", defaultPercent: 30 } });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("المبلغ الثابت");
  });
});

describe("تغيير نسبة الطبيب من الشاشة — مستقبليّ ومدقَّق", () => {
  it("PATCH النسبة ⇒ سطر تدقيق بالفاعل وقبل/بعد والسريان، وصفّ جديد في السجل الزمني", async () => {
    const before = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM doctor_commission_history WHERE party_id = $1`, [doctorPartyId],
    );
    const response = await authedMutation(
      `/api/parties/${doctorPartyId}`, h.sessions.admin, "PATCH",
      JSON.stringify({ commissionPercent: 55, reason: "عقد عمل جديد" }),
    );
    expect(response.status).toBe(200);

    const { rows: [audit] } = await db.query<{ actor: string; details: Record<string, unknown> }>(
      `SELECT actor, details FROM audit_log
        WHERE action = 'doctor.commission.update' AND entity = 'party' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [String(doctorPartyId)],
    );
    expect(audit.actor).toBe("secadmin");
    expect(audit.details["السبب"]).toBe("عقد عمل جديد");
    expect(audit.details["بعد_القيمة"]).toMatchObject({ percent: 55 });
    expect(audit.details["قبل_القيمة"]).toBeTruthy();
    expect(typeof audit.details["نافذ_من"]).toBe("string");

    const after = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM doctor_commission_history WHERE party_id = $1`, [doctorPartyId],
    );
    expect(Number(after.rows[0].n)).toBeGreaterThan(Number(before.rows[0].n));
  });

  it("الطبيب لا يغيّر نسبته بنفسه", async () => {
    const response = await authedMutation(
      `/api/parties/${doctorPartyId}`, h.sessions.doctorA, "PATCH", JSON.stringify({ commissionPercent: 99 }),
    );
    expect(response.status).toBe(403);
  });
});
