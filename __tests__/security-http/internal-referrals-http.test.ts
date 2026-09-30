import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (REF-1) الإحالة الداخلية على التطبيق المبني: الطبيب (أ) يحيل مريضه إلى الطبيب (ب) داخل المركز.
 * من ينشئ، ومن يقبل، ومن يحجز، ومن يُكمل، ومن يطّلع — وكل رفضٍ برسالة عربية وحدها بلا تفاصيل داخلية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let partyB = 0;
let referralId = 0;
const stamp = Date.now();

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";
const post = (who: Who, path: string, body: unknown) => authedMutation(path, h.sessions[who], "POST", JSON.stringify(body));
const step = (who: Who, body: Record<string, unknown>, id = referralId) => post(who, `/api/referrals/${id}/transition`, body);
const create = (who: Who, extra: Record<string, unknown> = {}) => post(who, `/api/patients/${patientId}/referrals`, {
  kind: "internal", toPartyId: partyB, toSpecialty: "endodontics", reason: "علاج عصب ٢١ قبل تركيب الحاصرة",
  teeth: "21", urgency: "soon", ...extra,
});

/** الخطأ يحمل رسالة عربية ولا شيء غيرها. */
async function expectArabicOnly(response: Response, status: number, contains?: string) {
  expect(response.status).toBe(status);
  const body = await response.json() as Record<string, unknown>;
  expect(Object.keys(body)).toEqual(["message"]);
  expect(String(body.message)).toMatch(/[؀-ۿ]/);
  if (contains) expect(String(body.message)).toContain(contains);
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctorA] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const { rows: [doctorB] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctorb'`);
  partyB = doctorB.party_id;
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'محمد أحمد — إحالة داخلية', $2) RETURNING id`,
    [`IR-${stamp}`, doctorA.party_id]);
  patientId = patient.id;
}, 120_000);

afterAll(async () => { await db?.end(); });

describe("REF-1 — internal referral permissions over HTTP", () => {
  it("the receiving doctor cannot open the patient before the referral", async () => {
    expect((await authedGet(`/api/patients/${patientId}`, h.sessions.doctorB)).status).toBe(403);
  });

  it("reception, cashier and accountant cannot create an internal referral", async () => {
    await expectArabicOnly(await create("reception"), 403);
    await expectArabicOnly(await create("cashier"), 403);
    await expectArabicOnly(await create("accountant"), 403);
  });

  it("a referral to oneself is refused in Arabic", async () => {
    const { rows: [doctorA] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
    await expectArabicOnly(await create("doctorA", { toPartyId: doctorA.party_id }), 400);
  });

  it("the patient's doctor creates it: requested, to the receiving doctor", async () => {
    const response = await create("doctorA");
    expect(response.status).toBe(201);
    const body = await response.json() as { id: number; kind: string; workflowState: string; status: string; toPartyId: number };
    expect(body).toMatchObject({ kind: "internal", workflowState: "requested", status: "sent", toPartyId: partyB });
    referralId = body.id;
  });

  it("the receiving doctor can now open the referred patient's file and referrals", async () => {
    expect((await authedGet(`/api/patients/${patientId}`, h.sessions.doctorB)).status).toBe(200);
    const list = await authedGet(`/api/patients/${patientId}/referrals`, h.sessions.doctorB);
    expect(list.status).toBe(200);
    expect((await list.json() as { id: number }[]).map((one) => one.id)).toContain(referralId);
  });

  it("only the receiver accepts; an illegal step is 409; other roles get an Arabic 403", async () => {
    await expectArabicOnly(await step("reception", { action: "accept" }), 403);
    await expectArabicOnly(await step("doctorA", { action: "accept" }), 403, "المحال إليه");
    await expectArabicOnly(await step("cashier", { action: "accept" }), 403);
    await expectArabicOnly(await step("accountant", { action: "accept" }), 403);
    await expectArabicOnly(await step("doctorB", { action: "complete", procedurePerformed: "حشو قنوات" }), 409);
    await expectArabicOnly(await step("doctorB", { action: "fly" }), 400);
    const accepted = await step("doctorB", { action: "accept" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ workflowState: "accepted", status: "sent" });
  });

  it("reception schedules it on a booked appointment with the receiving doctor; reception cannot complete", async () => {
    const { rows: [appointment] } = await db.query<{ id: number }>(
      `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, doctor_id) VALUES ($1, CURRENT_DATE + 3, '10:00', $2) RETURNING id`,
      [patientId, partyB]);
    await expectArabicOnly(await step("reception", { action: "schedule" }), 400);
    const scheduled = await step("reception", { action: "schedule", appointmentId: appointment.id });
    expect(scheduled.status).toBe(200);
    expect(await scheduled.json()).toMatchObject({ workflowState: "scheduled", appointmentId: appointment.id });
    await expectArabicOnly(await step("reception", { action: "complete", procedurePerformed: "حشو قنوات ٢١" }), 403);
  });

  it("the receiving doctor completes; the referrer acknowledges; nothing reopens", async () => {
    await expectArabicOnly(await step("doctorB", { action: "complete" }), 400);
    const done = await step("doctorB", {
      action: "complete", procedurePerformed: "حشو قنوات ٢١", followupRequired: true, mayReturn: false, note: "جاهز للحاصرة",
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ workflowState: "completed", status: "completed", procedurePerformed: "حشو قنوات ٢١" });

    const mine = await authedGet(`/api/referrals/mine`, h.sessions.doctorA);
    expect(mine.status).toBe(200);
    expect((await mine.json() as { returnedToMe: { id: number }[] }).returnedToMe.map((one) => one.id)).toContain(referralId);

    await expectArabicOnly(await step("doctorB", { action: "acknowledge" }), 403, "المحيل");
    const seen = await step("doctorA", { action: "acknowledge" });
    expect(seen.status).toBe(200);
    expect(await seen.json()).toMatchObject({ workflowState: "returned_to_referrer" });
    await expectArabicOnly(await step("doctorA", { action: "cancel", note: "متأخر" }), 409);
  });

  it("the external close endpoint refuses an internal referral", async () => {
    await expectArabicOnly(await authedMutation(`/api/referrals/${referralId}`, h.sessions.reception, "PATCH",
      JSON.stringify({ action: "complete", note: "تم" })), 409);
  });

  it("the referrer cancels an open one only with a reason; the receiver cannot cancel", async () => {
    const response = await create("doctorA", { reason: "تقييم ٤٦", teeth: "46" });
    expect(response.status).toBe(201);
    const { id } = await response.json() as { id: number };
    await expectArabicOnly(await step("doctorA", { action: "cancel" }, id), 400);
    await expectArabicOnly(await step("doctorB", { action: "cancel", note: "لا أستطيع" }, id), 403);
    const cancelled = await step("doctorA", { action: "cancel", note: "المريض فضّل مركزًا آخر" }, id);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ workflowState: "cancelled", status: "cancelled" });
  });

  it("'my referrals' is for doctors; reception and cashier are refused in Arabic", async () => {
    await expectArabicOnly(await authedGet(`/api/referrals/mine`, h.sessions.reception), 403);
    await expectArabicOnly(await authedGet(`/api/referrals/mine`, h.sessions.cashier), 403);
  });

  it("every step is audited", async () => {
    const { rows } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE entity = 'patient' AND entity_id = $1 AND action LIKE 'referral.%' ORDER BY id`,
      [String(patientId)]);
    expect(rows.map((row) => row.action)).toEqual([
      "referral.create", "referral.accept", "referral.schedule", "referral.complete", "referral.return",
      "referral.create", "referral.cancel",
    ]);
  });
});
