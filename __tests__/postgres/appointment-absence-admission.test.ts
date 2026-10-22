import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.CLINIC_TIME_ZONE = "Asia/Aden";
const {
  arriveAppointment, closeBookedAppointment, createAppointment, createPatient,
  ensureSchema, getPool, listAppointmentStatusLog, resetPoolForTesting,
  resolvePastBooking, transitionAppointment,
} = await import("../../lib/db");

beforeAll(async () => {
  await dropPublicSchema(assertRealPostgresUrl());
  await ensureSchema();
}, 120_000);
const observer = rawPool(assertRealPostgresUrl(), 1);
afterAll(async () => {
  await observer.end();
  await resetPoolForTesting();
});

async function booked(dayOffset = -1, time = "10:00") {
  const patient = await createPatient({
    fullName: `غياب ${Date.now()}`, phone: null, altPhone: null,
    gender: "male", birthYear: 1990, address: null, medicalAlert: null, note: null,
  });
  const { rows: [day] } = await getPool().query<{ date: string }>(
    `SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Aden')::date + $1::int)::text AS date`, [dayOffset],
  );
  const appointment = await createAppointment({
    patientId: patient.id, date: day.date, time, durationMinutes: 30,
    appointmentType: null, note: null,
  });
  if (!appointment) throw new Error("Fixture appointment missing");
  return { id: appointment.id, patientId: patient.id };
}

async function unchanged(id: number, hasEnded = false) {
  const { rows: [row] } = await getPool().query(
    `SELECT status, ended_at FROM appointments WHERE id = $1`, [id],
  );
  expect(row.status).toBe("booked");
  if (hasEnded) expect(row.ended_at).toBeInstanceOf(Date);
  else expect(row.ended_at).toBeNull();
  expect(await listAppointmentStatusLog(id)).toEqual([]);
}

// Observe a real lock wait, rather than relying on a sleep to order transactions.
async function waitForBlocked(fragment: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query(
      `SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
        AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE $1`,
      [`%${fragment}%`],
    );
    if (rows.length) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`No observed lock wait for ${fragment}`);
}

describe("locked appointment absence admission", () => {
  it("refuses future absence through both entry points without writes, but allows cancellation", async () => {
    const { id } = await booked(1);
    expect(await closeBookedAppointment(id, "no_show")).toBe(false);
    expect((await transitionAppointment(id, "no_show", { actor: "direct" })).ok).toBe(false);
    await unchanged(id);
    expect(await closeBookedAppointment(id, "cancelled")).toBe(true);
    expect((await listAppointmentStatusLog(id)).map(row => row.to)).toEqual(["cancelled"]);
  });

  it("uses the scheduled start, not duration or the late-display setting", async () => {
    const { id } = await booked();
    await getPool().query(`UPDATE appointments SET
      scheduled_date = (clock_timestamp() AT TIME ZONE 'Asia/Aden' + interval '1 hour')::date,
      scheduled_time = (clock_timestamp() AT TIME ZONE 'Asia/Aden' + interval '1 hour')::time
      WHERE id = $1`, [id]);
    expect(await closeBookedAppointment(id, "no_show")).toBe(false);
    await unchanged(id);
    await getPool().query(`UPDATE appointments SET
      scheduled_date = (clock_timestamp() AT TIME ZONE 'Asia/Aden' - interval '1 minute')::date,
      scheduled_time = (clock_timestamp() AT TIME ZONE 'Asia/Aden' - interval '1 minute')::time,
      duration_minutes = 120 WHERE id = $1`, [id]);
    expect(await closeBookedAppointment(id, "no_show")).toBe(true);
  });

  it.each(["done", "no_show"] as const)("past resolution %s refuses today and succeeds yesterday", async outcome => {
    const today = await booked(0, "00:00");
    expect(await resolvePastBooking(today.id, outcome)).toBe(false);
    await unchanged(today.id);
    const past = await booked();
    expect(await resolvePastBooking(past.id, outcome, { actor: "past resolver", actorRole: "reception" })).toBe(true);
    expect(await listAppointmentStatusLog(past.id)).toMatchObject([{ from: "booked", to: outcome, actor: "past resolver", actorRole: "reception" }]);
  });

  it.each(["done", "no_show"] as const)("reschedule committed while %s waits is authoritative", async outcome => {
    const { id } = await booked();
    const mover = await getPool().connect();
    let closing: Promise<boolean> | undefined;
    try {
      await mover.query("BEGIN");
      await mover.query(`UPDATE appointments SET scheduled_date = scheduled_date + 3 WHERE id = $1`, [id]);
      closing = resolvePastBooking(id, outcome);
      await waitForBlocked("SELECT status FROM appointments");
      await mover.query("COMMIT");
      expect(await closing).toBe(false);
      await unchanged(id);
    } finally {
      await mover.query("ROLLBACK");
      mover.release();
      await closing;
    }
  });

  it("direct absence rechecks a schedule moved to the future while waiting", async () => {
    const { id } = await booked();
    const mover = await getPool().connect();
    let closing: Promise<boolean> | undefined;
    try {
      await mover.query("BEGIN");
      await mover.query(`UPDATE appointments SET scheduled_date = scheduled_date + 3 WHERE id = $1`, [id]);
      closing = closeBookedAppointment(id, "no_show");
      await waitForBlocked("SELECT status FROM appointments");
      await mover.query("COMMIT");
      expect(await closing).toBe(false);
      await unchanged(id);
    } finally {
      await mover.query("ROLLBACK");
      mover.release();
      await closing;
    }
  });

  it("sees a linked visit committed while the appointment lock was waiting", async () => {
    const { id, patientId } = await booked();
    const linker = await getPool().connect();
    let closing: Promise<boolean> | undefined;
    try {
      await linker.query("BEGIN");
      await linker.query("SELECT id FROM appointments WHERE id = $1 FOR UPDATE", [id]);
      closing = closeBookedAppointment(id, "no_show");
      await waitForBlocked("SELECT status FROM appointments");
      await linker.query(`INSERT INTO visits (patient_name, patient_id, appointment_id)
        VALUES ('historical link', $1, $2)`, [patientId, id]);
      await linker.query("COMMIT");
      expect(await closing).toBe(false);
      await unchanged(id);
    } finally {
      await linker.query("ROLLBACK");
      linker.release();
      await closing;
    }
  });

  it("arrival wins a controlled lock queue and absence cannot overwrite it", async () => {
    const { id } = await booked();
    const blocker = await getPool().connect();
    let arriving: Promise<boolean> | undefined;
    let closing: Promise<boolean> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM appointments WHERE id = $1 FOR UPDATE", [id]);
      arriving = arriveAppointment(id);
      await waitForBlocked("UPDATE appointments a SET status = 'arrived'");
      closing = closeBookedAppointment(id, "no_show");
      await waitForBlocked("SELECT status FROM appointments");
      await blocker.query("COMMIT");
      expect(await arriving).toBe(true);
      expect(await closing).toBe(false);
      const { rows: [row] } = await getPool().query("SELECT status FROM appointments WHERE id = $1", [id]);
      expect(row.status).toBe("arrived");
      expect((await listAppointmentStatusLog(id)).some(row => row.to === "no_show")).toBe(false);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      await Promise.all([arriving, closing]);
    }
  });

  it.each(["arrived_at", "started_at", "ended_at"])("refuses historical booked row with %s evidence", async column => {
    const { id } = await booked();
    await getPool().query(`UPDATE appointments SET ${column} = NOW() WHERE id = $1`, [id]);
    expect(await closeBookedAppointment(id, "no_show")).toBe(false);
    await unchanged(id, column === "ended_at");
  });

  it.each(["waiting", "called", "in_chair"])("refuses a linked active %s visit even with missing arrival timestamps", async status => {
    const { id, patientId } = await booked();
    await getPool().query(`INSERT INTO visits (patient_name, patient_id, appointment_id, status)
      VALUES ('linked', $1, $2, $3)`, [patientId, id, status]);
    expect(await closeBookedAppointment(id, "no_show")).toBe(false);
    await unchanged(id);
  });

  it.each(["visit_id", "planned_visit_id"])("refuses a visit linked via planned-visit %s only", async link => {
    const { id, patientId } = await booked();
    const { rows: [planned] } = await getPool().query<{ id: number }>(
      `INSERT INTO planned_visits (patient_id, sequence, title, appointment_id)
       VALUES ($1, 1, 'planned visit', $2) RETURNING id`, [patientId, id]);
    await getPool().query("UPDATE appointments SET planned_visit_id = $2 WHERE id = $1", [id, planned.id]);
    const { rows: [visit] } = await getPool().query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id) VALUES ('planned arrival', $1) RETURNING id`, [patientId]);
    if (link === "visit_id") {
      await getPool().query("UPDATE planned_visits SET visit_id = $2 WHERE id = $1", [planned.id, visit.id]);
    } else {
      await getPool().query("UPDATE visits SET planned_visit_id = $2 WHERE id = $1", [visit.id, planned.id]);
    }
    expect(await closeBookedAppointment(id, "no_show")).toBe(false);
    await unchanged(id);
  });

  it.each([
    ["direct", "done"], ["direct", "signed"], ["direct", "finished"],
    ["planned", "done"], ["planned", "signed"], ["planned", "finished"],
  ])("refuses %s linked completed treatment evidence: %s", async (link, evidence) => {
    const { id, patientId } = await booked();
    const { rows: [visit] } = await getPool().query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id, appointment_id, status, signed_at, finished_at)
       VALUES ('treated', $1, $2, $3, $4, $5) RETURNING id`,
      [patientId, link === "direct" ? id : null, evidence === "done" ? "done" : "legacy",
        evidence === "signed" ? new Date() : null, evidence === "finished" ? new Date() : null]);
    if (link === "planned") {
      await getPool().query(`INSERT INTO planned_visits (patient_id, sequence, title, appointment_id, visit_id)
        VALUES ($1, 1, 'completed treatment', $2, $3)`, [patientId, id, visit.id]);
    }
    expect(await closeBookedAppointment(id, "no_show")).toBe(false);
    expect(await resolvePastBooking(id, "no_show")).toBe(false);
    await unchanged(id);
  });

  it("does not treat an unrelated patient visit as arrival for this appointment", async () => {
    const { id, patientId } = await booked();
    await getPool().query(`INSERT INTO visits (patient_name, patient_id, status)
      VALUES ('walk-in', $1, 'waiting'), ('unrelated treatment', $1, 'done')`, [patientId]);
    expect(await closeBookedAppointment(id, "no_show")).toBe(true);
  });
});
