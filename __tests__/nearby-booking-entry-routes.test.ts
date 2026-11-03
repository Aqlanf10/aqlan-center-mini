import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), judge: vi.fn(), write: vi.fn(), schedule: vi.fn(), convert: vi.fn(), reschedule: vi.fn(), authorize: vi.fn(), visit: vi.fn(), prepare: vi.fn() }));
vi.mock("../lib/return-booking-context", () => ({ readReturnBookingContext: async () => ({ ok: true, doctorId: 7, doctorName: "Synthetic current owner", fingerprint: "a".repeat(64) }) }));
vi.mock("../lib/session", () => ({ requireSession: deps.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: deps.access }));
vi.mock("../lib/operational-access", () => ({ authorizeAppointment: deps.authorize }));
vi.mock("../lib/waiting-list-booking", () => ({ convertWaitingToAppointment: deps.convert }));
vi.mock("../lib/book-appointment", () => ({ actorCanOverride: () => false, judgeBookingInDay: deps.judge, recordCapacityOverride: vi.fn(), rescheduleAppointment: deps.reschedule }));
vi.mock("../lib/capacity-context", () => ({ loadCapacityContext: async () => ({ chairs: 3 }), resolveService: async () => null }));
vi.mock("../lib/db", () => ({
  ensureSchema: async () => {}, findUserByUsername: async () => null,
  getPool: () => ({ query: async () => ({ rows: [{ patient_id: 19 }] }) }),
  getClinicalVisit: deps.visit, prepareNextSessionPatient: deps.prepare, existingPatientForBookingRequest: async () => 19,
  getWaitingEntry: async () => ({ id: 8, patientId: 19 }),
  writeAppointmentInDay: deps.write, schedulePlannedVisit: deps.schedule,
}));
import { POST as schedule } from "../app/api/planned-visits/[id]/schedule/route";
import { POST as next } from "../app/api/visits/[id]/next/route";
import { PATCH as approval } from "../app/api/booking-requests/[id]/route";
import { PATCH as waiting } from "../app/api/waiting-list/[id]/route";
import { PATCH as move } from "../app/api/appointments/[id]/route";
const conflict = { kind: "nearby_patient_appointments", message: "Synthetic existing appointment", confirmationToken: "signed-token", nearbyAppointments: [{ id: 4, scheduledDate: "2026-12-24", scheduledTime: "16:00", doctorName: "Synthetic doctor" }] };
const payload = { date: "2026-12-23", time: "16:00", nearbyAppointmentConfirmation: "signed-token", reason: "Synthetic reason", returnBookingFingerprint: "a".repeat(64) };
const request = (body = payload) => new Request("http://localhost/api/synthetic", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const context = { params: Promise.resolve({ id: "8" }) };
beforeEach(() => {
  vi.clearAllMocks(); deps.visit.mockResolvedValue({ patientId: 19 }); deps.prepare.mockResolvedValue(19); deps.session.mockResolvedValue({ username: "synthetic-reception", userId: 71, role: "reception" }); deps.access.mockResolvedValue(true); deps.authorize.mockResolvedValue({ ok: true, patientId: 19 });
  deps.judge.mockResolvedValue({ ok: false, conflict });
  deps.write.mockImplementation(async ({ judge }) => judge([], {}));
  deps.schedule.mockImplementation(async ({ judge }) => ({ ...await judge([], {}, 30), reason: "conflict" }));
  deps.convert.mockResolvedValue({ ok: false, status: 409, message: conflict.message, conflict });
  deps.reschedule.mockResolvedValue({ ok: false, status: 409, message: conflict.message, conflict });
});
it.each([
  ["planned schedule", schedule, payload, JSON.stringify({ entry: "planned-schedule", plannedVisitId: 8, source: { kind: "planned_visit", id: 8 }, fingerprint: "a".repeat(64) })],
  ["next visit", next, payload, JSON.stringify({ entry: "next-visit", visitId: 8, phone: null, note: null, source: { kind: "visit", id: 8 }, fingerprint: "a".repeat(64) })],
  ["booking approval", approval, { ...payload, action: "confirm" }, "booking-request:8"],
] as const)("%s binds token to server actor and resource; preserves flattened conflict", async (_, handler, body, scope) => {
  const response = await handler(request(body), context);
  expect(response.status).toBe(409); expect(await response.json()).toEqual(conflict);
  expect(deps.judge).toHaveBeenCalledWith(expect.objectContaining({ patientId: 19, bookingActor: "71:synthetic-reception", bookingScope: scope, nearbyAppointmentConfirmation: "signed-token" }));
});
it.each([
  ["waiting conversion", waiting, deps.convert, "book"],
  ["reschedule", move, deps.reschedule, "reschedule"],
] as const)("%s passes token and retains nested conflict", async (_, handler, writer, action) => {
  const response = await handler(request({ ...payload, action } as typeof payload), context);
  expect(response.status).toBe(409); expect(await response.json()).toEqual({ message: conflict.message, conflict });
  expect(writer.mock.calls[0][0].nearbyAppointmentConfirmation).toBe("signed-token");
  expect(writer.mock.calls[0][1].username).toBe("synthetic-reception");
  expect(writer.mock.calls[0][1].userId).toBe(71);
});
it.each([schedule, next, approval, waiting, move])("anonymous calls cannot obtain nearby appointment details", async handler => {
  deps.session.mockResolvedValue(null);
  expect((await handler(request(), context)).status).toBe(401);
  expect(deps.judge).not.toHaveBeenCalled(); expect(deps.convert).not.toHaveBeenCalled(); expect(deps.reschedule).not.toHaveBeenCalled();
});
it.each([[schedule, 403], [next, 403], [waiting, 404]] as const)("inaccessible patient is refused before the warning query", async (handler, status) => {
  deps.access.mockResolvedValue(false);
  expect((await handler(request(), context)).status).toBe(status);
  expect(deps.judge).not.toHaveBeenCalled(); expect(deps.convert).not.toHaveBeenCalled();
});

it("resolves a walk-in patient under the booking transaction before warning", async () => {
  deps.visit.mockResolvedValue({ patientId: null }); deps.prepare.mockResolvedValue(19);
  const response = await next(request(), context);
  expect(response.status).toBe(409);
  expect(deps.prepare).toHaveBeenCalledWith({}, { visitId: 8, phone: null });
  expect(deps.access).toHaveBeenCalledWith(expect.objectContaining({ userId: 71 }), 19, undefined, {}, "nowait");
  expect(deps.judge).toHaveBeenCalledWith(expect.objectContaining({ patientId: 19 }));
});
it("never reveals appointments for an inaccessible resolved walk-in patient", async () => {
  deps.visit.mockResolvedValue({ patientId: null }); deps.prepare.mockResolvedValue(19); deps.access.mockResolvedValue(false);
  const response = await next(request(), context);
  expect(response.status).toBe(403);
  expect(await response.json()).not.toHaveProperty("nearbyAppointments");
  expect(deps.judge).not.toHaveBeenCalled();
});
it("fails closed when the visit disappears before locked patient resolution", async () => {
  deps.prepare.mockResolvedValue(null);
  const response = await next(request(), context);
  expect(response.status).toBe(404);
  expect(deps.judge).not.toHaveBeenCalled();
});

it("returns a detail-free retry when patient ownership witnesses are locked", async () => {
  deps.visit.mockResolvedValue({ patientId: null });
  deps.access.mockRejectedValueOnce(Object.assign(new Error("Synthetic lock unavailable"), { code: "55P03" }));
  const response = await next(request(), context);
  expect(response.status).toBe(409);
  const body = await response.json();
  expect(body.message).toContain("أعد المحاولة");
  expect(body).not.toHaveProperty("nearbyAppointments");
  expect(deps.judge).not.toHaveBeenCalled();
});
