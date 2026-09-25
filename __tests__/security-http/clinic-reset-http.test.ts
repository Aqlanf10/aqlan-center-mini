import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * إعادة الضبط عبر المسار الحقيقي: للمدير وحده، بعبارة التأكيد وكلمة المرور — و**لا
 * مسح بلا نسخة احتياطية متحقَّق منها** (بيئة الاختبار بلا قرص دائم، فيُرفض ولا يُمسح شيء).
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
const PHRASE = "امسح البيانات التجريبية";
const ADMIN_PASSWORD = "SecAdmin#Pass1";

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 120_000);
afterAll(async () => { await db?.end(); });

const patients = async () => Number((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM patients`)).rows[0].n);
const post = (session: Parameters<typeof authedMutation>[1], body: Record<string, unknown>) =>
  authedMutation("/api/settings/reset", session, "POST", JSON.stringify(body));

describe("/api/settings/reset", () => {
  it("is admin-only for preview and reset", async () => {
    for (const session of [h.sessions.reception, h.sessions.doctorA]) {
      expect((await authedGet("/api/settings/reset", session)).status).toBe(403);
      expect((await post(session, { phrase: PHRASE, password: "x" })).status).toBe(403);
    }
  });

  it("previews counts without touching anything", async () => {
    const before = await patients();
    const response = await authedGet("/api/settings/reset", h.sessions.admin);
    expect(response.status).toBe(200);
    const body = await response.json() as { phrase: string; groups: { label: string; count: number }[] };
    expect(body.phrase).toBe(PHRASE);
    expect(body.groups.find((group) => group.label === "المرضى")?.count).toBe(before);
    expect(await patients()).toBe(before);
  });

  it("refuses a wrong phrase or password with Arabic messages", async () => {
    const before = await patients();
    const wrongPhrase = await post(h.sessions.admin, { phrase: "امسح", password: ADMIN_PASSWORD });
    expect(wrongPhrase.status).toBe(400);
    expect((await wrongPhrase.json() as { message: string }).message).toContain(PHRASE);
    const wrongPassword = await post(h.sessions.admin, { phrase: PHRASE, password: "خطأ" });
    expect(wrongPassword.status).toBe(400);
    expect((await wrongPassword.json() as { message: string }).message).toBe("كلمة المرور غير صحيحة.");
    expect(await patients()).toBe(before);
  });

  it("wipes nothing when the pre-reset backup cannot be taken", async () => {
    const before = await patients();
    expect(before).toBeGreaterThan(0);
    const response = await post(h.sessions.admin, { phrase: PHRASE, password: ADMIN_PASSWORD });
    expect(response.status).toBe(409);
    expect((await response.json() as { message: string }).message).toContain("لم يُمسح شيء");
    expect(await patients()).toBe(before);
    const { rows } = await db.query(`SELECT 1 FROM audit_log WHERE action = 'system.reset'`);
    expect(rows).toHaveLength(0);
  });
});
