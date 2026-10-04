/** Actual handlers with synthetic DB/session boundaries, following the existing
 * lab-balance-overview-route test. No live proxy, SQL, browser or Production claim. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { labSummary, type LabOrderClinicalDTO } from "../lib/lab";
import { addDays, clinicDateString } from "../lib/schedule";
import { withDefaults } from "../lib/settings";
import {
  REPORT_LAB_TODAY, ZERO_LAB_COUNTS, legacyReportWindow, reportDisplacedReceived,
  reportLateOrders, reportStatusMatrix,
} from "./fixtures/lab-report-counts";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), getSettings: vi.fn(), listVisitsByDate: vi.fn(),
  listAppointmentsByDate: vi.fn(), todayPlannedVisits: vi.fn(),
  labCounts: vi.fn(), listLabOrders: vi.fn(), listLabNames: vi.fn(), listLabServices: vi.fn(),
  createLabOrder: vi.fn(), findUserByUsername: vi.fn(), listParties: vi.fn(), recordAudit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/db", () => ({ ...boundary, CLINIC_TIME_ZONE: "Asia/Riyadh" }));
import { GET as reportGET } from "../app/api/report/route";
import { GET as labGET } from "../app/api/lab/route";

let full: LabOrderClinicalDTO[];
const reportRequest = (date?: string) => reportGET(new Request(
  `http://test.invalid/api/report${date === undefined ? "" : `?date=${date}`}`,
));
const badge = { outstanding: 3, late: 1, dueToday: 1, waitingFitting: 3 };

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
  full = reportStatusMatrix();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-report-admin", role: "admin" });
  boundary.getSettings.mockResolvedValue(withDefaults({}));
  boundary.listVisitsByDate.mockResolvedValue([]);
  boundary.listAppointmentsByDate.mockResolvedValue([]);
  boundary.todayPlannedVisits.mockResolvedValue([]);
  boundary.listLabOrders.mockImplementation(async (filters?: { limit?: number }) =>
    legacyReportWindow(full, filters?.limit ?? 300));
  boundary.labCounts.mockImplementation(async (options?: { mode: "workflow"; today: string }) => {
    if (options === undefined) return badge;
    // Fail on a missing/incorrect mode/day, instead of returning a magic fixture.
    expect(options).toEqual({ mode: "workflow", today: REPORT_LAB_TODAY });
    return labSummary(full, options.today);
  });
});
afterEach(() => { vi.useRealTimers(); });

function expectAggregateOwner() {
  expect(boundary.labCounts).toHaveBeenCalledExactlyOnceWith({ mode: "workflow", today: REPORT_LAB_TODAY });
  expect(boundary.listLabOrders).not.toHaveBeenCalled();
  expect(boundary.recordAudit).not.toHaveBeenCalled();
  expect(boundary.createLabOrder).not.toHaveBeenCalled();
}

describe("daily report complete lab aggregate", () => {
  it.each([301, 501])("returns all %i overdue orders rather than a row-window total", async (count) => {
    full = reportLateOrders(count);
    const response = await reportRequest();
    expect(response.status).toBe(200);
    expect((await response.json()).lab)
      .toEqual({ outstanding: count, late: count, dueToday: 0, waitingFitting: 0 });
    expectAggregateOwner();
  });

  it("counts a received row after 300 earlier closed rows", async () => {
    full = reportDisplacedReceived();
    const response = await reportRequest();
    expect(response.status).toBe(200);
    expect((await response.json()).lab).toEqual({ ...ZERO_LAB_COUNTS, waitingFitting: 1 });
    expectAggregateOwner();
  });

  it.each(["2026-09-01", "2026-11-01"])("keeps lab current when report date is %s", async (selectedDate) => {
    const response = await reportRequest(selectedDate);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ date: selectedDate, nextDate: addDays(selectedDate, 1),
      lab: { outstanding: 9, late: 3, dueToday: 3, waitingFitting: 3 } });
    expect(boundary.listVisitsByDate).toHaveBeenCalledExactlyOnceWith(selectedDate);
    expect(boundary.listAppointmentsByDate.mock.calls).toEqual([[selectedDate], [addDays(selectedDate, 1)]]);
    expect(boundary.todayPlannedVisits).toHaveBeenCalledExactlyOnceWith(selectedDate, null);
    expect(Object.keys(body.lab).sort()).toEqual(["dueToday", "late", "outstanding", "waitingFitting"]);
    expectAggregateOwner();
  });

  it("captures one clinic day before awaited reads across clinic midnight", async () => {
    vi.setSystemTime(new Date("2026-10-04T20:59:59.990Z"));
    expect(clinicDateString(new Date(), "Asia/Riyadh")).toBe(REPORT_LAB_TODAY);
    boundary.getSettings.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2026-10-04T21:00:00.010Z"));
      expect(clinicDateString(new Date(), "Asia/Riyadh")).toBe("2026-10-05");
      return withDefaults({});
    });
    const response = await reportRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ date: REPORT_LAB_TODAY,
      lab: { outstanding: 9, late: 3, dueToday: 3, waitingFitting: 3 } });
    expectAggregateOwner();
  });

  it("accepts a successful empty aggregate as four zeros", async () => {
    full = [];
    const response = await reportRequest();
    expect(response.status).toBe(200);
    expect((await response.json()).lab).toEqual(ZERO_LAB_COUNTS);
    expectAggregateOwner();
  });

  it("propagates aggregate failure through the existing 500, never successful fake zeros", async () => {
    full = [];
    boundary.labCounts.mockRejectedValue(new Error("Synthetic aggregate failure"));
    const response = await reportRequest();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر تحميل التقرير." });
    expectAggregateOwner();
  });

  it("denies an expired session before any business read", async () => {
    boundary.requireSession.mockResolvedValue(null);
    expect((await reportRequest()).status).toBe(401);
    for (const read of [boundary.getSettings, boundary.listVisitsByDate, boundary.listAppointmentsByDate,
      boundary.todayPlannedVisits, boundary.labCounts, boundary.listLabOrders]) expect(read).not.toHaveBeenCalled();
  });

  it("preserves linked-doctor planned-visit scope independently of global lab counts", async () => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-report-doctor", role: "doctor", partyId: 17 });
    expect((await reportRequest("2026-09-01")).status).toBe(200);
    expect(boundary.todayPlannedVisits).toHaveBeenCalledExactlyOnceWith("2026-09-01", 17);
    expectAggregateOwner();
  });
});

describe("existing lab summary/badge contract", () => {
  it.each(["summary=1", "summary=1&patientId=17&services=1"])("retains no-argument summary precedence for %s", async (query) => {
    const response = await labGET(new Request(`http://test.invalid/api/lab?${query}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(badge);
    expect(boundary.labCounts).toHaveBeenCalledExactlyOnceWith();
    for (const read of [boundary.listLabOrders, boundary.listLabNames, boundary.listLabServices]) expect(read).not.toHaveBeenCalled();
  });
});
