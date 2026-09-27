import { describe, expect, it } from "vitest";
import type { Visit } from "../lib/flow";
import type { Appointment } from "../lib/schedule";
import {
  NO_FILTER, doctorsOfDay, filterAppointments, filterVisits, isFiltered, todayCounters,
} from "../lib/today-board";

/** (LIVE-2) مرشّحات لوحة اليوم وعدّاداتها — حالة الزيارة وحالة الموعد لا تُخلطان. */

const visit = (id: number, status: Visit["status"], doctorId: number | null, chair: number | null = null): Visit => ({
  id, patientId: id, patientName: `م${id}`, patientPhone: null, note: null, status, chair,
  arrivedAt: "2026-09-28T07:00:00.000Z", seatedAt: null, calledAt: null, finishedAt: null, doctorId,
});
const appointment = (id: number, status: Appointment["status"], doctorId: number | null, chairNo: number | null = null): Appointment => ({
  id, patientId: 100 + id, patientName: `موعد${id}`, patientPhone: null, scheduledDate: "2026-09-28",
  scheduledTime: "10:00", durationMinutes: 30, note: null, status, doctorId, chairNo,
});

const visits = [
  visit(1, "waiting", 7), visit(2, "waiting", null), visit(3, "called", 7, 1),
  visit(4, "in_chair", 8, 2), visit(5, "done", 7, 1), visit(6, "done", 8, 2),
];
const appointments = [
  appointment(1, "booked", 7), appointment(2, "booked", 8, 2), appointment(3, "no_show", 7),
  appointment(4, "cancelled", 8), appointment(5, "arrived", 7), appointment(6, "done", 8),
];

describe("filters", () => {
  it("no filter shows everything", () => {
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(filterVisits(visits, NO_FILTER)).toHaveLength(6);
    expect(filterAppointments(appointments, NO_FILTER)).toHaveLength(6);
  });

  it("doctor: a doctor's visits and appointments; «none» = walk-ins without a doctor", () => {
    const dr7 = { ...NO_FILTER, doctor: 7 };
    expect(isFiltered(dr7)).toBe(true);
    expect(filterVisits(visits, dr7).map((v) => v.id)).toEqual([1, 3, 5]);
    expect(filterAppointments(appointments, dr7).map((a) => a.id)).toEqual([1, 3, 5]);
    expect(filterVisits(visits, { ...NO_FILTER, doctor: "none" }).map((v) => v.id)).toEqual([2]);
  });

  it("status narrows visits only; chair keeps only that chair (the unseated waiting have no chair)", () => {
    expect(filterVisits(visits, { ...NO_FILTER, status: "done" }).map((v) => v.id)).toEqual([5, 6]);
    expect(filterVisits(visits, { ...NO_FILTER, chair: 1 }).map((v) => v.id)).toEqual([3, 5]);
    // موعدٌ بلا كرسيٍ محدد يبقى تحت مرشّح الكرسي — لا يُعرف أين سيجلس بعد.
    expect(filterAppointments(appointments, { ...NO_FILTER, chair: 1 }).map((a) => a.id)).toEqual([1, 3, 4, 5, 6]);
  });
});

describe("counters", () => {
  it("visit states and appointment states are counted from their own source", () => {
    expect(todayCounters(visits, appointments, 1)).toEqual({
      waiting: 2, called: 1, inChair: 1, done: 2,
      expected: 2, late: 1, noShow: 1, cancelled: 1,
    });
  });

  it("follow the filter: a doctor reads his own numbers", () => {
    const dr8 = { ...NO_FILTER, doctor: 8 };
    expect(todayCounters(filterVisits(visits, dr8), filterAppointments(appointments, dr8), 0)).toMatchObject({
      waiting: 0, inChair: 1, done: 1, expected: 1, noShow: 0, cancelled: 1,
    });
  });
});

describe("doctors of the day", () => {
  it("lists only doctors with a visit or appointment today, sorted; an unknown id stays filterable", () => {
    expect(doctorsOfDay(visits, [...appointments, appointment(9, "booked", 99)], [
      { id: 8, name: "د. سامي" }, { id: 7, name: "د. أحمد" }, { id: 5, name: "د. غائب" },
    ])).toEqual([
      { id: 7, name: "د. أحمد" }, { id: 8, name: "د. سامي" }, { id: 99, name: "طبيب #99" },
    ]);
  });
});
