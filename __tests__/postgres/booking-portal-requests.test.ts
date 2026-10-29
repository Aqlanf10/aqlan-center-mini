import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DB_POOL_MAX = "12";
const db = await import("../../lib/db");
beforeAll(async () => { await dropPublicSchema(assertRealPostgresUrl()); await db.ensureSchema(); }, 120_000);
afterAll(async () => { await db.resetPoolForTesting(); });
const request = (phone: string) => ({ fullName: "مريض اصطناعي", phone, reason: null,
  preferredDate: "2027-03-01", preferredPeriod: "any" as const });

it("persists a single request under concurrent retry and replays after response loss", async () => {
  const input = request("967777840001");
  const saved = await Promise.all(Array.from({ length: 10 }, () => db.createBookingRequest(input, null, "synthetic-book-request-1")));
  expect(new Set(saved.map(row => row.id)).size).toBe(1);
  expect((await db.getPool().query("SELECT count(*)::int n FROM booking_requests WHERE phone=$1", [input.phone])).rows[0].n).toBe(1);
  expect((await db.createBookingRequest(input, null, "synthetic-book-request-1")).id).toBe(saved[0].id);
  await expect(db.createBookingRequest({ ...input, preferredDate: "2027-03-02" }, null, "synthetic-book-request-1")).rejects.toThrow("BOOKING_KEY_CONFLICT");
});

it("never silently chooses a patient when a family shares a phone", async () => {
  for (const name of ["ألف", "باء"]) await db.createPatient({ fullName: `اصطناعي ${name}`, phone: "777840002", altPhone: null,
    gender: "male", birthYear: null, address: null, medicalAlert: null, note: null });
  const saved = await db.createBookingRequest(request("967777840002"), null);
  await expect(db.existingPatientForBookingRequest(saved.id)).rejects.toThrow("BOOKING_PATIENT_AMBIGUOUS");
  await expect(db.confirmBookingRequest({ id: saved.id, date: "2027-03-01", time: "10:00", durationMinutes: 30 })).rejects.toThrow("BOOKING_PATIENT_AMBIGUOUS");
  expect((await db.getPool().query("SELECT count(*)::int n FROM appointments")).rows[0].n).toBe(0);
});

it("saves service and chair snapshots on conversion", async () => {
  const saved = await db.createBookingRequest(request("967777840003"), null);
  const service = (await db.listAppointmentServices())[0];
  const result = await db.confirmBookingRequest({ id: saved.id, date: "2027-03-03", time: "11:00", durationMinutes: 40,
    serviceId: service.id, bufferBeforeMinutes: 5, bufferAfterMinutes: 10, chairNo: 2, occupiesChair: true });
  const appointment = await db.getAppointment(result!.appointmentId);
  expect(appointment).toMatchObject({ serviceId: service.id, bufferBeforeMinutes: 5, bufferAfterMinutes: 10, chairNo: 2, durationMinutes: 40 });
});

it("inherits the approved responsible doctor for every specialty and rejects ambiguous/stale choices", async () => {
  const { bookingRequestDoctor } = await import("../../lib/booking-request-review");
  const patient = await db.createPatient({ fullName: "حالات اصطناعية", phone: null, altPhone: null,
    gender: "male", birthYear: null, address: null, medicalAlert: null, note: null });
  const doctors = (await db.getPool().query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic responsible A'),('doctor','Synthetic responsible B') RETURNING id")).rows;
  const client = await db.getPool().connect();
  try {
    await client.query("BEGIN");
    for (const specialty of ["orthodontics", "endodontics", "surgery", "implantology", "prosthodontics", "periodontics", "pediatric", "general"]) {
      const caseId = (await client.query(`INSERT INTO clinical_cases(patient_id,specialty,title,responsible_party_id,created_by)
        VALUES($1,$2,'Synthetic responsibility',$3,'test') RETURNING id`, [patient.id, specialty, doctors[0].id])).rows[0].id;
      expect(await bookingRequestDoctor(client, { patientId: patient.id, caseId, doctorId: null, followUp: true })).toBe(doctors[0].id);
      await client.query("UPDATE clinical_cases SET responsible_party_id=$2 WHERE id=$1", [caseId, doctors[1].id]);
      await expect(bookingRequestDoctor(client, { patientId: patient.id, caseId, doctorId: doctors[0].id, followUp: true })).rejects.toThrow("BOOKING_RESPONSIBLE_CHANGED");
      expect(await bookingRequestDoctor(client, { patientId: patient.id, caseId, doctorId: null, followUp: true })).toBe(doctors[1].id);
      if (specialty === "orthodontics") expect(await bookingRequestDoctor(client, { patientId: patient.id, caseId: null, doctorId: null, followUp: true })).toBe(doctors[1].id);
    }
    await expect(bookingRequestDoctor(client, { patientId: patient.id, caseId: null, doctorId: null, followUp: true })).rejects.toThrow("BOOKING_CASE_REQUIRED");
    await client.query("ROLLBACK");
  } finally { client.release(); }
});

it("locks schedule and leave sources through commit and applies edited duty on the next booking", async () => {
  const { assertBookingRequestDuty } = await import("../../lib/booking-request-review");
  const doctorId = (await db.getPool().query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic duty lock') RETURNING id")).rows[0].id;
  const userId = (await db.getPool().query("INSERT INTO users(username,display_name,password_hash,role,party_id) VALUES('synthetic_booking_duty','Synthetic','not-a-login-hash','doctor',$1) RETURNING id", [doctorId])).rows[0].id;
  const staffId = (await db.getPool().query("INSERT INTO hr_staff(full_name,user_id,department,created_by) VALUES('Synthetic booking duty',$1,'doctors','test') RETURNING id", [userId])).rows[0].id;
  const scheduleId = (await db.getPool().query(`INSERT INTO hr_work_schedules(staff_id,name,effective_from,working_days,shift_start_time,shift_end_time,schedule_type,created_by)
    VALUES($1,'Synthetic duty','2026-01-01','[0,1,2,3,4,5,6]','09:00','13:00','morning','test') RETURNING id`, [staffId])).rows[0].id;
  const booking = await db.getPool().connect(), editor = await db.getPool().connect();
  const input = { doctorId, date: "2027-03-01", time: "12:00", durationMinutes: 30, before: 0, after: 0 };
  try {
    await booking.query("BEGIN");
    await assertBookingRequestDuty(booking, input);
    const pid = (await editor.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const editing = editor.query("UPDATE hr_work_schedules SET shift_end_time='12:00' WHERE id=$1", [scheduleId]);
    await expect.poll(async () => (await db.getPool().query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]?.wait_event_type).toBe("Lock");
    await booking.query("COMMIT");
    await editing;
    await booking.query("BEGIN");
    await expect(assertBookingRequestDuty(booking, input)).rejects.toThrow("BOOKING_DOCTOR_DUTY");
    await booking.query("ROLLBACK");
    await db.getPool().query(`INSERT INTO hr_leave_requests(staff_id,leave_type_code,start_date,end_date,days_count,reason,status,created_by)
      VALUES($1,'annual','2027-03-01','2027-03-01',1,'Synthetic approved leave','approved','test')`, [staffId]);
    await booking.query("BEGIN");
    await expect(assertBookingRequestDuty(booking, { ...input, time: "10:00" })).rejects.toThrow("BOOKING_DOCTOR_DUTY");
    await booking.query("ROLLBACK");
  } finally { await booking.query("ROLLBACK"); booking.release(); editor.release(); }
});
