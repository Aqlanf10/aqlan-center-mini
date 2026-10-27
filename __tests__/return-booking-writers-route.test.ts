import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), judge: vi.fn(), write: vi.fn(), schedule: vi.fn(), resolve: vi.fn(), create: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: deps.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: deps.access }));
vi.mock("../lib/return-booking-context", () => ({ readReturnBookingContext: deps.resolve }));
vi.mock("../lib/book-appointment", () => ({ actorCanOverride: () => false, judgeBookingInDay: deps.judge, recordCapacityOverride: vi.fn() }));
vi.mock("../lib/capacity-context", () => ({ loadCapacityContext: async () => ({ chairs: 3 }), resolveService: async () => null }));
vi.mock("../lib/db", () => ({
  ensureSchema: async () => {}, findUserByUsername: async () => null,
  getPool: () => ({ query: async () => ({ rows: [{ patient_id: 19 }] }) }),
  getClinicalVisit: async () => ({ patientId: 19 }), prepareNextSessionPatient: async () => 19,
  writeAppointmentInDay: deps.write, schedulePlannedVisit: deps.schedule, createNextSession: deps.create,
  existingPatientForBookingRequest: async () => 19, confirmBookingRequest: deps.create,
}));
import { POST as schedule } from "../app/api/planned-visits/[id]/schedule/route";
import { POST as next } from "../app/api/visits/[id]/next/route";
import { PATCH as approval } from "../app/api/booking-requests/[id]/route";
const payload = { date: "2030-01-20", time: "16:00", durationMinutes: 15, returnBookingFingerprint: "a".repeat(64) };
const request = (body = payload) => new Request("http://localhost/api/synthetic", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const context = { params: Promise.resolve({ id: "8" }) };
const resolved = { ok: true, patientId: 19, doctorId: 7, doctorName: "Current owner", fingerprint: "a".repeat(64), clinicalCaseId: 23, orthoCaseId: null };
beforeEach(() => {
  vi.clearAllMocks(); deps.session.mockResolvedValue({ username: "reception", userId: 71, role: "reception" }); deps.access.mockResolvedValue(true);
  deps.resolve.mockResolvedValue(resolved); deps.judge.mockResolvedValue({ ok: true, overridden: false }); deps.create.mockResolvedValue({ appointmentId: 42 });
  deps.write.mockImplementation(async ({ judge, commit }) => { const result = await judge([], {}); return result.ok ? { ok: true, value: await commit({}) } : result; });
  deps.schedule.mockImplementation(async ({ judge }) => { const result = await judge([], {}, 15); return result.ok ? { ok: true, appointmentId: 42, title: "Return" } : { ok: false, reason: "conflict", conflict: result.conflict }; });
});
it.each([["next", next, "visit"], ["planned", schedule, "planned_visit"]] as const)("%s resolves exact origin and judges the CURRENT responsible doctor", async (_, handler, kind) => {
  expect((await handler(request(), context)).status).toBe(201);
  expect(deps.resolve).toHaveBeenCalledWith({}, 19, { kind, id: 8 }, expect.objectContaining({ lock: true }));
  expect(deps.judge).toHaveBeenCalledWith(expect.objectContaining({ providerId: 7, requireAssignedProvider: true }));
});
it("next-session persistence receives the resolved doctor rather than actor or no doctor", async () => {
  await next(request({ ...payload, doctorId: 999 } as typeof payload), context);
  expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ doctorId: 7 }), {});
});
it.each([next, schedule])("missing current owner blocks without capacity or insertion", async handler => {
  deps.resolve.mockResolvedValue({ ok: false, code: "responsibility_missing", message: "حدد المسؤول من الإعدادات" });
  const response = await handler(request(), context);
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "responsibility_missing" });
  expect(deps.judge).not.toHaveBeenCalled(); expect(deps.create).not.toHaveBeenCalled();
});
it.each([next, schedule])("changed preview responsibility blocks rather than silently switching clinician", async handler => {
  const response = await handler(request({ ...payload, returnBookingFingerprint: "b".repeat(64) } as typeof payload), context);
  expect(response.status).toBe(409); expect(deps.judge).not.toHaveBeenCalled();
});
it.each([[next, "visit"], [schedule, "planned_visit"]] as const)("selected case must be verified against the intrinsic origin", async (handler, kind) => {
  await handler(request({ ...payload, returnBookingSource: { kind: "clinical_case", id: 23 }, returnBookingFingerprint: resolved.fingerprint } as typeof payload), context);
  expect(deps.resolve).toHaveBeenCalledWith({}, 19, { kind: "clinical_case", id: 23 }, { lock: true, origin: { kind, id: 8 } });
});
it.each([next, schedule])("does not accept malformed or expanded clinical provenance", async handler => {
  const response = await handler(request({ ...payload, returnBookingSource: { kind: "clinical_case", id: 23, doctorId: 999 } } as typeof payload), context);
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(deps.resolve).not.toHaveBeenCalled(); expect(deps.judge).not.toHaveBeenCalled();
});

it.each([next, schedule])("never silently applies a current owner without a reviewed preview", async handler => {
  const response = await handler(request({ ...payload, returnBookingFingerprint: undefined } as unknown as typeof payload), context);
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "return_booking_context_required" });
  expect(deps.resolve).not.toHaveBeenCalled(); expect(deps.judge).not.toHaveBeenCalled();
});

it("authenticated follow-up approval uses current case owner and verifies patient at commit", async () => {
  const response = await approval(request({ ...payload, action: "confirm", appointmentType: "follow_up", returnBookingSource: { kind: "clinical_case", id: 23 } } as typeof payload), context);
  expect(response.status).toBe(201);
  expect(deps.create).toHaveBeenCalledWith(expect.objectContaining({ doctorId: 7, expectedPatientId: 19 }), {});
  expect(deps.judge).toHaveBeenCalledWith(expect.objectContaining({ providerId: 7, requireAssignedProvider: true }));
});
it("follow-up approval cannot guess a doctor without exact context", async () => {
  const response = await approval(request({ ...payload, action: "confirm", appointmentType: "follow_up" } as typeof payload), context);
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "return_booking_context_required" });
  expect(deps.judge).not.toHaveBeenCalled(); expect(deps.create).not.toHaveBeenCalled();
});
it("ordinary anonymous-origin booking approval is unchanged and does not query clinical details", async () => {
  const response = await approval(request({ ...payload, action: "confirm" } as typeof payload), context);
  expect(response.status).toBe(201); expect(deps.resolve).not.toHaveBeenCalled();
});
