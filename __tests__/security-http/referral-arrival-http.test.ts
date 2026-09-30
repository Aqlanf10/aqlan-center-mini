import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (REF-2) على التطبيق المبني: موعد الإحالة يسقط (لم يحضر) فتعود لانتظار الحجز، ثم يُعاد حجزها
 * ويصل المريض فتصير «وصل» وتحمل زيارتُه حالتها؛ و«عملي السريري» يعرضها للطبيب المستقبِل وحده.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let partyB = 0;
let referralId = 0;
let caseId = 0;
const stamp = Date.now();

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";
const post = (who: Who, path: string, body: unknown) => authedMutation(path, h.sessions[who], "POST", JSON.stringify(body));
const patch = (who: Who, path: string, body: unknown) => authedMutation(path, h.sessions[who], "PATCH", JSON.stringify(body));

async function bookToday(time: string): Promise<number> {
  const { rows: [row] } = await db.query<{ id: number }>(
    `INSERT INTO appointments (patient_id, scheduled_date, scheduled_time, doctor_id)
     VALUES ($1, (NOW() AT TIME ZONE 'Asia/Aden')::date, $2, $3) RETURNING id`, [patientId, time, partyB]);
  return row.id;
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctorA] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const { rows: [doctorB] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctorb'`);
  partyB = doctorB.party_id;
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض وصول الإحالة', $2) RETURNING id`,
    [`RA-${stamp}`, doctorA.party_id]);
  patientId = patient.id;
  const { rows: [clinicalCase] } = await db.query<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, responsible_party_id, created_by)
     VALUES ($1, 'endodontics', 'علاج جذور 21', $2, 'secdoctora') RETURNING id`, [patientId, partyB]);
  caseId = clinicalCase.id;
}, 120_000);

afterAll(async () => { await db?.end(); });

describe("REF-2 — arrival, no-show and «عملي السريري» over HTTP", () => {
  it("doctor A refers inside the center with the case; doctor B accepts", async () => {
    const created = await post("doctorA", `/api/patients/${patientId}/referrals`, {
      kind: "internal", toPartyId: partyB, toSpecialty: "endodontics", reason: "علاج عصب 21", teeth: "21", caseId,
    });
    expect(created.status).toBe(201);
    referralId = (await created.json() as { id: number }).id;
    expect((await post("doctorB", `/api/referrals/${referralId}/transition`, { action: "accept" })).status).toBe(200);
  });

  it("a no-show returns it to waiting for booking with «لم يحضر»", async () => {
    const appointmentId = await bookToday("08:00");
    expect((await post("reception", `/api/referrals/${referralId}/transition`, { action: "schedule", appointmentId })).status).toBe(200);
    expect((await patch("reception", `/api/appointments/${appointmentId}`, { action: "no_show" })).status).toBe(200);
    const list = await authedGet(`/api/patients/${patientId}/referrals`, h.sessions.reception);
    const referral = (await list.json() as { id: number; workflowState: string; missedAppointment: string | null }[])
      .find((one) => one.id === referralId);
    expect(referral).toMatchObject({ workflowState: "accepted", missedAppointment: "no_show" });
  });

  it("rebooked and arrived: the referral is «arrived» and the visit carries its case", async () => {
    const appointmentId = await bookToday("13:00");
    expect((await post("reception", `/api/referrals/${referralId}/transition`, { action: "schedule", appointmentId })).status).toBe(200);
    expect((await patch("reception", `/api/appointments/${appointmentId}`, { action: "arrive" })).status).toBe(200);
    const { rows: [visit] } = await db.query<{ case_id: number | null }>(`SELECT case_id FROM visits WHERE appointment_id = $1`, [appointmentId]);
    expect(visit.case_id).toBe(caseId);
    const { rows: [referral] } = await db.query<{ workflow_state: string }>(`SELECT workflow_state FROM patient_referrals WHERE id = $1`, [referralId]);
    expect(referral.workflow_state).toBe("arrived");
    const { rows: audit } = await db.query<{ action: string; actor: string }>(
      `SELECT action, actor FROM audit_log WHERE entity = 'patient' AND entity_id = $1 AND action IN ('referral.arrive', 'referral.unschedule') ORDER BY id`,
      [String(patientId)]);
    expect(audit.map((row) => row.action)).toEqual(["referral.unschedule", "referral.arrive"]);
    expect(audit.every((row) => row.actor === "secreception")).toBe(true);
  });

  it("«عملي السريري»: doctor B sees the referral and today's patient; others are refused in Arabic", async () => {
    const mine = await authedGet(`/api/referrals/mine`, h.sessions.doctorB);
    expect(mine.status).toBe(200);
    const body = await mine.json() as { toMe: { id: number }[]; today: { patientId: number; referralId: number | null }[] };
    expect(body.toMe.map((one) => one.id)).toContain(referralId);
    expect(body.today.find((one) => one.patientId === patientId)?.referralId).toBe(referralId);
    for (const who of ["reception", "cashier", "accountant"] as const) {
      const refused = await authedGet(`/api/referrals/mine`, h.sessions[who]);
      expect(refused.status).toBe(403);
      const payload = await refused.json() as Record<string, unknown>;
      expect(Object.keys(payload)).toEqual(["message"]);
      expect(String(payload.message)).toMatch(/[؀-ۿ]/);
    }
  });

  it("the patient summary and timeline show the referral to the receiving doctor", async () => {
    const timeline = await authedGet(`/api/patients/${patientId}/timeline`, h.sessions.doctorB);
    expect(timeline.status).toBe(200);
    const text = JSON.stringify(await timeline.json());
    expect(text).toContain(`إحالة #${referralId}`);
  });
});
