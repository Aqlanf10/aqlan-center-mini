import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.CLINIC_TIME_ZONE = "Asia/Aden";
const { createPatient, createParty, ensureSchema, getPool, resetPoolForTesting, saveSettings, seedAppointmentServices, listAppointmentServices, writeAppointmentInDay, prepareNextSessionPatient, createNextSession } = await import("../../lib/db");
const { bookAppointment, rescheduleAppointment, judgeBookingInDay } = await import("../../lib/book-appointment");
const { loadCapacityContext } = await import("../../lib/capacity-context");
const actor = { username: "synthetic-nearby-reception", role: "reception" as const, channel: "ui" as const };
const observer = rawPool(assertRealPostgresUrl(), 1);
let sequence = 0;
let doctorId: number;
let providerServiceId: number;

beforeAll(async () => {
  await dropPublicSchema(assertRealPostgresUrl());
  await ensureSchema();
  await saveSettings({ "clinic.chairs": "20", "clinic.day_start": "08:00", "clinic.day_end": "20:00", "clinic.shift2_start": "", "clinic.shift2_end": "" });
  await seedAppointmentServices();
  providerServiceId = (await listAppointmentServices()).find(service => service.isActive && service.requiresProvider)!.id;
  doctorId = (await createParty({ name: "Synthetic nearby doctor", kind: "doctor", phone: null, commissionPercent: 0, note: null })).id;
});
afterAll(async () => { await observer.end(); await resetPoolForTesting(); });

async function proposal() {
  const patient = await createPatient({ fullName: `Synthetic nearby patient ${++sequence}`, phone: null, altPhone: null, gender: "male", birthYear: 1990, address: null, medicalAlert: null, note: null });
  return { patientId: patient.id, date: new Date(Date.UTC(2034, 0, sequence * 5)).toISOString().slice(0, 10), time: "16:00", durationMinutes: 15, doctorId };
}
function day(date: string, offset: number) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() + offset); return value.toISOString().slice(0, 10); }
async function count(patientId: number) { const { rows: [row] } = await getPool().query<{ count: string }>("SELECT count(*) FROM appointments WHERE patient_id = $1", [patientId]); return Number(row.count); }
async function seed(input: Awaited<ReturnType<typeof proposal>>, offset = 0) {
  const result = await bookAppointment({ ...input, date: day(input.date, offset), time: "17:00" }, actor);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Synthetic fixture booking failed");
  return result.appointment;
}
function warning(result: Awaited<ReturnType<typeof bookAppointment>>) {
  expect(result).toMatchObject({ ok: false, status: 409, conflict: { kind: "nearby_patient_appointments", confirmationToken: expect.any(String) } });
  if (result.ok || result.status !== 409) throw new Error("Expected nearby warning");
  return result.conflict as typeof result.conflict & { kind: string; confirmationToken: string; nearbyAppointments: { id: number; scheduledDate: string; scheduledTime: string; doctorName: string | null }[] };
}
function confirmed(input: Awaited<ReturnType<typeof proposal>>, token: string) { return { ...input, nearbyAppointmentConfirmation: token }; }

async function waitForBlockedBy(blockerPid: number, fragment: string): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
       AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
       AND $1 = ANY(pg_blocking_pids(pid)) AND query LIKE $2`, [blockerPid, `%${fragment}%`]);
    if (rows.length) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`No observed lock wait for ${fragment}`);
}

describe("nearby appointment confirmation on real PostgreSQL", () => {
  it.each([0, 1, 2])("warns before creating when an active appointment is D+%i", async offset => {
    const input = await proposal();
    const existing = await seed(input, offset);
    const conflict = warning(await bookAppointment(input, actor));
    expect(conflict.nearbyAppointments).toEqual(expect.arrayContaining([expect.objectContaining({ id: existing.id, scheduledDate: day(input.date, offset), scheduledTime: "17:00", doctorName: "Synthetic nearby doctor" })]));
    expect(await count(input.patientId)).toBe(1);
    expect(await bookAppointment(confirmed(input, conflict.confirmationToken), actor)).toMatchObject({ ok: true });
    expect(await count(input.patientId)).toBe(2);
  });
  it.each(["2036-02-28", "2034-12-31"])("uses clinic calendar dates across the boundary at %s", async date => {
    const input = { ...await proposal(), date };
    const existing = await seed(input, 2);
    const conflict = warning(await bookAppointment(input, actor));
    expect(conflict.nearbyAppointments).toEqual([expect.objectContaining({ id: existing.id, scheduledDate: day(date, 2) })]);
  });
  it.each([-1, 3])("does not warn for an appointment at offset %i", async offset => {
    const input = await proposal(); await seed(input, offset);
    expect(await bookAppointment(input, actor)).toMatchObject({ ok: true });
  });
  it.each(["cancelled", "no_show", "done"])("does not warn for %s appointments", async status => {
    const input = await proposal(); const existing = await seed(input, 1);
    await getPool().query("UPDATE appointments SET status = $2 WHERE id = $1", [existing.id, status]);
    expect(await bookAppointment(input, actor)).toMatchObject({ ok: true });
  });
  it("warns for an arrived appointment", async () => {
    const input = await proposal(); const existing = await seed(input);
    await getPool().query("UPDATE appointments SET status = 'arrived' WHERE id = $1", [existing.id]);
    warning(await bookAppointment(input, actor));
  });
  it("binds confirmation to actor, patient and proposal and rechecks the live snapshot", async () => {
    const input = await proposal(); const existing = await seed(input, 1);
    const { confirmationToken } = warning(await bookAppointment(input, actor));
    warning(await bookAppointment(confirmed(input, confirmationToken), { ...actor, username: "another-user" }));
    warning(await bookAppointment({ ...confirmed(input, confirmationToken), time: "15:00" }, actor));
    const other = await proposal(); await seed(other, 1);
    warning(await bookAppointment(confirmed(other, confirmationToken), actor));
    await getPool().query("UPDATE appointments SET scheduled_time = '18:00' WHERE id = $1", [existing.id]);
    warning(await bookAppointment(confirmed(input, confirmationToken), actor));
    expect(await count(input.patientId)).toBe(1);
  });
  it("preserves hard overlap refusal even with an explicit additional-appointment confirmation", async () => {
    const input = await proposal(); await seed(input);
    const { confirmationToken } = warning(await bookAppointment(input, actor));
    const result = await bookAppointment({ ...confirmed(input, confirmationToken), time: "17:00", overrideReason: "Intentional additional appointment" }, { ...actor, role: "admin" });
    expect(result).toMatchObject({ ok: false, status: 409, conflict: { canOverride: false } });
    if (!result.ok && result.status === 409) expect((result.conflict as { kind?: string }).kind).not.toBe("nearby_patient_appointments");
    expect(await count(input.patientId)).toBe(1);
  });
  it("does not let a valid confirmation bypass a newly occupied doctor slot", async () => {
    const input = { ...await proposal(), serviceId: providerServiceId }; await seed(input, 1);
    const { confirmationToken } = warning(await bookAppointment(input, actor));
    const other = { ...await proposal(), date: input.date, serviceId: providerServiceId };
    expect(await bookAppointment(other, actor)).toMatchObject({ ok: true });
    const result = await bookAppointment(confirmed(input, confirmationToken), actor);
    expect(result).toMatchObject({ ok: false, status: 409 });
    if (!result.ok && result.status === 409) expect((result.conflict as { kind?: string }).kind).not.toBe("nearby_patient_appointments");
    expect(await count(input.patientId)).toBe(1);
  });
  it("excludes itself when rescheduling and retains the original on nearby warning", async () => {
    const input = await proposal(); const existing = await seed(input);
    expect(await rescheduleAppointment({ appointmentId: existing.id, date: input.date, time: "16:00", reason: "Synthetic move" }, actor)).toMatchObject({ ok: true });
    // An appointment outside the old window can be seeded without confirming.
    const future = await seed(input, 3);
    const moved = await rescheduleAppointment({ appointmentId: existing.id, date: day(input.date, 2), time: "16:00", reason: "Synthetic move" }, actor);
    expect(moved).toMatchObject({ ok: false, status: 409, conflict: { kind: "nearby_patient_appointments", nearbyAppointments: [expect.objectContaining({ id: future.id })] } });
    const { rows: [unchanged] } = await getPool().query("SELECT scheduled_date::text AS date, scheduled_time::text AS time FROM appointments WHERE id = $1", [existing.id]);
    expect(unchanged).toMatchObject({ date: input.date, time: "16:00:00" });
    if (moved.ok || !moved.conflict) throw new Error("Expected reschedule warning");
    const token = (moved.conflict as { confirmationToken?: string }).confirmationToken;
    expect(await rescheduleAppointment({ appointmentId: existing.id, date: day(input.date, 2), time: "16:00", reason: "Synthetic move", nearbyAppointmentConfirmation: token }, actor)).toMatchObject({ ok: true });
  });
  it("allows at most one write when two tabs submit the same confirmation concurrently", async () => {
    const input = await proposal(); await seed(input, 1);
    const { confirmationToken } = warning(await bookAppointment(input, actor));
    const results = await Promise.all([bookAppointment(confirmed(input, confirmationToken), actor), bookAppointment(confirmed(input, confirmationToken), actor)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toHaveLength(1);
    expect(await count(input.patientId)).toBe(2);
  });
  it("serializes overlapping day windows and rechecks a future appointment committed during the wait", async () => {
    const input = await proposal();
    await getPool().query(`CREATE FUNCTION test_nearby_booking_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(8970626); RETURN NEW; END $$;
      CREATE TRIGGER test_nearby_booking_gate BEFORE INSERT ON appointments
      FOR EACH ROW EXECUTE FUNCTION test_nearby_booking_gate()`);
    const gate = await getPool().connect();
    let future: ReturnType<typeof bookAppointment> | undefined;
    let earlier: ReturnType<typeof bookAppointment> | undefined;
    try {
      await gate.query("BEGIN");
      const { rows: [info] } = await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await gate.query("SELECT pg_advisory_xact_lock(8970626)");
      future = bookAppointment({ ...input, date: day(input.date, 2), time: "17:00" }, actor);
      const writerPid = await waitForBlockedBy(info.pid, "INSERT INTO appointments");
      earlier = bookAppointment(input, actor);
      await waitForBlockedBy(writerPid, "pg_advisory_xact_lock");
      await gate.query("COMMIT");
      expect(await future).toMatchObject({ ok: true });
      warning(await earlier);
      expect(await count(input.patientId)).toBe(1);
    } finally {
      await gate.query("ROLLBACK").catch(() => {});
      await future?.catch(() => {});
      await earlier?.catch(() => {});
      gate.release();
      await getPool().query("DROP TRIGGER test_nearby_booking_gate ON appointments; DROP FUNCTION test_nearby_booking_gate()");
    }
  });

  it("resolves a phone-only walk-in before warning and rolls its patient link back on refusal", async () => {
    const input = await proposal();
    const phone = `96777${String(1000000 + sequence)}`;
    await getPool().query("UPDATE patients SET phone = $2 WHERE id = $1", [input.patientId, phone]);
    await seed(input);
    const { rows: [visit] } = await getPool().query<{ id: number }>(
      "INSERT INTO visits(patient_name, patient_phone, patient_id) VALUES ('Synthetic walk-in', $1, NULL) RETURNING id", [phone]);
    const context = await loadCapacityContext();
    const attempt = (time: string, nearbyAppointmentConfirmation?: string) => writeAppointmentInDay({
      date: input.date,
      judge: async (sameDay, client) => {
        const patientId = await prepareNextSessionPatient(client, { visitId: visit.id, phone: null });
        expect(patientId).toBe(input.patientId);
        const judged = await judgeBookingInDay({ sameDay, client, date: input.date, time,
          durationMinutes: input.durationMinutes, patientId, service: null, context,
          canOverride: false, overrideReason: "", bookingActor: actor.username,
          bookingScope: `synthetic-next-visit:${visit.id}`, nearbyAppointmentConfirmation });
        return judged.ok ? { ok: true as const } : { ok: false as const, conflict: judged.conflict };
      },
      commit: client => createNextSession({ visitId: visit.id, date: input.date, time,
        durationMinutes: input.durationMinutes, phone: null, note: null }, client),
    });
    const rejected = await attempt("16:00");
    expect(rejected).toMatchObject({ ok: false, conflict: { kind: "nearby_patient_appointments" } });
    const linkedPatient = async () => (await getPool().query<{ patient_id: number | null }>(
      "SELECT patient_id FROM visits WHERE id = $1", [visit.id])).rows[0].patient_id;
    expect(await linkedPatient()).toBeNull();
    expect(await count(input.patientId)).toBe(1);
    if (rejected.ok) throw new Error("Expected nearby warning for resolved patient");
    const confirmationToken = (rejected.conflict as { confirmationToken: string }).confirmationToken;
    const overlap = await attempt("17:00", confirmationToken);
    expect(overlap).toMatchObject({ ok: false, conflict: { canOverride: false } });
    if (!overlap.ok) expect((overlap.conflict as { kind?: string }).kind).not.toBe("nearby_patient_appointments");
    expect(await linkedPatient()).toBeNull();
    expect(await count(input.patientId)).toBe(1);
    expect(await attempt("16:00", confirmationToken)).toMatchObject({ ok: true, value: { patientId: input.patientId } });
    expect(await linkedPatient()).toBe(input.patientId);
    expect(await count(input.patientId)).toBe(2);
    expect((await getPool().query("SELECT id FROM patients WHERE phone = $1", [phone])).rows).toEqual([{ id: input.patientId }]);
  });

});
