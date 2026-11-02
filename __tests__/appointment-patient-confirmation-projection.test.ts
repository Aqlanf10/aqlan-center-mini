import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { APPOINTMENT_SELECT, toAppointment } from "../lib/db";

type AppointmentDbRow = Parameters<typeof toAppointment>[0];
const row = (confirmed: Date | null, status = "booked"): AppointmentDbRow => ({
  id: 8, patient_id: 17, full_name: "Synthetic patient", phone: null,
  scheduled_date: new Date(2026, 9, 22), scheduled_time: "10:00:00", duration_minutes: 20,
  appointment_type: "consultation", note: null, status, reminder_sent_at: null,
  patient_confirmed_at: confirmed, doctor_id: null, doctor_name: null,
});

describe("existing portal confirmation read projection", () => {
  it("selects the existing stamp in the shared appointment query without deriving it from status", () => {
    expect(APPOINTMENT_SELECT).toContain("a.patient_confirmed_at");
    expect(APPOINTMENT_SELECT).toContain("a.appointment_type");
    expect(APPOINTMENT_SELECT).toContain("a.doctor_id");
    expect(APPOINTMENT_SELECT).not.toMatch(/CASE\s+WHEN[^`]*patient_confirmed_at/i);
  });

  it.each(["booked", "arrived", "done", "cancelled", "no_show"])(
    "keeps %s status and an independently recorded patient stamp", (status) => {
      const result = toAppointment(row(new Date("2026-10-21T12:34:00.000Z"), status));
      expect(result.status).toBe(status);
      expect(result.patientConfirmedAt).toBe("2026-10-21T12:34:00.000Z");
      expect(result.doctorId).toBeNull();
      expect(result.durationMinutes).toBe(20);
      expect(result.appointmentType).toBe("consultation");
    },
  );

  it("leaves a missing confirmation null even if operationally arrived", () => {
    expect(toAppointment(row(null, "arrived")).patientConfirmedAt).toBeNull();
  });

  it("preserves the existing same-slot stamp / changed-slot reset writer", () => {
    // Native source contract; the PostgreSQL execution regression lives in
    // __tests__/postgres/reschedule-reminder-reset.test.ts.
    const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
    const move = source.slice(source.indexOf("export async function moveAppointmentOnClient("));
    expect(move).toMatch(/patient_confirmed_at\s*=\s*CASE WHEN scheduled_date = \$2::date AND scheduled_time = \$3::time\s+THEN patient_confirmed_at END/);
  });
});
