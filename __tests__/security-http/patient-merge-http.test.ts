import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/** (P2-7) دمج ملفٍّ مكرر على التطبيق المبني — المدير وحده، بتأكيدٍ برقم المكرر. */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let targetId = 0;
let duplicateNumber = "";

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const stamp = Date.now() % 1_000_000;
  ({ rows: [{ id: targetId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'ملف أصلي للدمج') RETURNING id`, [`MRG-A-${stamp}`],
  ));
  duplicateNumber = `MRG-B-${stamp}`;
  const { rows: [dup] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, medical_alert) VALUES ($1, 'ملف مكرر للدمج', 'ربو') RETURNING id`,
    [duplicateNumber],
  );
  await db.query(`INSERT INTO visits (patient_id, patient_name, status) VALUES ($1, 'مكرر', 'done')`, [dup.id]);
}, 240_000);

afterAll(async () => {
  await db?.end();
});

const merge = (session: typeof h.sessions.admin, body: unknown) =>
  authedMutation(`/api/patients/${targetId}/merge`, session, "POST", JSON.stringify(body));

describe("P2-7 — merge a duplicate patient file", () => {
  it("reception and doctors are refused", async () => {
    const body = { duplicatePatientNumber: duplicateNumber, confirmDuplicateNumber: duplicateNumber };
    expect((await merge(h.sessions.reception, body)).status).toBe(403);
    expect((await merge(h.sessions.doctorA, body)).status).toBe(403);
  });

  it("a confirmation that does not match is refused in Arabic", async () => {
    const response = await merge(h.sessions.admin, { duplicatePatientNumber: duplicateNumber, confirmDuplicateNumber: "X" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toBe("أعد كتابة رقم الملف المكرر نفسه للتأكيد.");
  });

  it("the admin merges: visits move, the alert is kept, the duplicate is gone", async () => {
    const response = await merge(h.sessions.admin, {
      duplicatePatientNumber: duplicateNumber, confirmDuplicateNumber: duplicateNumber, reason: "تسجيل مزدوج",
    });
    expect(response.status).toBe(200);
    const payload = await response.json() as { moved: Record<string, number>; patient: { medicalAlert: string } };
    expect(payload.moved["visits.patient_id"]).toBe(1);
    expect(payload.patient.medicalAlert).toBe("ربو");
    expect((await db.query(`SELECT id FROM patients WHERE patient_number = $1`, [duplicateNumber])).rows).toHaveLength(0);
    expect((await merge(h.sessions.admin, {
      duplicatePatientNumber: duplicateNumber, confirmDuplicateNumber: duplicateNumber,
    })).status).toBe(404);
  });
});
