import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (LIVE-3) عبر المسار الحقيقي: نداء المريض وإجلاسه وإنهاء تشغيله تُسجَّل باسم المستخدم
 * المسجَّل دخوله ودوره — من الجلسة لا من جسد الطلب. والحركة المرفوضة (409) لا تُسجَّل.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let visitId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: visitId }] } = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_name, status, arrived_at) VALUES ('مريض الطابور', 'waiting', NOW()) RETURNING id`));
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("(LIVE-3) PATCH /api/visits/[id] records the session user", () => {
  it("call, seat and finish carry the signed-in user and role; a spoofed actor in the body is ignored", async () => {
    const call = await authedMutation(`/api/visits/${visitId}`, h.sessions.reception, "PATCH",
      JSON.stringify({ action: "call", chair: 9, actor: "someone-else" }));
    expect(call.status).toBe(200);
    expect((await authedMutation(`/api/visits/${visitId}`, h.sessions.reception, "PATCH",
      JSON.stringify({ action: "seat", chair: 9 }))).status).toBe(200);
    expect((await authedMutation(`/api/visits/${visitId}`, h.sessions.admin, "PATCH",
      JSON.stringify({ action: "finish" }))).status).toBe(200);
    // إنهاءٌ ثانٍ مرفوض — ولا سطر له.
    expect((await authedMutation(`/api/visits/${visitId}`, h.sessions.admin, "PATCH",
      JSON.stringify({ action: "finish" }))).status).toBe(409);

    const { rows } = await db.query<{ action: string; actor: string; actor_role: string }>(
      `SELECT action, actor, actor_role FROM audit_log WHERE entity = 'visit' AND entity_id = $1 ORDER BY id`,
      [String(visitId)],
    );
    expect(rows).toEqual([
      { action: "visit.call", actor: "secreception", actor_role: "reception" },
      { action: "visit.seat", actor: "secreception", actor_role: "reception" },
      { action: "visit.finish", actor: "secadmin", actor_role: "admin" },
    ]);
  });
});
