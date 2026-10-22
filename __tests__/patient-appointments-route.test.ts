import { beforeEach, describe, expect, it, vi } from "vitest";
import { appointment } from "./fixtures/patient-appointments";
const deps = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), read: vi.fn(), user: vi.fn(), owns: vi.fn(), visit: vi.fn(), full: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: deps.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: deps.access }));
vi.mock("@/lib/patient-appointments-reader", () => ({ readPatientAppointments: deps.read }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: deps.user, doctorOwnsPatient: deps.owns, patientHasVisitToday: deps.visit, getPatientFile: deps.full }));
import { GET } from "../app/api/patients/[id]/route";
import { apiRouteVerdict } from "../lib/http-permissions";
import { restrictedRouteAllowed } from "../lib/role-routes";
const get = (id = "31", query = "") => GET(new Request(`http://localhost/api/patients/${id}?projection=appointments${query}`), { params: Promise.resolve({ id }) });
beforeEach(() => { vi.clearAllMocks(); deps.session.mockResolvedValue({ username: "synthetic", role: "doctor" }); deps.access.mockResolvedValue(true); deps.user.mockResolvedValue({ isActive: true, partyId: 5 }); deps.owns.mockResolvedValue(true); deps.visit.mockResolvedValue(true); deps.read.mockResolvedValue({ today: "2026-10-22", appointments: [appointment()], nextCursor: null }); });
describe("patient appointments projection GET", () => {
  it("requires authentication before reading", async () => { deps.session.mockResolvedValue(null); expect((await get()).status).toBe(401); expect(deps.read).not.toHaveBeenCalled(); });
  it.each(["0", "1e2", "1.0", "2147483648"])("rejects invalid patient %s before narrow read", async id => { expect((await get(id)).status).toBe(400); expect(deps.read).not.toHaveBeenCalled(); expect(deps.full).not.toHaveBeenCalled(); });
  it.each(["&view=all", "&limit=10000", "&view=history&view=upcoming", "&cursor=bad", "&projection=appointments", "&scope=all", "&patientId=32"])("rejects invalid/expanded query %s without full-file fallback", async query => { expect((await get("31", query)).status).toBe(400); expect(deps.read).not.toHaveBeenCalled(); expect(deps.full).not.toHaveBeenCalled(); });
  it("rejects unknown projection values without falling back to the full file", async () => {
    const response = await GET(new Request("http://localhost/api/patients/31?projection=unknown"), { params: Promise.resolve({ id: "31" }) });
    expect(response.status).toBe(400); expect(deps.read).not.toHaveBeenCalled(); expect(deps.full).not.toHaveBeenCalled();
  });
  it("runs existing doctor/assistant patient authorization before parsing a projection", async () => {
    deps.owns.mockResolvedValue(false); expect((await get("31", "&view=all")).status).toBe(403); expect(deps.access).not.toHaveBeenCalled();
    deps.session.mockResolvedValue({ username: "synthetic", role: "assistant" }); deps.visit.mockResolvedValue(false);
    expect((await get()).status).toBe(403); expect(deps.read).not.toHaveBeenCalled(); expect(deps.full).not.toHaveBeenCalled();
  });
  it.each(["doctor", "assistant", "cashier", "accountant"])("honors unchanged canAccessPatient denial for %s", async role => { deps.session.mockResolvedValue({ username: "synthetic", role }); deps.access.mockResolvedValue(false); expect((await get()).status).toBe(404); expect(deps.read).not.toHaveBeenCalled(); });
  it.each(["admin", "reception", "doctor", "assistant"])("uses exact patient guard for allowed %s and only grants role-appropriate reminder controls", async role => {
    const session = { username: "synthetic", role }; deps.session.mockResolvedValue(session);
    const response = await get(); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(deps.access).toHaveBeenCalledWith(session, 31); expect(deps.full).not.toHaveBeenCalled();
    expect((await response.json()).canRemind).toBe(role !== "assistant");
  });
  it("keeps the normal patient GET response and full reader unchanged", async () => {
    const full = { patient: { id: 31 }, visits: ["existing"], appointments: ["existing"] }; deps.full.mockResolvedValue(full);
    const response = await GET(new Request("http://localhost/api/patients/31"), { params: Promise.resolve({ id: "31" }) });
    expect(response.status).toBe(200); expect(await response.json()).toEqual(full); expect(deps.full).toHaveBeenCalledWith(31); expect(deps.read).not.toHaveBeenCalled();
  });
  it("continues narrow read when the unrelated full/financial reader fails", async () => {
    deps.full.mockRejectedValue(new Error("Unrelated financial reader unavailable")); expect((await get()).status).toBe(200); expect(deps.full).not.toHaveBeenCalled();
  });
  it("returns missing uniformly and never turns failures into zero records", async () => {
    deps.read.mockResolvedValue(null); expect((await get()).status).toBe(404);
    deps.read.mockRejectedValue(new Error("Synthetic read failure")); expect((await get()).status).toBe(500);
    deps.access.mockRejectedValue(new Error("Synthetic access failure")); expect((await get()).status).toBe(500);
  });
  it("rejects corrupted/mismatched canonical data", async () => {
    deps.read.mockResolvedValue({ today: "2026-10-22", appointments: [{ ...appointment(), patientId: 32 }], nextCursor: null });
    const response = await get(); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("Synthetic patient");
  });
  it("preserves existing proxy read/mutation policy including assistant read but no appointment mutation", () => {
    expect(apiRouteVerdict("/api/patients/31", "GET")).toEqual({ kind: "registered", pattern: "/api/patients/[id]", access: ["admin", "reception", "doctor", "assistant"] });
    expect(restrictedRouteAllowed("assistant", "/api/patients/31", "GET")).toBe(true);
    expect(restrictedRouteAllowed("assistant", "/api/appointments/7", "PATCH")).toBe(false);
    for (const role of ["cashier", "accountant"]) expect(restrictedRouteAllowed(role, "/api/patients/31", "GET")).toBe(false);
  });
});
