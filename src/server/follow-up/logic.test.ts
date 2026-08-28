import { describe, expect, it } from "vitest";

import {
  assessFollowUp,
  DUE_SOON_WINDOW_DAYS,
  queuesFor,
  type FollowUpFacts,
} from "@/server/follow-up/logic";

/**
 * The clinic timezone is fixed to Asia/Aden (UTC+03:00) for these tests so
 * ISO-date math is deterministic. Instants are chosen around midnight
 * boundaries on purpose.
 */
const TZ = "Asia/Aden";

function facts(overrides: Partial<FollowUpFacts> = {}): FollowUpFacts {
  return {
    active: true,
    treatmentStatus: "ACTIVE",
    todayIso: "2026-08-27",
    nextAppointmentDate: null,
    lastCompletedVisitDate: null,
    recallIntervalDays: 21,
    lastNoShowDate: null,
    ...overrides,
  };
}

describe("assessFollowUp — case A (future appointment as reference)", () => {
  it("appointment far in the future is ON_TIME", () => {
    const a = assessFollowUp(
      facts({
        nextAppointmentDate: new Date("2026-09-20T08:00:00Z"),
        lastCompletedVisitDate: new Date("2026-08-01T08:00:00Z"),
      }),
      TZ
    );
    expect(a.timing).toBe("ON_TIME");
    expect(a.status).toBe("ON_TIME");
  });

  it("appointment within the 3-day window is DUE_SOON", () => {
    const a = assessFollowUp(
      facts({ nextAppointmentDate: new Date("2026-08-29T20:00:00Z") }), // Aug 29 23:00 Aden? -> Aug 29
      TZ
    );
    // 2026-08-29T20:00Z == 2026-08-29T23:00 Aden -> Aug 29, 2 days ahead
    expect(a.timing).toBe("DUE_SOON");
  });

  it("appointment exactly DUE_SOON_WINDOW_DAYS ahead is DUE_SOON", () => {
    const a = assessFollowUp(
      facts({ nextAppointmentDate: new Date("2026-08-30T06:00:00Z") }), // Aug 30 09:00 Aden
      TZ
    );
    expect(a.timing).toBe("DUE_SOON");
    expect(a.status).toBe("DUE_SOON");
  });

  it("appointment today is DUE_TODAY even after a completed visit", () => {
    const a = assessFollowUp(
      facts({
        nextAppointmentDate: new Date("2026-08-27T09:00:00Z"), // 12:00 Aden
        lastCompletedVisitDate: new Date("2026-08-01T09:00:00Z"),
      }),
      TZ
    );
    expect(a.timing).toBe("DUE_TODAY");
    expect(a.status).toBe("DUE_TODAY");
  });

  it("visited patient WITH a future appointment is not flagged NO_NEXT_APPOINTMENT", () => {
    const a = assessFollowUp(
      facts({
        nextAppointmentDate: new Date("2026-09-20T08:00:00Z"),
        lastCompletedVisitDate: new Date("2026-08-26T08:00:00Z"),
      }),
      TZ
    );
    expect(a.status).not.toBe("NO_NEXT_APPOINTMENT");
    expect(queuesFor(a)).not.toContain("no-next-appointment");
  });
});

describe("assessFollowUp — case B (recall = last visit + interval)", () => {
  it("recall date already passed is OVERDUE", () => {
    const a = assessFollowUp(
      facts({
        lastCompletedVisitDate: new Date("2026-06-01T09:00:00Z"),
        recallIntervalDays: 21,
      }),
      TZ
    );
    expect(a.timing).toBe("OVERDUE");
    expect(a.recallDueIsoDate).toBe("2026-06-22");
  });

  it("recall date exactly today is DUE_TODAY", () => {
    const a = assessFollowUp(
      facts({
        todayIso: "2026-08-27",
        lastCompletedVisitDate: new Date("2026-08-06T09:00:00Z"),
        recallIntervalDays: 21,
      }),
      TZ
    );
    expect(a.recallDueIsoDate).toBe("2026-08-27");
    expect(a.timing).toBe("DUE_TODAY");
  });

  it("recall date within the window is DUE_SOON", () => {
    const a = assessFollowUp(
      facts({
        todayIso: "2026-08-27",
        lastCompletedVisitDate: new Date("2026-08-08T09:00:00Z"),
        recallIntervalDays: 21,
      }),
      TZ
    );
    expect(a.recallDueIsoDate).toBe("2026-08-29");
    expect(a.timing).toBe("DUE_SOON");
  });

  it("recall date beyond the window is ON_TIME timing", () => {
    const a = assessFollowUp(
      facts({
        lastCompletedVisitDate: new Date("2026-08-27T09:00:00Z"),
        recallIntervalDays: 30,
      }),
      TZ
    );
    expect(a.timing).toBe("ON_TIME");
  });

  it("uses the per-patient interval, never a hard-coded 21", () => {
    const seven = assessFollowUp(
      facts({
        todayIso: "2026-08-27",
        lastCompletedVisitDate: new Date("2026-08-22T09:00:00Z"),
        recallIntervalDays: 7,
      }),
      TZ
    );
    expect(seven.recallDueIsoDate).toBe("2026-08-29");
    expect(seven.timing).toBe("DUE_SOON");

    const thirty = assessFollowUp(
      facts({
        todayIso: "2026-08-27",
        lastCompletedVisitDate: new Date("2026-08-22T09:00:00Z"),
        recallIntervalDays: 30,
      }),
      TZ
    );
    expect(thirty.recallDueIsoDate).toBe("2026-09-21");
    expect(thirty.timing).toBe("ON_TIME");
  });

  it("counts days since last visit", () => {
    const a = assessFollowUp(
      facts({
        lastCompletedVisitDate: new Date("2026-08-20T09:00:00Z"), // Aug 20 Aden
      }),
      TZ
    );
    expect(a.daysSinceLastVisit).toBe(7);
  });
});

describe("assessFollowUp — case C (missed appointments)", () => {
  it("unresolved NO_SHOW is MISSED", () => {
    const a = assessFollowUp(
      facts({
        lastCompletedVisitDate: new Date("2026-08-01T09:00:00Z"),
        lastNoShowDate: new Date("2026-08-25T09:00:00Z"),
      }),
      TZ
    );
    expect(a.status).toBe("MISSED");
    expect(queuesFor(a)).toContain("missed");
  });

  it("MISSED outranks NO_NEXT_APPOINTMENT as the display status", () => {
    const a = assessFollowUp(
      facts({
        lastCompletedVisitDate: new Date("2026-08-01T09:00:00Z"),
        lastNoShowDate: new Date("2026-08-25T09:00:00Z"),
      }),
      TZ
    );
    expect(a.status).toBe("MISSED");
    // but the patient may still appear in the no-next queue via status? No —
    // status is MISSED here; the no-next queue derives from status.
    expect(queuesFor(a)).not.toContain("no-next-appointment");
  });

  it("rescheduled patients (future appointment exists) are not MISSED", () => {
    const a = assessFollowUp(
      facts({
        nextAppointmentDate: new Date("2026-08-29T09:00:00Z"),
        lastNoShowDate: null, // caller resolves NO_SHOW when a new appt exists
      }),
      TZ
    );
    expect(a.status).not.toBe("MISSED");
  });
});

describe("assessFollowUp — case D (no next appointment safety net)", () => {
  it("visited patient without a future appointment is NO_NEXT_APPOINTMENT even when recall is far away", () => {
    const a = assessFollowUp(
      facts({
        lastCompletedVisitDate: new Date("2026-08-26T09:00:00Z"), // yesterday
        recallIntervalDays: 90,
      }),
      TZ
    );
    expect(a.status).toBe("NO_NEXT_APPOINTMENT");
    expect(a.timing).toBe("ON_TIME"); // recall not due yet
    expect(queuesFor(a)).toContain("no-next-appointment");
  });

  it("brand-new patient (never visited, no appointment) is not flagged", () => {
    const a = assessFollowUp(facts(), TZ);
    expect(a.status).toBe("ON_TIME");
    expect(queuesFor(a)).toEqual([]);
  });

  it("unvisited patient with only a booking is judged by the appointment", () => {
    const a = assessFollowUp(
      facts({ nextAppointmentDate: new Date("2026-08-27T08:00:00Z") }),
      TZ
    );
    expect(a.status).toBe("DUE_TODAY");
  });
});

describe("assessFollowUp — inactive & completed treatment", () => {
  it("inactive patients are excluded from everything", () => {
    const a = assessFollowUp(
      facts({
        active: false,
        lastCompletedVisitDate: new Date("2025-01-01T09:00:00Z"),
        lastNoShowDate: new Date("2026-08-25T09:00:00Z"),
      }),
      TZ
    );
    expect(a.status).toBe("INACTIVE");
    expect(queuesFor(a)).toEqual([]);
  });

  it("completed treatment exits the recall cycle when nothing is pending", () => {
    const a = assessFollowUp(
      facts({
        treatmentStatus: "COMPLETED",
        lastCompletedVisitDate: new Date("2025-01-01T09:00:00Z"),
      }),
      TZ
    );
    expect(a.status).toBe("ON_TIME");
    expect(queuesFor(a)).toEqual([]);
  });

  it("completed treatment still surfaces an unresolved NO_SHOW", () => {
    const a = assessFollowUp(
      facts({
        treatmentStatus: "COMPLETED",
        lastCompletedVisitDate: new Date("2025-01-01T09:00:00Z"),
        lastNoShowDate: new Date("2026-08-25T09:00:00Z"),
      }),
      TZ
    );
    expect(a.status).toBe("MISSED");
  });

  it("completed treatment keeps an upcoming appointment visible", () => {
    const a = assessFollowUp(
      facts({
        treatmentStatus: "COMPLETED",
        nextAppointmentDate: new Date("2026-08-27T08:00:00Z"),
      }),
      TZ
    );
    expect(a.timing).toBe("DUE_TODAY");
  });
});

describe("queue membership combinations (Scenario 2 + 4 overlap)", () => {
  it("overdue patient without next appointment appears in BOTH queues", () => {
    const a = assessFollowUp(
      facts({
        lastCompletedVisitDate: new Date("2026-05-01T09:00:00Z"),
        recallIntervalDays: 21,
      }),
      TZ
    );
    expect(a.status).toBe("NO_NEXT_APPOINTMENT");
    expect(a.timing).toBe("OVERDUE");
    expect(queuesFor(a)).toContain("overdue");
    expect(queuesFor(a)).toContain("no-next-appointment");
  });

  it("window constant is 3 days and exposed centrally", () => {
    expect(DUE_SOON_WINDOW_DAYS).toBe(3);
  });
});
