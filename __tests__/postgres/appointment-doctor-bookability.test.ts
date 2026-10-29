import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.CLINIC_TIME_ZONE = "Asia/Aden";

const {
  createParty, createPatient, ensureSchema, getPool, listAppointmentServices,
  resetPoolForTesting, saveSettings, seedAppointmentServices,
} = await import("../../lib/db");
const { bookAppointment, rescheduleAppointment } = await import("../../lib/book-appointment");

const actor = { username: "bookability-test", role: "reception" as const, channel: "ui" as const };
const observer = rawPool(assertRealPostgresUrl(), 1);
let activeDoctor = 0;
let inactiveDoctor = 0;
let supplier = 0;
let providerService = 0;
let nonProviderService = 0;
let sequence = 0;

beforeAll(async () => {
  await dropPublicSchema(assertRealPostgresUrl());
  await ensureSchema();
  await saveSettings({
    "clinic.chairs": "3", "clinic.day_start": "08:00", "clinic.day_end": "20:00",
    "clinic.shift2_start": "", "clinic.shift2_end": "",
  });
  await seedAppointmentServices();
  const services = await listAppointmentServices();
  providerService = services.find(service => service.requiresProvider && service.isActive)!.id;
  nonProviderService = services.find(service => !service.requiresProvider && service.isActive)!.id;
  activeDoctor = (await party("doctor")).id;
  inactiveDoctor = (await party("doctor")).id;
  supplier = (await party("supplier")).id;
  await getPool().query("UPDATE parties SET is_active = false WHERE id = $1", [inactiveDoctor]);
});

afterAll(async () => {
  await observer.end();
  await resetPoolForTesting();
});

async function party(kind: "doctor" | "supplier") {
  return createParty({
    name: `Synthetic ${kind} ${++sequence}`, kind, phone: null,
    commissionPercent: 0, note: null,
  });
}

async function input() {
  const patient = await createPatient({
    fullName: `Synthetic booking patient ${++sequence}`, phone: null, altPhone: null,
    gender: "male", birthYear: 1990, address: null, medicalAlert: null, note: null,
  });
  return {
    patientId: patient.id, date: new Date(Date.UTC(2031, 0, sequence)).toISOString().slice(0, 10),
    time: "10:00", durationMinutes: 30,
  };
}

function invalidDoctor(kind: string) {
  return kind === "inactive" ? inactiveDoctor : kind === "non-doctor" ? supplier : 2147483647;
}

async function snapshot(id: number) {
  const { rows } = await getPool().query(
    `SELECT scheduled_date::text, scheduled_time::text, doctor_id, service_id,
       duration_minutes, reminder_sent_at, patient_confirmed_at FROM appointments WHERE id = $1`, [id],
  );
  return rows[0];
}

// Observe real PostgreSQL lock waits, not an assumed ordering based on sleeps.
async function waitForBlockedBy(blockerPid: number, fragment: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
         AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
         AND $1 = ANY(pg_blocking_pids(pid)) AND query LIKE $2`,
      [blockerPid, `%${fragment}%`],
    );
    if (rows.length) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`No observed lock wait for ${fragment}`);
}

describe("selected appointment doctor must match the active-doctor picker", () => {
  for (const service of ["provider", "non-provider", "fallback"] as const) {
    it.each(["inactive", "non-doctor", "missing"])(`rejects a %s selection for a ${service} create`, async kind => {
      const request = await input();
      const result = await bookAppointment({
        ...request, doctorId: invalidDoctor(kind),
        serviceId: service === "provider" ? providerService : service === "non-provider" ? nonProviderService : null,
      }, actor);
      expect(result).toMatchObject({ ok: false, status: 400, message: "الطبيب غير متاح للحجز." });
      const { rows } = await getPool().query("SELECT id FROM appointments WHERE patient_id = $1", [request.patientId]);
      expect(rows).toEqual([]);
    });
  }

  it.each(["inactive", "non-doctor", "missing"])("rejects a %s reschedule target without changing the original", async kind => {
    const request = await input();
    const booked = await bookAppointment({ ...request, doctorId: activeDoctor, serviceId: providerService }, actor);
    if (!booked.ok) throw new Error("Fixture booking failed");
    const before = await snapshot(booked.appointment.id);
    const result = await rescheduleAppointment({
      appointmentId: booked.appointment.id, date: request.date, time: "11:00",
      doctorId: invalidDoctor(kind), reason: "Synthetic reschedule",
    }, actor);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await snapshot(booked.appointment.id)).toEqual(before);
  });

  it("revalidates a retained doctor who became inactive after the original booking", async () => {
    const doctor = await party("doctor");
    const request = await input();
    const booked = await bookAppointment({ ...request, doctorId: doctor.id }, actor);
    if (!booked.ok) throw new Error("Fixture booking failed");
    const before = await snapshot(booked.appointment.id);
    await getPool().query("UPDATE parties SET is_active = false WHERE id = $1", [doctor.id]);
    expect(await rescheduleAppointment({
      appointmentId: booked.appointment.id, date: request.date, time: "11:00", reason: "Synthetic reschedule",
    }, actor)).toMatchObject({ ok: false, status: 400 });
    expect(await snapshot(booked.appointment.id)).toEqual(before);
  });

  it("does not permit capacity override to turn a supplier into a doctor", async () => {
    expect(await bookAppointment({
      ...await input(), doctorId: supplier, overrideReason: "Synthetic override",
    }, { ...actor, role: "admin" })).toMatchObject({ ok: false, status: 400 });
  });

  it("validates the effective self-booking doctor rather than the ignored request doctor", async () => {
    expect(await bookAppointment({ ...await input(), doctorId: activeDoctor }, {
      ...actor, role: "doctor", doctorPartyId: inactiveDoctor,
    })).toMatchObject({ ok: false, status: 400 });
  });
});

describe("existing appointment scheduling policy remains unchanged", () => {
  it("allows an unspecified doctor for provider-consuming services on create and reschedule", async () => {
    const request = await input();
    const booked = await bookAppointment({ ...request, serviceId: providerService }, actor);
    expect(booked.ok).toBe(true);
    if (!booked.ok) throw new Error("Fixture booking failed");
    expect(booked.appointment.doctorId).toBeNull();
    expect(await rescheduleAppointment({
      appointmentId: booked.appointment.id, date: request.date, time: "11:00", reason: "Synthetic reschedule",
    }, actor)).toMatchObject({ ok: true });
  });

  it("allows explicitly clearing an inactive former doctor on reschedule", async () => {
    const doctor = await party("doctor");
    const request = await input();
    const booked = await bookAppointment({ ...request, doctorId: doctor.id, serviceId: providerService }, actor);
    if (!booked.ok) throw new Error("Fixture booking failed");
    await getPool().query("UPDATE parties SET is_active = false WHERE id = $1", [doctor.id]);
    expect(await rescheduleAppointment({
      appointmentId: booked.appointment.id, date: request.date, time: "11:00",
      doctorId: null, reason: "Synthetic reschedule",
    }, actor)).toMatchObject({ ok: true, appointment: { doctorId: null } });
  });

  it("rejects booking and rescheduling outside configured clinic hours", async () => {
    const request = await input();
    const refused = await bookAppointment({
      ...request, time: "23:00", doctorId: activeDoctor, serviceId: providerService,
    }, actor);
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect((await getPool().query("SELECT id FROM appointments WHERE patient_id=$1", [request.patientId])).rows).toEqual([]);
    const booked = await bookAppointment({ ...request, time: "10:00", doctorId: activeDoctor, serviceId: providerService }, actor);
    if (!booked.ok) throw new Error("Fixture booking failed");
    const before = await snapshot(booked.appointment.id);
    expect(await rescheduleAppointment({
      appointmentId: booked.appointment.id, date: request.date, time: "23:30", reason: "Synthetic move",
    }, actor)).toMatchObject({ ok: false, status: 409 });
    expect(await snapshot(booked.appointment.id)).toEqual(before);
  });

  it("keeps an attributed non-provider-consuming service bookable during doctor blocks", async () => {
    const request = await input();
    await getPool().query(
      `INSERT INTO provider_blocks (provider_id, starts_at, ends_at, reason, created_by)
       VALUES ($1, $2::timestamp AT TIME ZONE 'Asia/Aden', $3::timestamp AT TIME ZONE 'Asia/Aden', 'Synthetic block', 'test')`,
      [activeDoctor, `${request.date} 09:00:00`, `${request.date} 12:00:00`],
    );
    expect(await bookAppointment({ ...request, doctorId: activeDoctor, serviceId: providerService }, actor))
      .toMatchObject({ ok: false, status: 409 });
    expect(await bookAppointment({ ...request, doctorId: activeDoctor, serviceId: nonProviderService }, actor))
      .toMatchObject({ ok: true });
  });

  it("preserves provider conflicts but allows non-consuming attribution during an existing doctor booking", async () => {
    const first = await input();
    const second = { ...await input(), date: first.date };
    expect(await bookAppointment({ ...first, doctorId: activeDoctor, serviceId: providerService }, actor))
      .toMatchObject({ ok: true });
    expect(await bookAppointment({ ...second, doctorId: activeDoctor, serviceId: providerService }, actor))
      .toMatchObject({ ok: false, status: 409 });
    expect(await bookAppointment({ ...second, doctorId: activeDoctor, serviceId: nonProviderService }, actor))
      .toMatchObject({ ok: true });
  });
});

describe("selected doctor validation is atomic with create and reschedule", () => {
  it.each(["create", "reschedule"] as const)("%s rechecks a deactivation committed while its doctor read waits", async operation => {
    const doctor = await party("doctor");
    const request = await input();
    let appointmentId = 0;
    if (operation === "reschedule") {
      const booked = await bookAppointment({ ...request, doctorId: doctor.id }, actor);
      if (!booked.ok) throw new Error("Fixture booking failed");
      appointmentId = booked.appointment.id;
    }
    const before = appointmentId ? await snapshot(appointmentId) : null;
    const editor = await getPool().connect();
    let pending: ReturnType<typeof bookAppointment> | ReturnType<typeof rescheduleAppointment> | undefined;
    try {
      await editor.query("BEGIN");
      const { rows: [editorInfo] } = await editor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await editor.query("UPDATE parties SET is_active = false WHERE id = $1", [doctor.id]);
      pending = operation === "create"
        ? bookAppointment({ ...request, doctorId: doctor.id }, actor)
        : rescheduleAppointment({ appointmentId, date: request.date, time: "11:00", reason: "Synthetic move" }, actor);
      await waitForBlockedBy(editorInfo.pid, "SELECT id FROM parties");
      await editor.query("COMMIT");
      expect(await pending).toMatchObject({ ok: false, status: 400 });
      if (appointmentId) expect(await snapshot(appointmentId)).toEqual(before);
      else {
        const { rows } = await getPool().query("SELECT id FROM appointments WHERE patient_id = $1", [request.patientId]);
        expect(rows).toEqual([]);
      }
    } finally {
      await editor.query("ROLLBACK");
      editor.release();
      await pending?.catch(() => {});
    }
  });

  it.each(["create", "reschedule"] as const)("%s holds the active-doctor row lock until the appointment commits", async operation => {
    const doctor = await party("doctor");
    const request = await input();
    let appointmentId = 0;
    if (operation === "reschedule") {
      const booked = await bookAppointment({ ...request, doctorId: doctor.id }, actor);
      if (!booked.ok) throw new Error("Fixture booking failed");
      appointmentId = booked.appointment.id;
    }
    await getPool().query(`
      CREATE FUNCTION test_appointment_doctor_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(8970625); RETURN NEW; END $$;
      CREATE TRIGGER test_appointment_doctor_gate BEFORE INSERT OR UPDATE OF scheduled_time
        ON appointments FOR EACH ROW EXECUTE FUNCTION test_appointment_doctor_gate();
    `);
    const gate = await getPool().connect();
    const editor = await getPool().connect();
    let pending: ReturnType<typeof bookAppointment> | ReturnType<typeof rescheduleAppointment> | undefined;
    let deactivation: Promise<unknown> | undefined;
    try {
      await gate.query("BEGIN");
      const { rows: [gateInfo] } = await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await gate.query("SELECT pg_advisory_xact_lock(8970625)");
      pending = operation === "create"
        ? bookAppointment({ ...request, doctorId: doctor.id }, actor)
        : rescheduleAppointment({ appointmentId, date: request.date, time: "11:00", reason: "Synthetic move" }, actor);
      const writerPid = await waitForBlockedBy(gateInfo.pid, operation === "create" ? "INSERT INTO appointments" : "UPDATE appointments");
      deactivation = editor.query("UPDATE parties SET is_active = false WHERE id = $1", [doctor.id]);
      await waitForBlockedBy(writerPid, "UPDATE parties SET is_active");
      await gate.query("COMMIT");
      expect(await pending).toMatchObject({ ok: true });
      await deactivation;
      const { rows: [updated] } = await editor.query<{ is_active: boolean }>("SELECT is_active FROM parties WHERE id = $1", [doctor.id]);
      expect(updated.is_active).toBe(false);
    } finally {
      await gate.query("ROLLBACK");
      await pending?.catch(() => {});
      await deactivation?.catch(() => {});
      gate.release();
      editor.release();
      await getPool().query("DROP TRIGGER test_appointment_doctor_gate ON appointments; DROP FUNCTION test_appointment_doctor_gate()");
    }
  });
});
