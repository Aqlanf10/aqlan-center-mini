import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, harness } from "./_server";

/**
 * (P2-3) المريض نفسه لا يُحجز مرتين في الوقت نفسه — عبر مسار الحجز الحقيقي.
 * العيب (تدقيق الجاهزية): موعدٌ ثانٍ للمريض والتاريخ والوقت والطبيب نفسها ⇒ 201.
 */

let h: Awaited<ReturnType<typeof harness>>;
let patientId: number;
let db: Client;
const date = "2026-08-12";

async function book(time: string, durationMinutes = 30, nearbyAppointmentConfirmation?: string) {
  return authedMutation("/api/appointments", h.sessions.reception, "POST", JSON.stringify({
    patientId, date, time, durationMinutes, appointmentType: "consultation", nearbyAppointmentConfirmation,
  }));
}

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl });
  await db.connect();
  const patient = await db.query<{ id: number }>(
    "INSERT INTO patients(patient_number, full_name) VALUES ($1, $2) RETURNING id",
    ["SYN-OVERLAP-HTTP", "Synthetic overlap patient"],
  );
  patientId = patient.rows[0].id;
}, 240_000);

afterAll(async () => {
  if (!db) return;
  try {
    await db.query("DELETE FROM appointments WHERE patient_id=$1", [patientId]);
    await db.query("DELETE FROM patients WHERE id=$1", [patientId]);
  } finally {
    await db.end();
  }
});

describe("P2-3 — same-patient overlap guard", () => {
  it("audit repro: the same patient at the same time is refused with an Arabic message", async () => {
    const first = await book("10:00", 60);
    expect(first.status).toBe(201);
    const second = await book("10:00");
    expect(second.status).toBe(409);
    const body = await second.json() as { message: string; canOverride: boolean };
    expect(body.message).toContain("المريض محجوزٌ في هذا الوقت");
    expect(body.canOverride).toBe(false);
  });

  it("an overlap inside the first appointment's duration is refused too", async () => {
    expect((await book("10:30")).status).toBe(409);
  });

  it("allows back-to-back visits after confirming the nearby appointment", async () => {
    const pending = await book("11:00");
    expect(pending.status).toBe(409);
    const warning = await pending.json();
    expect(warning).toMatchObject({ kind: "nearby_patient_appointments", confirmationToken: expect.any(String) });
    expect((await book("11:00", 30, warning.confirmationToken)).status).toBe(201);
  });
});
