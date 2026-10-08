import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), buildReport: vi.fn(), dbTodayISO: vi.fn(),
  parseFilters: vi.fn(), reportOptions: vi.fn(),
  unexpectedDataRead: vi.fn(),
}));
vi.mock("../lib/session", () => ({ requireSession: boundary.requireSession }));
// Retain the real report validator/error class while keeping every business
// read inert. Do not import the real DB module or replace the validator itself.
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "America/New_York", PLAN_FUNDED_BY_AGREEMENT_SQL: "synthetic unused SQL",
  getPool: boundary.unexpectedDataRead, ensureSchema: boundary.unexpectedDataRead,
  getSettings: boundary.unexpectedDataRead, listParties: boundary.unexpectedDataRead,
  listServices: boundary.unexpectedDataRead, commissionReport: boundary.unexpectedDataRead,
  listOpenPastAppointments: boundary.unexpectedDataRead, listMissedAppointments: boundary.unexpectedDataRead,
  listLapsedPatients: boundary.unexpectedDataRead, materialRateAsOf: boundary.unexpectedDataRead,
  materialRateTimeline: boundary.unexpectedDataRead, listOrthoDuplicateAdjustments: boundary.unexpectedDataRead,
  commissionDetailReport: boundary.unexpectedDataRead, computeDebtRows: boundary.unexpectedDataRead,
}));
vi.mock("../lib/reports-ops", () => ({
  CHAIR_EVENT_ROW_CAP: 2000, REFERRAL_HISTORY_ROW_CAP: 2000,
  loadChairFlow: boundary.unexpectedDataRead, loadInternalReferrals: boundary.unexpectedDataRead,
}));
vi.mock("../lib/capacity-context", () => ({ loadCapacityContext: boundary.unexpectedDataRead }));
vi.mock("../lib/reports", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/reports")>();
  return { ...actual, buildReport: boundary.buildReport, dbTodayISO: boundary.dbTodayISO,
    parseFilters: boundary.parseFilters, reportOptions: boundary.reportOptions };
});
import { ReportInputError, validateAnnualReportRange } from "../lib/reports";
import { GET } from "../app/api/reports/route";

const rawInstant = "2000-02-02T02:00:00.000Z";
const filters = { from: "2000-01-01", to: "2000-01-31" };
const result = { report: "daily", title: "Synthetic report", ...filters, kpis: [] };
const request = (report = "daily", params: Record<string, string> = {}) =>
  GET(new Request(`https://synthetic.invalid/api/reports?${new URLSearchParams({ report, ...params })}`));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(rawInstant));
  boundary.unexpectedDataRead.mockImplementation(() => { throw new Error("Unexpected business read in generation-metadata test"); });
  boundary.requireSession.mockResolvedValue({ role: "admin", username: "synthetic author" });
  boundary.dbTodayISO.mockResolvedValue("2000-02-01");
  boundary.parseFilters.mockReturnValue(filters);
  boundary.buildReport.mockResolvedValue(result);
  boundary.reportOptions.mockResolvedValue({ doctors: [], specialties: [] });
});
afterEach(() => {
  vi.useRealTimers();
  expect(boundary.unexpectedDataRead).not.toHaveBeenCalled();
});

describe("authorized report envelope generation timezone", () => {
  it("carries the canonical non-default zone alongside the untouched UTC instant and report", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result, generatedAt: rawInstant, generatedBy: "synthetic author", clinicTimeZone: "America/New_York",
    });
    expect(boundary.dbTodayISO).toHaveBeenCalledExactlyOnceWith();
    expect(boundary.parseFilters).toHaveBeenCalledExactlyOnceWith(expect.any(URLSearchParams), "2000-02-01");
    expect(boundary.buildReport).toHaveBeenCalledExactlyOnceWith("daily", filters);
    expect(boundary.reportOptions).not.toHaveBeenCalled();
  });

  it("keeps generation time separate from the report's already resolved financial dates", async () => {
    boundary.buildReport.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date("2000-02-02T05:00:00.000Z")); // Midnight in the supplied clinic zone.
      return result;
    });
    const response = await request();
    expect(await response.json()).toEqual({
      result, generatedAt: "2000-02-02T05:00:00.000Z", generatedBy: "synthetic author",
      clinicTimeZone: "America/New_York",
    });
    expect(boundary.dbTodayISO).toHaveBeenCalledTimes(1);
    expect(boundary.parseFilters).toHaveBeenCalledExactlyOnceWith(expect.any(URLSearchParams), "2000-02-01");
  });

  it.each([
    { session: null, status: 401 },
    { session: { role: "doctor", username: "synthetic doctor" }, status: 403 },
  ])("does not expand access for status $status", async ({ session, status }) => {
    boundary.requireSession.mockResolvedValueOnce(session);
    const response = await request();
    expect(response.status).toBe(status);
    expect(await response.json()).not.toHaveProperty("clinicTimeZone");
    expect(boundary.dbTodayISO).not.toHaveBeenCalled();
    expect(boundary.parseFilters).not.toHaveBeenCalled();
    expect(boundary.buildReport).not.toHaveBeenCalled();
    expect(boundary.reportOptions).not.toHaveBeenCalled();
  });

  it("does not add generation metadata to the independent options response", async () => {
    const response = await request("options");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ doctors: [], specialties: [] });
    expect(boundary.dbTodayISO).not.toHaveBeenCalled();
    expect(boundary.buildReport).not.toHaveBeenCalled();
  });

  it("does not turn a failed report build into a successful metadata envelope", async () => {
    boundary.buildReport.mockRejectedValueOnce(new Error("Synthetic failure"));
    const response = await request();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر إعداد التقرير. أعد المحاولة." });
  });

  it("composes a valid 120-month annual/custom request with untouched generation metadata", async () => {
    const range = { from: "2017-01-01", to: "2026-12-31" };
    const annualResult = { ...result, ...range, report: "annual" };
    expect(validateAnnualReportRange(range.from, range.to)).toMatchObject(range);
    boundary.parseFilters.mockReturnValueOnce(range);
    boundary.buildReport.mockResolvedValueOnce(annualResult);
    const response = await request("annual", { preset: "custom", ...range });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: annualResult, generatedAt: rawInstant,
      generatedBy: "synthetic author", clinicTimeZone: "America/New_York" });
    expect(boundary.dbTodayISO).toHaveBeenCalledExactlyOnceWith();
    expect(boundary.parseFilters).toHaveBeenCalledExactlyOnceWith(expect.any(URLSearchParams), "2000-02-01");
    expect(boundary.buildReport).toHaveBeenCalledExactlyOnceWith("annual", range);
  });

  it.each([
    { from: "2026-02-30", to: "2026-03-01", message: "تاريخي" },
    { from: "", to: "2026-03-01", message: "تاريخي" },
    { from: "2016-12-31", to: "2026-12-01", message: "120" },
  ])("retains the real typed 400 for annual/custom range $from to $to before generation metadata", async ({ from, to, message }) => {
    expect(() => validateAnnualReportRange(from, to)).toThrow(ReportInputError);
    const response = await request("annual", { preset: "custom", from, to });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: expect.stringContaining(message) });
    expect(boundary.dbTodayISO).not.toHaveBeenCalled();
    expect(boundary.parseFilters).not.toHaveBeenCalled();
    expect(boundary.buildReport).not.toHaveBeenCalled();
    expect(boundary.reportOptions).not.toHaveBeenCalled();
  });

  it("preserves real ReportInputError handling from the builder after annual validation succeeds", async () => {
    const message = "تعذّر إعداد التقرير السنوي التجريبي.";
    boundary.buildReport.mockRejectedValueOnce(new ReportInputError(message));
    const response = await request("annual", { preset: "custom", from: "2026-01-01", to: "2026-12-31" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message });
    expect(boundary.buildReport).toHaveBeenCalledTimes(1);
  });
});
