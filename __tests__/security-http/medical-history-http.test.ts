import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (PAT-2) التاريخ الطبي والعلامات الحيوية عبر المسار الحقيقي: الاستقبال والمدير يعبّئان،
 * الأدوار المالية لا ترى شيئًا طبيًّا، والطبيب يرى مرضاه فقط، والمستحيل يُرفض بالعربية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
const arabic = /[؀-ۿ]/;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'مريض الاستبيان') RETURNING id`, [`MHH-${Date.now()}`]));
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("(PAT-2) /api/patients/[id]/medical-history and /vitals", () => {
  it("reception fills the questionnaire; the file then shows derived alerts and no review due", async () => {
    const before = await (await authedGet(`/api/patients/${patientId}/medical-history`, h.sessions.reception)).json() as { review: { due: boolean } };
    expect(before.review.due).toBe(true);
    const saved = await authedMutation(`/api/patients/${patientId}/medical-history`, h.sessions.reception, "POST", JSON.stringify({
      answers: { anticoagulants: "yes" }, allergies: [{ substance: "بنسلين", severity: "severe" }], bloodGroup: "B+", patientConfirmed: true,
    }));
    expect(saved.status).toBe(201);
    const after = await (await authedGet(`/api/patients/${patientId}/medical-history`, h.sessions.admin)).json() as {
      alerts: { label: string }[]; review: { due: boolean }; latest: { bloodGroup: string };
    };
    expect(after.review.due).toBe(false);
    expect(after.latest.bloodGroup).toBe("B+");
    expect(after.alerts.map((alert) => alert.label)).toEqual(["حساسية بنسلين (شديدة)", "على مميّعات دم"]);
  });

  it("records vitals and refuses impossible readings in Arabic", async () => {
    expect((await authedMutation(`/api/patients/${patientId}/vitals`, h.sessions.reception, "POST",
      JSON.stringify({ bpSystolic: 120, bpDiastolic: 80, pulse: 70 }))).status).toBe(201);
    const bad = await authedMutation(`/api/patients/${patientId}/vitals`, h.sessions.reception, "POST", JSON.stringify({ pulse: 999 }));
    expect(bad.status).toBe(400);
    expect((await bad.json() as { message: string }).message).toMatch(arabic);
  });

  it("saves the chosen historical date and alert together without putting the backdated reading first", async () => {
    const current = await authedMutation(`/api/patients/${patientId}/vitals`, h.sessions.reception, "POST",
      JSON.stringify({ pulse: 75, medicalAlert: "تنبيه حالي" }));
    expect(current.status).toBe(201);
    const old = await authedMutation(`/api/patients/${patientId}/vitals`, h.sessions.reception, "POST",
      JSON.stringify({ pulse: 72, recordedAt: "2025-03-04", medicalAlert: "تنبيه سابق" }));
    expect(old.status).toBe(201);
    const oldVital = await old.json() as { id: number };
    const { rows: [saved] } = await db.query<{ day: string; medical_alert: string }>(
      `SELECT to_char(v.recorded_at AT TIME ZONE 'Asia/Aden', 'YYYY-MM-DD') AS day, p.medical_alert
       FROM patient_vitals v JOIN patients p ON p.id = v.patient_id WHERE v.id = $1`, [oldVital.id]);
    expect(saved).toEqual({ day: "2025-03-04", medical_alert: "تنبيه سابق" });
    const list = await (await authedGet(`/api/patients/${patientId}/vitals`, h.sessions.reception)).json() as { vitals: { id: number }[] };
    expect(list.vitals[0].id).not.toBe(oldVital.id);
    expect((await authedMutation(`/api/patients/${patientId}/vitals`, h.sessions.reception, "POST",
      JSON.stringify({ pulse: 70, recordedAt: "2025-02-30" }))).status).toBe(400);
  });

  it("allows a doctor to read an owned file but blocks writes when edit permission is removed", async () => {
    const ownId = h.seeded.patientAId;
    const { rows: [doctor] } = await db.query<{ permissions: string }>(
      `SELECT permissions FROM users WHERE username = 'secdoctora'`);
    const permissions = JSON.parse(doctor.permissions) as Record<string, boolean>;
    try {
      await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`,
        [JSON.stringify({ ...permissions, canEditPatient: false })]);
      expect((await authedGet(`/api/patients/${ownId}/medical-history`, h.sessions.doctorA)).status).toBe(200);
      expect((await authedGet(`/api/patients/${ownId}/vitals`, h.sessions.doctorA)).status).toBe(200);
      expect((await authedMutation(`/api/patients/${ownId}/medical-history`, h.sessions.doctorA, "POST",
        JSON.stringify({ answers: {} }))).status).toBe(403);
      expect((await authedMutation(`/api/patients/${ownId}/vitals`, h.sessions.doctorA, "POST",
        JSON.stringify({ pulse: 70 }))).status).toBe(403);
    } finally {
      await db.query(`UPDATE users SET permissions = $1 WHERE username = 'secdoctora'`, [doctor.permissions]);
    }
  });

  it("finance roles and an unrelated doctor see nothing medical", async () => {
    for (const session of [h.sessions.cashier, h.sessions.accountant, h.sessions.doctorB]) {
      const response = await authedGet(`/api/patients/${patientId}/medical-history`, session);
      expect(response.status).toBe(403);
      expect((await authedMutation(`/api/patients/${patientId}/vitals`, session, "POST", JSON.stringify({ pulse: 70 }))).status).toBe(403);
    }
  });
});
