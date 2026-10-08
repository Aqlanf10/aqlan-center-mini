import { beforeEach, describe, expect, it, vi } from "vitest";
import { financeAccessFor } from "../lib/finance-permissions";
import { dailyClinicReportFixture } from "./fixtures/daily-clinic-report";
import { apiRouteVerdict } from "../lib/http-permissions";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/daily-clinic-report", () => ({ loadDailyClinicReport: vi.fn(), getDailyClinicReportToday: vi.fn() }));
import { GET } from "../app/api/reports/daily-clinic/route";
import { requireSession } from "../lib/session";
import { getDailyClinicReportToday, loadDailyClinicReport } from "../lib/daily-clinic-report";

const session = vi.mocked(requireSession);
const load = vi.mocked(loadDailyClinicReport);
const today = vi.mocked(getDailyClinicReportToday);
const request = (query = "?date=2026-09-30") => new Request(`https://synthetic.invalid/api/reports/daily-clinic${query}`);
const role = (value: "admin" | "accountant" | "doctor" | "cashier" | "reception" | "assistant") => {
  session.mockResolvedValue({ username: "synthetic", userId: 1, role: value, expiresAt: Date.now() + 60_000,
    ...(value === "accountant" || value === "cashier" ? { financeAccess: financeAccessFor(value) } : {}),
  });
};

beforeEach(() => {
  vi.resetAllMocks(); role("admin");
  today.mockReturnValue("2026-09-30");
  load.mockResolvedValue(dailyClinicReportFixture("2026-09-30"));
});

describe("daily clinic close: actual GET authorization and error boundary", () => {
  it("registers the exact read route in the proxy matrix for ADMIN only", () => {
    expect(apiRouteVerdict("/api/reports/daily-clinic", "GET")).toEqual({ kind: "registered", pattern: "/api/reports/daily-clinic", access: ["admin"] });
    expect(apiRouteVerdict("/api/reports/daily-clinic", "POST").kind).toBe("method-not-allowed");
  });
  it("returns 401 before any date/report reads for an anonymous request", async () => {
    session.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(load).not.toHaveBeenCalled(); expect(today).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("SYNTHETIC");
  });
  it.each(["accountant", "doctor", "cashier", "reception", "assistant"] as const)("denies %s even with normal financial rights", async (value) => {
    role(value);
    const response = await GET(request("?date=bad"));
    expect(response.status).toBe(403);
    expect(load).not.toHaveBeenCalled(); expect(today).not.toHaveBeenCalled();
    expect(await response.text()).not.toContain("attendees");
  });
  it("returns the complete admin result without caching or a detail slice", async () => {
    const report = dailyClinicReportFixture("2026-09-30", 1101);
    load.mockResolvedValue(report);
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(report);
    expect(load).toHaveBeenCalledExactlyOnceWith("2026-09-30");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Cache-Control")).toContain("private");
    expect(response.headers.get("Vary")).toBe("Cookie, Authorization");
  });
  it("defaults only an absent date to the clinic day", async () => {
    today.mockReturnValue("2026-10-01");
    await GET(request(""));
    expect(today).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledExactlyOnceWith("2026-10-01");
  });
  it.each(["", "2026-02-29", "2026-02-30", "2026-13-01", "2026-00-01", "2026-04-31", "26-09-30", "2026-9-30", "0000-01-01", "2026-09-30T00:00:00Z", "2026-09-30&date=2026-09-30", "%20%202026-09-30"])("rejects malformed, impossible or repeated date %s without loading", async (value) => {
    const response = await GET(request(`?date=${value}`));
    expect(response.status).toBe(400); expect(load).not.toHaveBeenCalled(); expect(today).not.toHaveBeenCalled();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
  it.each(["2024-02-29", "2000-02-29", "2026-09-30"])("accepts a real calendar date %s", async (value) => {
    expect((await GET(request(`?date=${value}`))).status).toBe(200);
    expect(load).toHaveBeenCalledExactlyOnceWith(value);
  });
  it("rechecks role each time rather than retaining an admin report after revocation", async () => {
    expect((await GET(request())).status).toBe(200);
    role("reception");
    expect((await GET(request())).status).toBe(403);
    expect(load).toHaveBeenCalledOnce();
  });
  it.each(["session", "query"])("returns generic no-store failure without sensitive diagnostics from %s", async (source) => {
    const sensitive = new Error("SYNTHETIC patient/private SQL SELECT payment account detail");
    if (source === "session") session.mockRejectedValue(sensitive); else load.mockRejectedValue(sensitive);
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر إعداد كشف إقفال اليوم. أعد المحاولة." });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });
});
