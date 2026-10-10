import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ session: { username: "desk", role: "reception" } as { username: string; role: string } | null,
  authorize: vi.fn(), see: vi.fn(), complete: vi.fn(), handoff: vi.fn(), walkout: vi.fn(), owner: vi.fn(), summary: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: async () => state.session }));
vi.mock("../lib/operational-access", () => ({ authorizeVisit: state.authorize }));
vi.mock("../lib/walkout-access", () => ({ canSeeWalkout: state.see }));
vi.mock("../lib/reception-handoff-db", () => ({ completeReceptionHandoff: state.complete, readReceptionHandoff: state.handoff,
  isHandoffSignature: (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", visitWalkout: state.walkout, getVisitOwner: state.owner }));
vi.mock("../lib/checkout-db", () => ({ visitCheckoutSummary: state.summary }));
const { POST } = await import("../app/api/visits/[id]/reception-handoff/route");
const { GET } = await import("../app/api/visits/[id]/walkout/route");
const signedAt = "2026-10-10T09:00:00.000Z";
const payload = { patientId: 7, signedAt, reason: "موعد متابعة للتحصيل" };
const post = (body: unknown = payload, id = "41", extraHeaders: Record<string, string> = {}) => POST(
  new Request(`http://localhost/api/visits/${id}/reception-handoff`, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...extraHeaders } }), { params: Promise.resolve({ id }) });
const get = () => GET(new Request("http://localhost/api/visits/41/walkout"), { params: Promise.resolve({ id: "41" }) });
beforeEach(() => {
  vi.clearAllMocks();
  state.session = { username: "desk", role: "reception" };
  state.authorize.mockReset().mockResolvedValue({ ok: true, patientId: 7 });
  state.see.mockReset().mockResolvedValue(true);
  state.complete.mockReset().mockResolvedValue({ ok: true, visitId: 41, patientId: 7, signedAt, status: "handled", handledReason: payload.reason });
  state.handoff.mockReset().mockResolvedValue({ status: "handled", handledReason: payload.reason });
  state.walkout.mockReset().mockResolvedValue({ visitId: 41, patientId: 7, signedAt });
  state.owner.mockResolvedValue({ found: true, patientId: 7 });
  state.summary.mockResolvedValue({});
});

describe("POST exact reception handoff completion", () => {
  it.each(["reception", "admin"])("accepts %s and uses only authenticated actor identity", async role => {
    state.session = { username: "trusted-user", role };
    const response = await post();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ visitId: 41, patientId: 7, signedAt, status: "handled", handledReason: payload.reason });
    expect(state.authorize).toHaveBeenCalledWith(state.session, 41);
    expect(state.see).toHaveBeenCalledWith(state.session, 7);
    expect(state.complete).toHaveBeenCalledWith({ ...payload, visitId: 41 }, { actor: "trusted-user", actorRole: role });
  });
  it.each(["doctor", "assistant", "cashier", "accountant", "unknown"])("denies %s before looking up a visit", async role => {
    state.session = { username: "spoof", role };
    expect((await post({ ...payload, actorRole: "admin" })).status).toBe(403);
    expect(state.authorize).not.toHaveBeenCalled();
    expect(state.complete).not.toHaveBeenCalled();
  });
  it("rejects an expired session and inaccessible visit", async () => {
    state.session = null;
    expect((await post()).status).toBe(401);
    state.session = { username: "desk", role: "reception" };
    state.authorize.mockResolvedValue({ ok: false, status: 404, message: "الزيارة غير موجودة." });
    expect((await post()).status).toBe(404);
    expect(state.complete).not.toHaveBeenCalled();
  });
  it("enforces canonical walkout authorization", async () => {
    state.see.mockResolvedValue(false);
    expect((await post()).status).toBe(403);
    expect(state.complete).not.toHaveBeenCalled();
  });
  it("rejects cross-patient and unlinked spoofed targets", async () => {
    expect((await post({ ...payload, patientId: 8 })).status).toBe(409);
    state.authorize.mockResolvedValue({ ok: true, patientId: null });
    expect((await post()).status).toBe(409);
    expect(state.complete).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { ...payload, reason: "  " }, { ...payload, reason: "ab" }, { ...payload, reason: "a".repeat(301) },
    { ...payload, signedAt: "bad" }, { ...payload, patientId: "7" }, { ...payload, actor: "admin" },
    { ...payload, action: "paid" }, { ...payload, status: "collected" }])("rejects invalid/spoofed payload %j", async body => {
    expect((await post(body)).status).toBe(400);
    expect(state.complete).not.toHaveBeenCalled();
  });
  it.each(["-1", "0", "1.2", "1e2", "9007199254740992", "wrong"])("rejects visit id %s", async id => {
    expect((await post(payload, id)).status).toBe(400);
    expect(state.complete).not.toHaveBeenCalled();
  });
  it("uses the bounded body reader and reports malformed JSON", async () => {
    expect((await post(payload, "41", { "content-length": "999999999" })).status).toBe(413);
    const response = await POST(new Request("http://localhost/api/visits/41/reception-handoff", { method: "POST", body: "{" }), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(400);
    expect(state.complete).not.toHaveBeenCalled();
  });
  it.each([["stale", 409], ["not_signed", 409], ["not_found", 404], ["forbidden", 403], ["invalid", 400]])("maps %s to a safe response", async (reason, status) => {
    state.complete.mockResolvedValue({ ok: false, reason });
    expect((await post()).status).toBe(status);
  });
  it("does not acknowledge an audit failure or expose database details", async () => {
    state.complete.mockRejectedValue(new Error("private database credentials"));
    const response = await post();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private database credentials");
  });
});

describe("walkout includes durable front-desk status", () => {
  it("reuses canonical walkout and includes status with private no-store", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await response.json()).receptionHandoff).toEqual({ status: "handled", handledReason: payload.reason });
    expect(state.handoff).toHaveBeenCalledWith(41, { visitId: 41, patientId: 7, signedAt });
  });
  it("does not expose the action to doctors with existing financial read permission", async () => {
    state.session = { username: "doctor", role: "doctor" };
    expect((await (await get()).json()).receptionHandoff).toBeUndefined();
    expect(state.handoff).not.toHaveBeenCalled();
  });
  it("omits completion for unsigned or concurrently changed identity", async () => {
    state.walkout.mockResolvedValue({ visitId: 41, patientId: 7, signedAt: null });
    expect((await (await get()).json()).receptionHandoff).toBeUndefined();
    expect(state.handoff).not.toHaveBeenCalled();
    state.walkout.mockResolvedValue({ visitId: 41, patientId: 7, signedAt });
    state.handoff.mockResolvedValue(null);
    expect((await (await get()).json()).receptionHandoff).toBeUndefined();
  });
  it("fails closed rather than showing a false pending state on audit read failure", async () => {
    state.handoff.mockRejectedValue(new Error("private audit details"));
    expect((await get()).status).toBe(500);
  });
});
