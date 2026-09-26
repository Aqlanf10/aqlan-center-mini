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

  it("finance roles and an unrelated doctor see nothing medical", async () => {
    for (const session of [h.sessions.cashier, h.sessions.accountant, h.sessions.doctorB]) {
      const response = await authedGet(`/api/patients/${patientId}/medical-history`, session);
      expect(response.status).toBe(403);
      expect((await authedMutation(`/api/patients/${patientId}/vitals`, session, "POST", JSON.stringify({ pulse: 70 }))).status).toBe(403);
    }
  });
});
