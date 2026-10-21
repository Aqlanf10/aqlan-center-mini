import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ session: vi.fn(), read: vi.fn(), access: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mock.session }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden" }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mock.access }));
vi.mock("@/lib/doctor-daily-schedule", async (original) => ({
  ...await original<typeof import("../lib/doctor-daily-schedule")>(), readDoctorDailySchedule: mock.read,
}));
import { GET } from "../app/api/appointments/mine/route";
import { resolveScheduleDate } from "../lib/doctor-daily-schedule";
import { apiRouteVerdict } from "../lib/http-permissions";
import { restrictedRouteAllowed } from "../lib/role-routes";
const request = (query = "") => new Request(`http://localhost/api/appointments/mine${query}`);
const row = { appointmentId: 1, patientId: 2, patientName: "Synthetic Patient", time: "09:30", durationMinutes: 30, status: "arrived", hasReferral: false };
beforeEach(() => {
  vi.resetAllMocks();
  mock.session.mockResolvedValue({ role: "doctor", partyId: 7, username: "synthetic" });
  mock.read.mockResolvedValue([row, { ...row, appointmentId: 2, status: "cancelled" }]);
  mock.access.mockResolvedValue(true);
});
describe("personal schedule route authorization", () => {
  it("requires an authenticated current session", async () => {
    mock.session.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(mock.read).not.toHaveBeenCalled();
  });
  it.each(["reception", "cashier", "accountant", "assistant"])("rejects %s without reading", async (role) => {
    mock.session.mockResolvedValue({ role, partyId: 7 });
    expect((await GET(request())).status).toBe(403);
    expect(mock.read).not.toHaveBeenCalled();
  });
  it.each([undefined, null, 0, -2, 1.5, "7"])("rejects invalid session party %s", async (partyId) => {
    mock.session.mockResolvedValue({ role: "doctor", partyId });
    expect((await GET(request())).status).toBe(403);
    expect(mock.read).not.toHaveBeenCalled();
  });
  it.each(["?doctorId=8", "?partyId=8", "?date=today&doctorId=7", "?date=today&date=tomorrow"])("rejects override or ambiguous parameters %s", async (query) => {
    expect((await GET(request(query))).status).toBe(400);
    expect(mock.read).not.toHaveBeenCalled();
  });
  it("rejects inactive or non-doctor party", async () => {
    mock.read.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(403);
  });
  it("uses server party only, includes cancelled separately and uses canonical patient link access", async () => {
    const response = await GET(request("?date=2026-10-22"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(mock.read).toHaveBeenCalledWith(7, "2026-10-22");
    const body = await response.json();
    expect(body.counts).toEqual({ total: 2, scheduled: 1, cancelled: 1 });
    expect(body.appointments.every((item: { patientHref: unknown }) => typeof item.patientHref === "string")).toBe(true);
    expect(mock.access).toHaveBeenCalledTimes(1);
    expect(Object.keys(body.appointments[0]).sort()).toEqual([...Object.keys(row), "patientHref"].sort());
  });
  it("fails closed without disclosing patient identity when canonical access denies", async () => {
    mock.access.mockResolvedValue(false);
    const response = await GET(request());
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).not.toContain("Synthetic Patient");
    expect(body).not.toContain("patientId");
  });
  it("opens arrived patients on today tab only for clinic today", async () => {
    const today = await (await GET(request())).json();
    expect(today.appointments[0].patientHref).toBe("/patients/2?tab=today");
    const history = await (await GET(request("?date=2020-01-01"))).json();
    expect(history.appointments[0].patientHref).toBe("/patients/2");
  });
  it("fails without returning stale data", async () => {
    mock.read.mockRejectedValue(new Error("private database detail"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database detail");
  });
  it("registers GET only at the real API middleware gate", () => {
    expect(apiRouteVerdict("/api/appointments/mine", "GET").kind).toBe("registered");
    expect(apiRouteVerdict("/api/appointments/mine", "POST").kind).toBe("method-not-allowed");
  });
  it("retains middleware deny-by-default for gated roles", () => {
    for (const role of ["cashier", "accountant", "assistant"] as const) {
      expect(restrictedRouteAllowed(role, "/api/appointments/mine", "GET")).toBe(false);
    }
  });
});
describe("clinic calendar date selection", () => {
  it("resolves midnight rollover and tomorrow in clinic timezone, not UTC/browser date", () => {
    const now = new Date("2026-12-31T22:30:00Z");
    expect(resolveScheduleDate("today", now, "Asia/Aden")).toBe("2027-01-01");
    expect(resolveScheduleDate("tomorrow", now, "Asia/Aden")).toBe("2027-01-02");
  });
  it.each(["2026-02-30", "2026-13-01", "2026-1-01", "2026-00-00", "0000-01-01", "bad", ""])("rejects %s", (date) => {
    expect(resolveScheduleDate(date, new Date(), "Asia/Aden")).toBeNull();
  });
  it("accepts leap day without timezone shifting", () => {
    expect(resolveScheduleDate("2028-02-29", new Date(), "Asia/Aden")).toBe("2028-02-29");
  });
});
