import { beforeEach, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), book: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: deps.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: deps.access }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", findUserByUsername: async () => null }));
vi.mock("../lib/book-appointment", () => ({ bookAppointment: deps.book }));
import { POST } from "../app/api/appointments/route";
const body = { patientId: 19, date: "2030-01-20", time: "16:00", appointmentType: "follow_up", doctorId: 7,
  returnBookingSource: { kind: "clinical_case", id: 43 }, returnBookingFingerprint: "a".repeat(64) };
const request = (patch = {}) => new Request("http://localhost/api/appointments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, ...patch }) });
beforeEach(() => {
  vi.clearAllMocks(); deps.session.mockResolvedValue({ userId: 1, username: "reception", role: "reception" }); deps.access.mockResolvedValue(true);
  deps.book.mockResolvedValue({ ok: true, appointment: { id: 9, doctorId: 7, doctorName: "Verified source clinician" }, warning: null });
});
it("forwards exact clinical source and requested doctor, returning persisted clinician", async () => {
  const response = await POST(request());
  expect(response.status).toBe(201);
  expect(await response.json()).toMatchObject({ doctorId: 7, doctorName: "Verified source clinician" });
  expect(deps.book.mock.calls[0][0]).toMatchObject(body);
});
it("refuses inaccessible patient before reading adjustment or booking", async () => {
  deps.access.mockResolvedValue(false);
  expect((await POST(request())).status).toBe(403);
  expect(deps.book).not.toHaveBeenCalled();
});
it("bounds untrusted fingerprint input without allowing opaque extra data", async () => {
  await POST(request({ returnBookingFingerprint: "x".repeat(6000) }));
  expect(deps.book.mock.calls[0][0].returnBookingFingerprint.length).toBe(128);
});
