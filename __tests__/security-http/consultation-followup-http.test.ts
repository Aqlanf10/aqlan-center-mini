import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/** (P1-E) متابعة عروض العلاج على التطبيق المبني: للإدارة والاستقبال فقط، والرفض بالعربية. */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let planId = 0;
const stamp = Date.now();

async function arabicDenied(response: Response) {
  expect([401, 403]).toContain(response.status);
  const body = await response.json().catch(() => ({})) as { message?: string };
  expect(body.message ?? "").toMatch(/[؀-ۿ]/);
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const patient = (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض كشف') RETURNING id`, [`CFH-${stamp}`])).rows[0].id;
  planId = (await db.query<{ id: number }>(
    `INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, 'عرض تقويم', 900000) RETURNING id`, [patient])).rows[0].id;
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("(P1-E) pending proposals over HTTP", () => {
  it("doctor, cashier and accountant are denied in Arabic", async () => {
    for (const session of [h.sessions.doctorA, h.sessions.cashier, h.sessions.accountant]) {
      await arabicDenied(await authedGet("/api/plans/proposals", session));
      await arabicDenied(await authedMutation("/api/plans/proposals", session, "POST", JSON.stringify({ planId })));
    }
  });

  it("reception lists the proposal and records a contact", async () => {
    const listed = await authedGet("/api/plans/proposals", h.sessions.reception);
    expect(listed.status).toBe(200);
    const body = await listed.json() as { proposals: { planId: number; timing: { stage: string } }[] };
    expect(body.proposals.map((row) => row.planId)).toContain(planId);
    const saved = await authedMutation("/api/plans/proposals", h.sessions.reception, "POST", JSON.stringify({ planId, note: "اتصال أول" }));
    expect(saved.status).toBe(200);
    const bad = await authedMutation("/api/plans/proposals", h.sessions.reception, "POST", JSON.stringify({ planId: "x" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toMatch(/[؀-ۿ]/);
  });
});
