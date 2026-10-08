import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportFilters } from "../lib/reports-types";

/** Pure/mocked source coverage only; never connects to a database. */
const harness = vi.hoisted(() => ({
  query: vi.fn(async () => ({ rows: [] })),
  ensureSchema: vi.fn(async () => {}),
  listParties: vi.fn(async () => []),
}));
vi.mock("../lib/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/db")>();
  return {
    ...actual,
    ensureSchema: harness.ensureSchema,
    listParties: harness.listParties,
    getPool: () => ({ query: harness.query }),
  };
});
vi.mock("../lib/session", () => ({
  requireSession: vi.fn(async () => ({ role: "admin", username: "synthetic-report-admin" })),
}));

const { buildReport, parseFilters, ReportInputError, validateAnnualReportRange } = await import("../lib/reports");
const { GET } = await import("../app/api/reports/route");

beforeEach(() => {
  vi.clearAllMocks();
});

const filters = (from: string, to: string): ReportFilters => ({
  ...parseFilters(new URLSearchParams({ preset: "this_year" }), "2026-10-08"),
  preset: "custom", from, to,
});
const request = (params: Record<string, string>) =>
  new Request("http://localhost/api/reports?" + new URLSearchParams({ report: "annual", preset: "custom", ...params }));
function expectNoFinancialLoad() {
  expect(harness.listParties).not.toHaveBeenCalled();
  expect(harness.ensureSchema).not.toHaveBeenCalled();
  expect(harness.query).not.toHaveBeenCalled();
}

describe("annual technical request-size and calendar validation", () => {
  it("accepts exactly 120 inclusive months and normalizes reversed endpoints", () => {
    const expected = {
      from: "2017-01-31", to: "2026-12-01", firstMonth: 2017 * 12, lastMonth: 2026 * 12 + 11,
    };
    expect(validateAnnualReportRange("2017-01-31", "2026-12-01")).toEqual(expected);
    expect(validateAnnualReportRange("2026-12-01", "2017-01-31")).toEqual(expected);
    expectNoFinancialLoad();
  });

  it("rejects 121 covered months even when both endpoints are partial months", async () => {
    const from = "2016-12-31";
    const to = "2026-12-01";
    expect(() => validateAnnualReportRange(from, to)).toThrow(ReportInputError);
    expect(() => validateAnnualReportRange(to, from)).toThrow("120");
    await expect(buildReport("annual", filters(from, to))).rejects.toThrow(ReportInputError);
    expectNoFinancialLoad();
  });

  it.each([
    ["", "2026-01-01"],
    [null, "2026-01-01"],
    [undefined, "2026-01-01"],
    ["2026-1-01", "2026-01-31"],
    ["not-a-date", "2026-01-31"],
    ["2026-01-01T00:00:00Z", "2026-01-31"],
    ["0000-01-01", "0001-01-01"],
    ["10000-01-01", "9999-12-31"],
    ["2026-00-01", "2026-01-31"],
    ["2026-13-01", "2026-12-31"],
    ["2026-01-00", "2026-01-31"],
    ["2026-01-32", "2026-02-01"],
    ["2026-04-31", "2026-05-01"],
    ["2025-02-29", "2025-03-01"],
    ["1900-02-29", "1900-03-01"],
    ["2026-01-01", "2026-02-30"],
  ])("rejects malformed or nonexistent calendar range %s to %s", (from, to) => {
    expect(() => validateAnnualReportRange(from, to)).toThrow(ReportInputError);
    expectNoFinancialLoad();
  });

  it.each([
    ["0001-01-01", "0001-02-28", 2],
    ["0004-02-29", "0004-02-29", 1],
    ["0099-12-31", "0100-01-01", 2],
    ["2000-02-29", "2000-03-01", 2],
    ["9999-11-30", "9999-12-31", 2],
    ["9999-12-01", "9999-12-31", 1],
  ] as const)("uses finite numeric month iteration for boundary range %s to %s", async (from, to, length) => {
    const result = await buildReport("annual", filters(from, to));
    expect(result).toMatchObject({ from, to });
    expect(result.bars).toHaveLength(length);
    expect(result.monthly?.rows).toEqual([]);
    expect(new Set(result.bars?.map((bar) => bar.label)).size).toBe(length);
  });

  it("builds all 120 requested month bars without silent truncation", async () => {
    const result = await buildReport("annual", filters("2017-01-31", "2026-12-01"));
    expect(result.bars).toHaveLength(120);
    expect(result.bars?.[0].label).toBe("يناير 2017");
    expect(result.bars?.[119].label).toBe("ديسمبر 2026");
    expect(result.periodLabel).toBe("31/01/2017 → 01/12/2026");
    expect(result.subtitle).toBe("السنوات 2017 → 2026");
  });

  it("retains valid 13-month requests and reversed direct-builder inputs", async () => {
    const result = await buildReport("annual", filters("2026-01-15", "2027-01-15"));
    expect(result.bars).toHaveLength(13);
    expect(result.bars?.[0].label).toBe("يناير 2026");
    expect(result.bars?.[12].label).toBe("يناير 2027");
    const reversed = await buildReport("annual", filters("2027-01-15", "2026-01-15"));
    expect(reversed).toEqual(result);
  });

  it("leaves the default this-year presentation and twelve-month scope unchanged", async () => {
    const currentYear = parseFilters(new URLSearchParams({ preset: "this_year" }), "2026-10-08");
    const result = await buildReport("annual", currentYear);
    expect(result).toMatchObject({ from: "2026-01-01", to: "2026-12-31", subtitle: "سنة 2026" });
    expect(result.bars).toHaveLength(12);
    expect(result.bars?.[0].label).toBe("يناير");
    expect(result.bars?.[11].label).toBe("ديسمبر");
  });

  it.each([
    ["2026-02-30", "2026-03-01"],
    ["2026-01-01", "not-a-date"],
    ["1000-01-01", "9998-12-31"],
  ])("rejects invalid direct-builder range %s to %s before financial loading", async (from, to) => {
    await expect(buildReport("annual", filters(from, to))).rejects.toThrow(ReportInputError);
    expectNoFinancialLoad();
  });

  it("rejects malformed raw annual filters used by print and saved links before fallback", () => {
    for (const value of ["not-a-date", "2026-2-28", "2026-02-30"]) {
      expect(() => parseFilters(new URLSearchParams({
        report: "annual", preset: "custom", from: value, to: "2026-03-01",
      }), "2026-10-08")).toThrow(ReportInputError);
    }
    expectNoFinancialLoad();
  });

  it("does not impose the annual response budget on a monthly report", async () => {
    const result = await buildReport("monthly", filters("2016-12-01", "2026-12-31"));
    expect(result.report).toBe("monthly");
    expect(harness.listParties).toHaveBeenCalled();
  });
});

describe("annual raw API input validation", () => {
  const invalidRequests: [Record<string, string>, string][] = [
    [{ from: "2016-12-31", to: "2026-12-01" }, "120"],
    [{ from: "2026-12-01", to: "2016-12-31" }, "120"],
    [{ from: "2026-02-30", to: "2026-03-01" }, "تاريخي"],
    [{ from: "not-a-date", to: "2026-03-01" }, "تاريخي"],
    [{ from: "2026-02-01", to: "2026-2-28" }, "تاريخي"],
    [{ to: "2026-03-01" }, "تاريخي"],
    [{ from: "2026-03-01" }, "تاريخي"],
  ];
  it.each(invalidRequests)("returns explicit Arabic 400 for %j before any date/context database read", async (params, expected) => {
    const response = await GET(request(params));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: expect.stringContaining(expected) });
    expectNoFinancialLoad();
  });

  it("accepts the full 120-month window through the existing API contract", async () => {
    const response = await GET(request({ from: "2017-01-01", to: "2026-12-31" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.bars).toHaveLength(120);
    expect(body.result).toMatchObject({ from: "2017-01-01", to: "2026-12-31" });
  });
});
