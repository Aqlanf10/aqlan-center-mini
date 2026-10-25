import { beforeEach, describe, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ session: vi.fn(), user: vi.fn(), doctor: vi.fn(), appointments: vi.fn(),
  context: vi.fn(), service: vi.fn(), blocks: vi.fn(), roster: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: deps.session }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: deps.user, getParty: deps.doctor, listAppointmentsByDate: deps.appointments }));
vi.mock("../lib/doctor-availability-advisory", () => ({ readDoctorAvailabilityAdvisory: deps.roster }));
vi.mock("../lib/capacity-context", () => ({ loadCapacityContext: deps.context, resolveService: deps.service, loadProviderBlockWindows: deps.blocks,
  FALLBACK_SERVICE: { requiresProvider: false, requiresChair: true, allowsConcurrentProviderWork: false, consumesEmergencyReserve: false, isActive: true, nameAr: "عام" } }));
import { GET } from "../app/api/appointments/availability/route";
const request = () => new Request("http://localhost/api/appointments/availability?doctorId=7&date=2030-04-08&durationMinutes=30");
beforeEach(() => {
  vi.resetAllMocks(); deps.session.mockResolvedValue({ username: "synthetic", role: "reception" });
  deps.user.mockResolvedValue({ partyId: 7 }); deps.doctor.mockResolvedValue({ id: 7, kind: "doctor", isActive: true });
  deps.appointments.mockResolvedValue([]); deps.blocks.mockResolvedValue([]); deps.service.mockResolvedValue(null);
  deps.context.mockResolvedValue({ shifts: [{ start: "09:00", end: "15:00" }], chairs: 2, nearCapacityPercent: 80, emergencyReserveMinutes: 0, newPatientDailyLimit: 0 });
  deps.roster.mockResolvedValue({ resolved: true, reason: null, windows: [{ start: 660, end: 780 }], staffId: 999, leaveId: 888, privateName: "Private HR name" });
});
describe("authenticated duty-aware advisory endpoint", () => {
  it("returns only qualified sanitized suggestions, not HR identifiers or a booking guarantee", async () => {
    const response = await GET(request()), body = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(body).toMatchObject({ purpose: "advisory_only", bookingGuaranteed: false, rosterStatus: "resolved", timeZone: "Asia/Aden" });
    expect(body.slots.find((slot: { time: string }) => slot.time === "12:00")).toMatchObject({ status: "available", label: "مقترح" });
    expect(body.slots.find((slot: { time: string }) => slot.time === "09:00")).toMatchObject({ status: "unavailable" });
    expect(Object.keys(body).sort()).toEqual(["bookingGuaranteed", "date", "doctorId", "durationMinutes", "purpose", "rosterStatus", "slots", "timeZone"]);
    expect(body.slots.every((slot: Record<string, unknown>) => Object.keys(slot).sort().join(",") === "label,status,time")).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/staffId|leaveId|Private HR|windows|reason|sourceSchedule/);
    expect(deps.roster).toHaveBeenCalledExactlyOnceWith(7, "2030-04-08", "Asia/Aden");
  });
  it.each(["missing_mapping", "missing_schedule", "ambiguous_schedule", "schema_unavailable", "unsupported_partial_leave"])("exposes %s only as unknown", async reason => {
    deps.roster.mockResolvedValue({ resolved: false, reason, windows: [] });
    expect(await (await GET(request())).json()).toMatchObject({ rosterStatus: "unknown", slots: [], bookingGuaranteed: false });
    expect(JSON.stringify(await (await GET(request())).json())).not.toContain(reason);
  });
  it("does not turn a roster read failure into a successful available response", async () => {
    deps.roster.mockRejectedValue(new Error("Private database error"));
    const response = await GET(request()); expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("Private");
  });
  it.each(["cashier", "accountant", "assistant"])("denies %s before any roster read", async role => {
    deps.session.mockResolvedValue({ username: "synthetic", role });
    expect((await GET(request())).status).toBe(403); expect(deps.roster).not.toHaveBeenCalled();
  });
  it("keeps self-doctor scope and anonymous denial", async () => {
    deps.session.mockResolvedValue({ username: "synthetic", role: "doctor" });
    deps.user.mockResolvedValue({ partyId: 8 });
    expect((await GET(request())).status).toBe(403); expect(deps.roster).not.toHaveBeenCalled();
    deps.user.mockResolvedValue({ partyId: 7 }); expect((await GET(request())).status).toBe(200);
    deps.session.mockResolvedValue(null); expect((await GET(request())).status).toBe(401);
  });
});
