import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (P1-C) قرار فوترة الشدّة خارج العقد على التطبيق المبني: «بلا رسوم» للطبيب (على مريضه) أو المدير،
 * و«فوتِرت» للمدير والاستقبال؛ الكاشير والمحاسب خارجها — وكل رفضٍ بالعربية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let adjustmentId = 0;
const stamp = Date.now();

async function arabic(response: Response, statuses: number[]) {
  expect(statuses).toContain(response.status);
  const body = await response.json().catch(() => ({})) as { message?: string };
  expect(body.message ?? "").toMatch(/[؀-ۿ]/);
}
const decide = (who: keyof typeof h.sessions, body: unknown) =>
  authedMutation(`/api/ortho/adjustments/${adjustmentId}/billing-decision`, h.sessions[who], "POST", JSON.stringify(body));

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const patient = (await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض شدّة', $2) RETURNING id`,
    [`OCH-${stamp}`, doctor.party_id])).rows[0].id;
  const caseId = (await db.query<{ id: number }>(
    `INSERT INTO ortho_cases (patient_id, created_by, responsible_doctor_id) VALUES ($1, 'dr', $2) RETURNING id`,
    [patient, doctor.party_id])).rows[0].id;
  adjustmentId = (await db.query<{ id: number }>(
    `INSERT INTO ortho_adjustments (case_id, done_on, recorded_by, billing_class) VALUES ($1, CURRENT_DATE, 'dr', 'OUTSIDE_CONTRACT') RETURNING id`,
    [caseId])).rows[0].id;
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("(P1-C) outside-contract decision over HTTP", () => {
  it("cashier and accountant reach neither the list nor the decision", async () => {
    for (const who of ["cashier", "accountant"] as const) {
      await arabic(await authedGet("/api/ortho/billing-decisions", h.sessions[who]), [401, 403]);
      await arabic(await decide(who, { decision: "no_charge", reason: "سبب كافٍ" }), [401, 403]);
    }
  });

  it("reception cannot waive; another doctor cannot decide; bad input is 400 — all in Arabic", async () => {
    await arabic(await decide("reception", { decision: "no_charge", reason: "سبب كافٍ" }), [403]);
    await arabic(await decide("doctorB", { decision: "no_charge", reason: "سبب كافٍ" }), [403]);
    await arabic(await decide("doctorA", { decision: "maybe" }), [400]);
    await arabic(await decide("doctorA", { decision: "no_charge", reason: "x" }), [400]);
  });

  it("the treating doctor sees it pending and waives it with a reason, once", async () => {
    const listed = await authedGet("/api/ortho/billing-decisions", h.sessions.doctorA);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { pending: { adjustmentId: number }[] }).pending.map((row) => row.adjustmentId)).toContain(adjustmentId);
    const saved = await decide("doctorA", { decision: "no_charge", reason: "متابعة مجانية" });
    expect(saved.status).toBe(200);
    await arabic(await decide("doctorA", { decision: "no_charge", reason: "مرة ثانية" }), [409]);
  });
});
