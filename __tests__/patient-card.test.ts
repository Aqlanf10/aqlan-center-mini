import { describe, expect, it } from "vitest";
import { isUpcoming, upcomingAppointments } from "../lib/patientCard";
import type { Appointment } from "../lib/schedule";

const appointment = (overrides: Partial<Appointment>): Appointment => ({
  id: 1, patientId: 1, patientName: "مريض", patientPhone: null,
  scheduledDate: "2026-09-10", scheduledTime: "16:00", durationMinutes: 30,
  status: "booked", note: null, ...overrides,
});

describe("بطاقة المريض — المواعيد القادمة مرتّبةً بالأقرب", () => {
  it("الملغى ومن لم يحضر لا يُطبعان على بطاقة", () => {
    expect(isUpcoming(appointment({ status: "cancelled" }), "2026-09-01")).toBe(false);
    expect(isUpcoming(appointment({ status: "no_show" }), "2026-09-01")).toBe(false);
    expect(isUpcoming(appointment({ status: "done" }), "2026-09-01")).toBe(false);
    expect(isUpcoming(appointment({ status: "booked" }), "2026-09-01")).toBe(true);
  });

  it("موعد اليوم في حدود البطاقة — وصلَ أم لم يصل بعد", () => {
    expect(isUpcoming(appointment({ status: "arrived" }), "2026-09-10")).toBe(true);
    expect(isUpcoming(appointment({ status: "booked" }), "2026-09-10")).toBe(true);
  });

  it("ما مضى لا يُطبع، والأقرب أولًا، وبحدٍّ أقصى ثلاثة", () => {
    const next = upcomingAppointments([
      appointment({ id: 3, scheduledDate: "2026-10-01", scheduledTime: "09:00" }),
      appointment({ id: 1, scheduledDate: "2026-09-10", scheduledTime: "16:00" }),
      appointment({ id: 2, scheduledDate: "2026-09-10", scheduledTime: "10:00" }),
      appointment({ id: 4, scheduledDate: "2026-08-01", scheduledTime: "09:00" }),
      appointment({ id: 5, scheduledDate: "2026-11-01", scheduledTime: "09:00" }),
    ], "2026-09-01");
    expect(next.map((one) => one.id)).toEqual([2, 1, 3]);
  });

  it("قائمةٌ بلا مواعيد قادمة تعود فارغة — والفراغ يقول ما يقول في الشاشة", () => {
    expect(upcomingAppointments([], "2026-09-01")).toEqual([]);
  });
});
