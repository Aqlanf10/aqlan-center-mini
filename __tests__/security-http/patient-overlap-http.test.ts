import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/** Same-patient overlap and nearby-booking confirmation are distinct guards. */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId: number;
let firstId: number;
const isolatedDates = ["2026-11-25", "2026-12-02", "2026-12-09"];
let fixtureIndex = 0;
let date: string;

async function book(time: string, durationMinutes = 30, nearbyAppointmentConfirmation?: string) {
  return authedMutation("/api/appointments", h.sessions.reception, "POST", JSON.stringify({
    patientId, date, time, durationMinutes, appointmentType: "consultation",
    ...(nearbyAppointmentConfirmation ? { nearbyAppointmentConfirmation } : {}),
  }));
}
async function appointments() {
  return (await db.query(
    `SELECT id, status, to_char(scheduled_date, 'YYYY-MM-DD') AS date,
       to_char(scheduled_time, 'HH24:MI') AS time, duration_minutes AS duration
     FROM appointments WHERE patient_id=$1 ORDER BY id`, [patientId],
  )).rows;
}
async function expectOverlap(response: Response) {
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body).toMatchObject({ state: "OVER_CAPACITY", canOverride: false });
  expect(body.message).toContain("المريض محجوزٌ في هذا الوقت");
  expect(body).not.toHaveProperty("kind", "nearby_patient_appointments");
  expect(body).not.toHaveProperty("confirmationToken");
}

beforeAll(async () => {
  h = await harness();
  const target = new URL(h.seeded.dbUrl);
  expect(["127.0.0.1", "localhost", "[::1]"]).toContain(target.hostname);
  expect(target.pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
}, 240_000);
afterAll(async () => { await db?.end(); });
beforeEach(async () => {
  date = isolatedDates[fixtureIndex++];
  expect(date).toBeDefined();
  // A separate patient per assertion removes both cross-suite booking state
  // and dependence on the preceding overlap assertion's successful setup.
  const result = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id)
     SELECT $1, $2, primary_doctor_id FROM patients WHERE id=$3 RETURNING id`,
    [`OVERLAP-${randomUUID()}`, "مريض تداخل مواعيد اصطناعي", h.seeded.patientAId],
  );
  expect(result.rowCount).toBe(1);
  patientId = result.rows[0].id;
  const first = await book("10:00", 60);
  expect(first.status).toBe(201);
  firstId = (await first.json()).id;
  expect(Number.isSafeInteger(firstId)).toBe(true);
});

describe("P2-3 — same-patient overlap guard", () => {
  it("audit repro: the same patient at the same time is refused with an Arabic message", async () => {
    const before = await appointments();
    await expectOverlap(await book("10:00"));
    expect(await appointments()).toEqual(before);
  });

  it("an overlap inside the first appointment's duration is refused too", async () => {
    const before = await appointments();
    await expectOverlap(await book("10:30"));
    expect(await appointments()).toEqual(before);
  });

  it("back-to-back is allowed only after confirming the separate nearby warning", async () => {
    const before = await appointments();
    const warning = await book("11:00");
    expect(warning.status).toBe(409);
    const body = await warning.json();
    expect(body).toMatchObject({ kind: "nearby_patient_appointments", canOverride: false });
    expect(body.nearbyAppointments).toEqual([
      expect.objectContaining({ id: firstId, scheduledDate: date, scheduledTime: "10:00" }),
    ]);
    expect(typeof body.confirmationToken).toBe("string");
    expect(body.confirmationToken.length).toBeGreaterThan(0);
    expect(await appointments()).toEqual(before);
    const confirmed = await book("11:00", 30, body.confirmationToken);
    expect(confirmed.status).toBe(201);
    const secondId = (await confirmed.json()).id;
    expect(Number.isSafeInteger(secondId)).toBe(true);
    expect(secondId).not.toBe(firstId);
    expect(await appointments()).toEqual([
      ...before, { id: secondId, status: "booked", date, time: "11:00", duration: 30 },
    ]);
  });
});
