import { describe, expect, it } from "vitest";
import { summarizeTomorrow, tomorrowOf } from "@/components/TomorrowCard";
import type { Appointment } from "@/lib/schedule";

describe("tomorrowOf", () => {
  it("crosses month and year ends and leap days", () => {
    expect(tomorrowOf("2026-09-25")).toBe("2026-09-26");
    expect(tomorrowOf("2026-09-30")).toBe("2026-10-01");
    expect(tomorrowOf("2026-12-31")).toBe("2027-01-01");
    expect(tomorrowOf("2028-02-28")).toBe("2028-02-29");
  });
});

describe("summarizeTomorrow", () => {
  const base = {
    patientName: "س", scheduledDate: "2026-09-26", scheduledTime: "10:00", durationMinutes: 30, note: null,
  };
  it("counts only booked appointments, the unreminded with a number, and those waiting on lab work", () => {
    const list = [
      { ...base, id: 1, patientId: 1, patientPhone: "777100200", status: "booked", reminderSentAt: null },
      { ...base, id: 2, patientId: 2, patientPhone: "777100201", status: "booked", reminderSentAt: "2026-09-25T15:00:00Z",
        labReadiness: [{ orderId: 9, workType: "تاج", labName: "م", level: "awaiting", message: "" }] },
      { ...base, id: 3, patientId: 3, patientPhone: null, status: "booked", reminderSentAt: null },
      { ...base, id: 4, patientId: 4, patientPhone: "777100203", status: "cancelled", reminderSentAt: null },
    ] as Appointment[];
    expect(summarizeTomorrow(list)).toEqual({ booked: 3, unreminded: 1, labPending: 1 });
  });
});
