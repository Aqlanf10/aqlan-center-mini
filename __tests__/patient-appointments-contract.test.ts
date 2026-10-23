import { describe, expect, it } from "vitest";
import { canRemindPatientRole, encodePatientAppointmentsCursor, patientAppointmentId, readPatientAppointmentsPage, readPatientAppointmentsQuery, validAppointmentDate } from "../lib/patient-appointments-contract";
import { appointment, payload } from "./fixtures/patient-appointments";
describe("patient appointment read contract", () => {
  it.each(["", "0", "-1", "1.0", " 1", "1e2", "0x10", "2147483648", "9007199254740993"])("rejects ambiguous or out-of-range IDs %s", value => expect(patientAppointmentId(value)).toBeNull());
  it.each(["2026-02-30", "2026-2-01", "0999-12-31", "bad"])("rejects invalid dates %s", value => expect(validAppointmentDate(value)).toBe(false));
  it("uses patient/view-bound, precise-time keyset cursor with fixed cutoff", () => {
    const cursor = encodePatientAppointmentsCursor({ patientId: 31, view: "history", today: "2026-10-22", date: "2026-10-21", time: "10:00:00.000001", id: 7 });
    expect(readPatientAppointmentsQuery(new URLSearchParams({ view: "history", cursor }), 31)?.cursor?.time).toBe("10:00:00.000001");
    expect(readPatientAppointmentsQuery(new URLSearchParams({ view: "upcoming", cursor }), 31)).toBeNull();
    expect(readPatientAppointmentsQuery(new URLSearchParams({ view: "history", cursor }), 32)).toBeNull();
  });
  it.each(["view=all", "view=history&view=history", "cursor=", "cursor=a&cursor=b", "limit=999", "patientId=32", "doctorId=1"])("rejects invalid/expanded query %s", query => expect(readPatientAppointmentsQuery(new URLSearchParams(query), 31)).toBeNull());
  it("accepts only complete validated rows for the requested patient and bucket", () => {
    expect(readPatientAppointmentsPage(payload(), 31, "upcoming", null)).toEqual(payload());
    expect(readPatientAppointmentsPage({ ...payload(), appointments: [] }, 31, "upcoming", null)?.appointments).toEqual([]);
    const closed = { ...payload(), view: "history", appointments: [{ ...appointment(), status: "cancelled" }] };
    expect(readPatientAppointmentsPage(closed, 31, "history", null)).toEqual(closed);
  });
  it.each([{ patientId: 32 }, { scheduledDate: "2026-02-30" }, { scheduledTime: "24:00" }, { status: "invented" }, { status: "cancelled" }, { durationMinutes: 0 }, { durationMinutes: 1441 }, { doctorId: undefined }, { patientName: "" }, { reminderSentAt: "bad" }, { reminderSentAt: "0" }])("fails closed for malformed row %j", invalid => {
    expect(readPatientAppointmentsPage({ ...payload(), appointments: [{ ...appointment(), ...invalid }] }, 31, "upcoming", null)).toBeNull();
  });
  it.each([{ appointments: null }, { nextCursor: "bad" }, { canRemind: "yes" }, { today: "bad" }, { timeZone: "Wrong/Zone" }, { generatedAt: "invalid" }, { generatedAt: "0" }, { patientId: 32 }, { requestCursor: "other" }])("fails closed for malformed page %j", invalid => {
    expect(readPatientAppointmentsPage({ ...payload(), ...invalid }, 31, "upcoming", null)).toBeNull();
  });
  it("rejects duplicated rows, truncation and a next cursor unrelated to the last row", () => {
    expect(readPatientAppointmentsPage({ ...payload(), appointments: [appointment(), appointment()] }, 31, "upcoming", null)).toBeNull();
    const appointments = Array.from({ length: 21 }, (_, i) => ({ ...appointment(), id: i + 1 }));
    expect(readPatientAppointmentsPage({ ...payload(), appointments }, 31, "upcoming", null)).toBeNull();
    const nextCursor = encodePatientAppointmentsCursor({ patientId: 31, view: "upcoming", today: "2026-10-22", date: "2026-10-22", time: "10:00:00.000000", id: 19 });
    expect(readPatientAppointmentsPage({ ...payload(), appointments: appointments.slice(0, 20), nextCursor }, 31, "upcoming", null)).toBeNull();
  });
  it("never grants mutation capability to assistants or financial roles", () => {
    expect(["admin", "reception", "doctor"].every(canRemindPatientRole)).toBe(true);
    expect(["assistant", "cashier", "accountant", "", "unknown"].some(canRemindPatientRole)).toBe(false);
  });
});
