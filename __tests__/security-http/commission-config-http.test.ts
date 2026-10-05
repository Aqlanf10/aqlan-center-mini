import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import type { DoctorCommissionConfig } from "../../lib/doctor-permissions";

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

describe("legacy commission normalization through real HTTP", () => {
  it.each([false, true])("no-op saves preserve history; explicit empty list = %s", async (explicitEmpty) => {
    expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
    expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
    const suffix = `${Date.now()}-${explicitEmpty ? "empty" : "legacy"}`;
    const config: DoctorCommissionConfig = {
      calculationMode: "by_category", defaultPercent: 25, categoryRates: {},
      serviceRates: { "7": 61.25, "Legacy crown": 0 },
      ...(explicitEmpty ? { customServiceRates: [] } : {}),
      fixedAmountPerVisitMinor: 0, deductLabCost: false, deductMaterialCost: false,
      basis: "invoiced", effectiveDate: "2024-03-10", rateHistory: [],
    };
    const expectedRates = explicitEmpty ? {} : config.serviceRates;
    // Fresh owned fixtures, following commission-raw-category-http. Existing
    // users and historical rows are never changed; retain these facts as well.
    const { rows: [party] } = await db.query<{ id: number }>(
      `INSERT INTO parties (name, kind, commission_percent) VALUES ($1, 'doctor', 20) RETURNING id`,
      [`Commission roundtrip ${suffix}`],
    );
    const { rows: [user] } = await db.query<{ id: number }>(
      `INSERT INTO users (username, display_name, password_hash, role, party_id, commission_config)
       VALUES ($1, $1, 'unused-synthetic-hash', 'doctor', $2, $3) RETURNING id`,
      [`roundtrip-${suffix}`, party.id, JSON.stringify(config)],
    );
    await db.query(`INSERT INTO doctor_commission_history
      (party_id, percent, config, effective_from, source, reason, recorded_by)
      VALUES ($1, 20, $2::jsonb, '1970-01-01T00:00:00Z', 'baseline', 'owned previous policy', 'test'),
             ($1, 20, $3::jsonb, '2024-03-10T00:00:00Z', 'advanced', 'owned current policy', 'test')`,
    [party.id, JSON.stringify({ ...config, defaultPercent: 12.5 }), JSON.stringify(config)]);
    const history = async () => (await db.query<{ snapshot: Record<string, unknown> }>(
      `SELECT to_jsonb(h) AS snapshot FROM doctor_commission_history h WHERE party_id = $1 ORDER BY id`, [party.id],
    )).rows.map(({ snapshot }) => snapshot);
    const prefix = await history();
    expect(prefix).toHaveLength(2);

    const unchangedParty = await authedMutation(`/api/parties/${party.id}`, h.sessions.admin, "PATCH",
      JSON.stringify({ commissionPercent: 20 }));
    expect(unchangedParty.status).toBe(200);
    expect(await history()).toEqual(prefix);

    let current: DoctorCommissionConfig = config;
    for (let pass = 0; pass < 2; pass += 1) {
      const response = await authedGet("/api/users", h.sessions.admin);
      expect(response.status).toBe(200);
      const users = await response.json() as Array<{ id: number; commissionConfig: DoctorCommissionConfig }>;
      const listed = users.find((entry) => entry.id === user.id);
      expect(listed).toBeDefined();
      if (!listed) throw new Error("Owned doctor user missing");
      // API serialization and its strict validator are real. This does not
      // exercise or relax the legacy financial editor's read-only UI guard.
      const saved = await authedMutation(`/api/users/${user.id}`, h.sessions.admin, "PATCH",
        JSON.stringify({ commissionConfig: listed.commissionConfig }));
      expect(saved.status).toBe(200);
      current = (await saved.json() as { commissionConfig: DoctorCommissionConfig }).commissionConfig;
      expect(await history()).toEqual(prefix);
      expect(current.serviceRates).toEqual(expectedRates);
      expect(Object.prototype.hasOwnProperty.call(current, "customServiceRates")).toBe(explicitEmpty);
      if (explicitEmpty) expect(current.customServiceRates).toEqual([]);
    }

    const changed = await authedMutation(`/api/users/${user.id}`, h.sessions.admin, "PATCH",
      JSON.stringify({ commissionConfig: { ...current, defaultPercent: 27.5 }, reason: "intentional roundtrip change" }));
    expect(changed.status).toBe(200);
    const after = await history();
    expect(after).toHaveLength(prefix.length + 1);
    expect(after.slice(0, prefix.length)).toEqual(prefix);
    expect(after[prefix.length]).toMatchObject({
      percent: 20, source: "advanced", recorded_by: "secadmin", reason: "intentional roundtrip change",
    });
    expect(after[prefix.length].config).toEqual({ ...current, defaultPercent: 27.5 });
  });
});
