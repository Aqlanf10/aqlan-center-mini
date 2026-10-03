import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness, loginStaff } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorSession: { cookie: string };
let assistantSession: { cookie: string };
let doctorId = 0;
let doctorUserId = 0;
let own = 0;
let secondOwn = 0;
let foreign = 0;
let serial = 0;
const stamp = Date.now();
const username = `remdoctor${stamp}`;
const password = "Reminder#Synthetic11";
const post = (body: unknown, session = doctorSession) => authedMutation("/api/plans/reminders", session, "POST", JSON.stringify(body));
async function snapshot() {
  return (await db.query<{ data: unknown }>(`SELECT jsonb_build_object(
    'plans', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM treatment_plans t WHERE id = ANY($1::int[])),
    'installments', (SELECT jsonb_agg(to_jsonb(i) ORDER BY plan_id, number) FROM plan_installments i WHERE plan_id = ANY($1::int[])),
    'audits', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a
      WHERE action = 'plan.installment_reminder' AND entity_id = ANY($2::text[]))) AS data`,
  [[own, secondOwn, foreign], [own, secondOwn, foreign].map(String)])).rows[0].data;
}
async function plan(owned: boolean) {
  const patientId = (await db.query<{ id: number }>(`INSERT INTO patients (patient_number, full_name, primary_doctor_id)
    VALUES ($1, 'Synthetic HTTP reminder patient', $2) RETURNING id`, [`REM-HTTP-${stamp}-${++serial}`, owned ? doctorId : null])).rows[0].id;
  const id = (await db.query<{ id: number }>(`INSERT INTO treatment_plans (patient_id, title, total_minor)
    VALUES ($1, 'Synthetic HTTP reminder plan', 2000) RETURNING id`, [patientId])).rows[0].id;
  await db.query(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor)
    VALUES ($1, 1, CURRENT_DATE, 1000), ($1, 2, CURRENT_DATE + 1, 1000)`, [id]);
  return id;
}
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  for (const [name, role] of [[username, "doctor"], [`remassist${stamp}`, "assistant"]]) {
    const created = await authedMutation("/api/users", h.sessions.admin, "POST", JSON.stringify({
      username: name, displayName: `Synthetic reminder ${role}`, password, role,
    }));
    expect(created.status).toBeLessThan(300);
  }
  const user = (await db.query<{ id: number; party_id: number }>("SELECT id, party_id FROM users WHERE username = $1", [username])).rows[0];
  doctorUserId = user.id; doctorId = user.party_id;
  expect(doctorId).toBeGreaterThan(0);
  doctorSession = await loginStaff(username, password);
  assistantSession = await loginStaff(`remassist${stamp}`, password);
});
beforeEach(async () => {
  await db.query(`UPDATE users SET permissions = '{"canEditPlans":true,"canViewMoney":false}' WHERE id = $1`, [doctorUserId]);
  own = await plan(true); secondOwn = await plan(true); foreign = await plan(false);
});
afterAll(async () => { await db?.end(); });

describe("built HTTP plan reminder authorization and all-or-nothing results", () => {
  it("rejects foreign single/mixed batch targets despite broad read scope or forged body authority", async () => {
    await db.query(`UPDATE users SET permissions = '{"canEditPlans":true,"canViewAllPatients":true}' WHERE id = $1`, [doctorUserId]);
    const before = await snapshot();
    for (const body of [{ planId: foreign, actor: { role: "admin" }, role: "admin", partyId: doctorId }, { planIds: [own, foreign] }]) {
      const response = await post(body); expect(response.status).toBe(403);
      expect((await response.json()).message).toMatch(/[؀-ۿ]/);
      expect(await snapshot()).toEqual(before);
    }
  });
  it("a missing installment or mixed missing target returns404 with raw state unchanged", async () => {
    const before = await snapshot();
    for (const body of [{ planId: own, installmentNumber: 99 }, { planIds: [own, 2147483647] }]) {
      expect((await post(body)).status).toBe(404); expect(await snapshot()).toEqual(before);
    }
  });
  it("commits an owned single reminder with its audit and exact timestamp", async () => {
    const response = await post({ planId: own, installmentNumber: 2 }); expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ success: true, planId: own, installmentNumber: 2 });
    const planRow = (await db.query("SELECT last_reminder_at FROM treatment_plans WHERE id = $1", [own])).rows[0];
    expect(planRow.last_reminder_at.toISOString()).toBe(result.lastReminderAt);
    const installments = (await db.query("SELECT number, last_reminder_at FROM plan_installments WHERE plan_id = $1 ORDER BY number", [own])).rows;
    expect(installments[0].last_reminder_at).toBeNull(); expect(installments[1].last_reminder_at.toISOString()).toBe(result.lastReminderAt);
    const audit = (await db.query("SELECT actor, actor_role, details FROM audit_log WHERE action = 'plan.installment_reminder' AND entity_id = $1", [String(own)])).rows;
    expect(audit).toEqual([{ actor: username, actor_role: "doctor", details: { القسط: 2 } }]);
  });
  it("commits one timestamp and audit per unique authorized bulk plan", async () => {
    const response = await post({ planIds: [secondOwn, own, secondOwn] }); expect(response.status).toBe(200);
    const result = await response.json(); expect(result).toMatchObject({ success: true, updatedCount: 2 });
    const plans = (await db.query("SELECT last_reminder_at FROM treatment_plans WHERE id = ANY($1::int[])", [[own, secondOwn]])).rows;
    expect(plans.map((row) => row.last_reminder_at.toISOString())).toEqual([result.lastReminderAt, result.lastReminderAt]);
    const audits = (await db.query("SELECT entity_id, details FROM audit_log WHERE action = 'plan.installment_reminder' AND entity_id = ANY($1::text[])", [[own, secondOwn].map(String)])).rows;
    expect(audits).toHaveLength(2); expect(audits.map((row) => row.details)).toEqual([{ جماعي: true }, { جماعي: true }]);
  });
  it("uses current permission revocation on the very next request with the same cookie", async () => {
    expect((await post({ planId: own })).status).toBe(200);
    await db.query(`UPDATE users SET permissions = '{"canEditPlans":false,"canViewAllPatients":true}' WHERE id = $1`, [doctorUserId]);
    const before = await snapshot(); expect((await post({ planId: own })).status).toBe(403); expect(await snapshot()).toEqual(before);
  });
  it("rejects malformed permission storage instead of silently restoring defaults", async () => {
    await db.query("UPDATE users SET permissions = $2 WHERE id = $1", [doctorUserId, '{"canEditPlans":"true"}']);
    const before = await snapshot(); expect((await post({ planId: own })).status).toBe(403); expect(await snapshot()).toEqual(before);
  });
  it("preserves effective admin/reception access and cashier/accountant/assistant denial", async () => {
    const before = await snapshot();
    for (const session of [h.sessions.cashier, h.sessions.accountant, assistantSession]) {
      expect((await post({ planId: own }, session)).status).toBe(403); expect(await snapshot()).toEqual(before);
    }
    expect((await post({ planId: foreign }, h.sessions.reception)).status).toBe(200);
    expect((await post({ planId: foreign }, h.sessions.admin)).status).toBe(200);
  });
  it("rejects malformed scopes without filtering IDs or widening installment selection", async () => {
    const before = await snapshot();
    for (const body of [{ planId: own, installmentNumber: "bad" }, { planId: own, installmentNumber: 0 },
      { planIds: [own, "bad"] }, { planId: own, planIds: [own] }, { planId: String(own) }]) {
      expect((await post(body)).status).toBe(400); expect(await snapshot()).toEqual(before);
    }
  });
  it("maps real row contention to409 and leaves every target unchanged", async () => {
    const blocker = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await blocker.connect();
    const before = await snapshot();
    try {
      await blocker.query("BEGIN"); await blocker.query("SELECT id FROM treatment_plans WHERE id = $1 FOR UPDATE", [secondOwn]);
      const response = await post({ planIds: [own, secondOwn] }); expect(response.status).toBe(409);
      expect((await response.json()).message).toMatch(/[؀-ۿ]/); expect(await snapshot()).toEqual(before);
    } finally { await blocker.query("ROLLBACK"); await blocker.end(); }
    expect((await post({ planIds: [own, secondOwn] })).status).toBe(200);
  });
});
