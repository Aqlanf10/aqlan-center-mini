import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let date = "";
let doctorId = 0;

const url = (id = doctorId) => `/api/appointments/availability?date=${date}&doctorId=${id}&durationMinutes=30&appointmentType=consultation`;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number; date: string }>(
    `SELECT party_id, ((NOW() AT TIME ZONE 'Asia/Aden')::date + 45)::text AS date
       FROM users WHERE username = 'secdoctora'`);
  doctorId = doctor.party_id;
  date = doctor.date;
  const { rows: [otherDoctor] } = await db.query<{ party_id: number }>(
    `SELECT party_id FROM users WHERE username = 'secdoctorb'`);
  await db.query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_date, scheduled_time, duration_minutes, status)
     VALUES ($1, $2, $3::date, '09:00', 30, 'booked')`,
    [h.seeded.patientAId, doctorId, date],
  );
  await db.query(
    `INSERT INTO provider_blocks (provider_id, starts_at, ends_at, reason, created_by)
     VALUES ($1, ($2::date + time '10:00') AT TIME ZONE 'Asia/Aden',
             ($2::date + time '10:30') AT TIME ZONE 'Asia/Aden', 'غياب', 'admin')`,
    [doctorId, date],
  );
  await db.query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_date, scheduled_time, duration_minutes, status, chair_no)
     VALUES ($1, $2, $3::date, '11:00', 30, 'booked', 1)`,
    [h.seeded.patientBId, otherDoctor.party_id, date],
  );
}, 120_000);
afterAll(async () => { await db?.end(); });

describe("doctor appointment availability over HTTP", () => {
  it("shows free, booked, and blocked slots without disclosing patient details", async () => {
    const response = await authedGet(url(), h.sessions.reception);
    expect(response.status).toBe(200);
    const body = await response.json() as { slots: { time: string; status: string }[] };
    const at = (time: string) => body.slots.find((slot) => slot.time === time)?.status;
    expect(at("09:00")).toBe("booked");
    expect(at("09:15")).toBe("booked");
    expect(at("09:30")).toBe("available");
    expect(at("10:00")).toBe("blocked");
    expect(JSON.stringify(body)).not.toContain("مريض الأمن أ");
  });

  it("keeps booked and blocked doctor times protected on the booking API", async () => {
    for (const time of ["09:00", "10:00"]) {
      const response = await authedMutation("/api/appointments", h.sessions.reception, "POST", JSON.stringify({
        patientId: h.seeded.patientBId, doctorId, date, time,
        durationMinutes: 30, appointmentType: "consultation",
      }));
      expect(response.status).toBe(409);
    }
  });

  it("marks an occupied selected chair unavailable while another chair remains free", async () => {
    const allChairs = await (await authedGet(url(), h.sessions.reception)).json() as { slots: { time: string; status: string }[] };
    const selectedChair = await (await authedGet(`${url()}&chairNo=1`, h.sessions.reception)).json() as { slots: { time: string; status: string }[] };
    expect(allChairs.slots.find((slot) => slot.time === "11:00")?.status).toBe("available");
    expect(selectedChair.slots.find((slot) => slot.time === "11:00")?.status).toBe("unavailable");
  });

  it("allows the doctor to view their own availability and denies other roles or doctors", async () => {
    expect((await authedGet(url(), h.sessions.doctorA)).status).toBe(200);
    expect((await authedGet(url(), h.sessions.doctorB)).status).toBe(403);
    expect((await authedGet(url(), h.sessions.cashier)).status).toBe(403);
    expect((await authedGet(url(), h.sessions.accountant)).status).toBe(403);
    expect((await authedGet(url(), h.sessions.admin)).status).toBe(200);
  });
});
