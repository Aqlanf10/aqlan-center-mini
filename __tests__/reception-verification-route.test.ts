import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ session: { username: "desk", role: "reception" } as { username: string; role: string } | null,
  authorize: vi.fn(), see: vi.fn(), read: vi.fn(), verify: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: async () => state.session }));
vi.mock("../lib/operational-access", () => ({ authorizeVisit: state.authorize }));
vi.mock("../lib/walkout-access", () => ({ canSeeWalkout: state.see }));
vi.mock("../lib/operational-checkout-db", () => ({ readSignedReceptionVerification: state.read, verifySignedReception: state.verify }));
vi.mock("../lib/reception-handoff-db", () => ({ isHandoffSignature: (value: unknown) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) }));
const { GET, POST } = await import("../app/api/visits/[id]/reception-verification/route");
const signedAt = "2026-10-10T09:00:00.000Z", body = { patientId: 7, signedAt, reason: "مراجعة اصطناعية حالية", receivable: null };
const context = { params: Promise.resolve({ id: "41" }) };
const get = () => GET(new Request("http://localhost/api/visits/41/reception-verification"), context);
const post = (value: unknown = body) => POST(new Request("http://localhost/api/visits/41/reception-verification", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
}), context);
beforeEach(() => {
  vi.clearAllMocks(); state.session = { username: "desk", role: "reception" };
  state.authorize.mockResolvedValue({ ok: true, patientId: 7 }); state.see.mockResolvedValue(true);
  state.read.mockResolvedValue({ visitId: 41, patientId: 7, signedAt, receivable: null });
  state.verify.mockResolvedValue({ ok: true, visitId: 41, patientId: 7, signedAt });
});
it.each(["doctor", "assistant", "cashier", "accountant"])("denies %s before financial access or verification audit", async role => {
  state.session = { username: role, role };
  expect((await get()).status).toBe(403); expect((await post()).status).toBe(403);
  expect(state.authorize).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled(); expect(state.verify).not.toHaveBeenCalled();
});
it("binds a private verification read/write to the exact patient and signature without changing handled/deferred status", async () => {
  const response = await get(); expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toMatchObject({ version: 1, owner: state.session, visitId: 41, patientId: 7, signedAt });
  expect((await post()).status).toBe(200);
  expect(state.verify).toHaveBeenCalledWith({ visitId: 41, ...body }, { actor: "desk", actorRole: "reception" });
  expect((await post({ ...body, patientId: 8 })).status).toBe(409);
  expect((await post({ ...body, status: "collected" })).status).toBe(400);
  expect((await post({ ...body, receivable: undefined })).status).toBe(400);
  expect((await post({ ...body, reason: "x".repeat(301) })).status).toBe(400);
});
it("keeps missing ownership, stale proof and unavailable data explicit", async () => {
  state.read.mockResolvedValue(null); expect((await get()).status).toBe(409);
  state.verify.mockResolvedValue({ ok: false, reason: "stale" }); expect((await post()).status).toBe(409);
  state.authorize.mockResolvedValue({ ok: false, status: 404, message: "غير موجود" }); expect((await get()).status).toBe(404);
  state.session = null; expect((await get()).status).toBe(401); expect((await post()).status).toBe(401);
});
