import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), found: vi.fn(), write: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", getOrthoCase: mocks.found, recordAdjustment: mocks.write }));
import { POST } from "../app/api/ortho/[id]/route";
const actor = { userId: 7, username: "synthetic-admin", role: "admin", expiresAt: 4_102_444_800_000 };
const key = "synthetic-adjustment-request-001";
const context = { params: Promise.resolve({ id: "41" }) };
const call = (requestKey: string | null = key, extra: Record<string, unknown> = {}) => POST(new Request("https://synthetic.invalid/api/ortho/41", {
  method: "POST", headers: { "Content-Type": "application/json", ...(requestKey === null ? {} : { "Idempotency-Key": requestKey }) },
  body: JSON.stringify({ doneOn: "2026-10-02", done: "Synthetic adjustment", nextWeeks: 4, ...extra }),
}), context);
beforeEach(() => {
  vi.resetAllMocks(); mocks.session.mockResolvedValue(actor); mocks.access.mockResolvedValue(true);
  mocks.found.mockResolvedValue({ id: 41, patientId: 101 });
  mocks.write.mockResolvedValue({ ok: true, id: 501, created: true, visitId: null, attachedToToday: false });
});
describe("orthodontic HTTP adjustment command contract", () => {
  it.each([null, "", "short", "key with spaces", "x".repeat(129)])("refuses absent or malformed key %j before writing", async requestKey => {
    const response = await call(requestKey);
    expect(response.status).toBe(400); expect(await response.json()).toMatchObject({ code: "ADJUSTMENT_REQUEST_KEY_REQUIRED" });
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("binds the key to server session and case patient rather than supplied authority", async () => {
    const response = await call(key, { patientId: 999, caseId: 999, actor: "forged", request: { key: "forged-key", session: {} } });
    expect(response.status).toBe(201);
    expect(mocks.write).toHaveBeenCalledWith(expect.objectContaining({ caseId: 41, recordedBy: actor.username,
      request: { key, patientId: 101, session: actor, newTextAdmissionError: null, newEnumAdmissionError: null, newVisitAdmissionError: null, omittedDateForReplay: false, newDateAdmissionError: null, newIntervalAdmissionError: null } }));
    expect(await response.json()).toEqual({ id: 501, patientId: 101, caseId: 41, requestKey: key, visitId: null, attachedToToday: false });
  });
  it("returns the exact replay receipt without a second new-success status", async () => {
    mocks.write.mockResolvedValue({ ok: true, id: 501, created: false, visitId: null, attachedToToday: false, replayed: true });
    const response = await call(); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 501, caseId: 41, patientId: 101, requestKey: key, existing: true, replayed: true });
  });
  it.each([401, 403, 409])("preserves transaction refusal %s without claiming success", async status => {
    mocks.write.mockResolvedValue({ ok: false, status, code: "synthetic_refusal", message: "Synthetic refusal" });
    const response = await call(); expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code: "synthetic_refusal", message: "Synthetic refusal" });
  });
  it("does not use a valid key as authorization to read or replay another patient's result", async () => {
    mocks.access.mockResolvedValue(false); expect((await call()).status).toBe(403); expect(mocks.write).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue(null); expect((await call()).status).toBe(401); expect(mocks.write).not.toHaveBeenCalled();
  });
});
