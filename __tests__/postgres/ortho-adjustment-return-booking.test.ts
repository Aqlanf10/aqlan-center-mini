import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
process.env.CLINIC_TIME_ZONE = "Asia/Aden";

const { createParty, createPatient, ensureSchema, getPool, resetPoolForTesting, saveSettings, seedAppointmentServices } = await import("../../lib/db");
const { bookAppointment } = await import("../../lib/book-appointment");
const { readOrthoAdjustmentBookingContext } = await import("../../lib/ortho-adjustment-booking-context");
const { readDoctorDailySchedule } = await import("../../lib/doctor-daily-schedule");
const actor = { username: "synthetic-reception", role: "reception" as const, channel: "ui" as const };
const date = "2031-01-06";

beforeAll(async () => {
  await dropPublicSchema(assertRealPostgresUrl());
  await ensureSchema();
  await saveSettings({ "clinic.chairs": "3", "clinic.day_start": "08:00", "clinic.day_end": "20:00" });
  await seedAppointmentServices();
});
afterAll(async () => { await resetPoolForTesting(); });

describe("saved tightening follows current clinical responsibility through canonical booking", () => {
  it("persistently attributes the appointment, then rejects a stale preview on reassignment", async () => {
    const [invoiceDoctor, pastDoctor, responsible, replacement] = await Promise.all(
      ["Invoice", "Previous", "Responsible", "Replacement"].map(name => createParty({
        name: `Synthetic ${name}`, kind: "doctor", phone: null, note: null, commissionPercent: 0,
      })));
    const patient = await createPatient({ fullName: "Synthetic tightening return", phone: null, altPhone: null,
      gender: "unknown", birthYear: null, address: null, medicalAlert: null, note: null });
    const pool = getPool();
    const { rows: [{ id: caseId }] } = await pool.query<{ id: number }>("INSERT INTO ortho_cases (patient_id, responsible_doctor_id, created_by) VALUES ($1,$2,$3) RETURNING id", [patient.id, responsible.id, actor.username]);
    const { rows: [{ id: adjustmentId }] } = await pool.query<{ id: number }>("INSERT INTO ortho_adjustments (case_id, recorded_by) VALUES ($1,$2) RETURNING id", [caseId, "synthetic-previous-performer"]);
    const target = { patientId: patient.id, caseId, adjustmentId };
    const preview = await readOrthoAdjustmentBookingContext(pool, target);
    expect(preview).toMatchObject({ ok: true, doctorId: responsible.id });
    if (!preview.ok) throw new Error("Missing synthetic preview");
    const input = { patientId: patient.id, appointmentType: "follow_up", date, time: "10:00", durationMinutes: 15,
      doctorId: invoiceDoctor.id, orthoReturn: { caseId, adjustmentId, fingerprint: preview.fingerprint } };
    const authorize = async (_client: unknown, id: number) => id === patient.id;
    expect(await bookAppointment(input, actor, async () => false)).toMatchObject({ ok: false, code: "ortho_return_review_required" });
    const first = await bookAppointment(input, { ...actor, role: "doctor", doctorPartyId: pastDoctor.id }, authorize);
    expect(first).toMatchObject({ ok: true, appointment: { doctorId: responsible.id, doctorName: responsible.name } });
    if (!first.ok) throw new Error("Expected first booking to be persisted");
    expect(await readDoctorDailySchedule(responsible.id, date)).toEqual([expect.objectContaining({ appointmentId: first.appointment.id })]);
    expect(await readDoctorDailySchedule(pastDoctor.id, date)).toEqual([]);
    expect(await readDoctorDailySchedule(invoiceDoctor.id, date)).toEqual([]);

    await pool.query("UPDATE ortho_cases SET responsible_doctor_id = $2 WHERE id = $1", [caseId, replacement.id]);
    const later = { ...input, time: "11:30" };
    expect(await bookAppointment(later, actor, authorize)).toMatchObject({ ok: false, code: "ortho_return_review_required" });
    expect(await readDoctorDailySchedule(replacement.id, date)).toEqual([]);
    const newPreview = await readOrthoAdjustmentBookingContext(pool, target);
    expect(newPreview).toMatchObject({ ok: true, doctorId: replacement.id });
    if (!newPreview.ok) throw new Error("Expected revised synthetic responsibility");
    const booked = await bookAppointment({
      ...later, orthoReturn: { caseId, adjustmentId, fingerprint: newPreview.fingerprint },
    }, actor, authorize);
    expect(booked).toMatchObject({ ok: true, appointment: { doctorId: replacement.id, doctorName: replacement.name } });
    if (!booked.ok) throw new Error("Expected second booking to be persisted");
    expect(await readDoctorDailySchedule(replacement.id, date)).toEqual([expect.objectContaining({ appointmentId: booked.appointment.id })]);

    const ordinary = await bookAppointment({ patientId: patient.id, date, time: "13:00", appointmentType: "follow_up", doctorId: invoiceDoctor.id }, actor);
    expect(ordinary).toMatchObject({ ok: true, appointment: { doctorId: invoiceDoctor.id } });
  });
});
