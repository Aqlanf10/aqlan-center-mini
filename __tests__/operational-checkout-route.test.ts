import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ session: { username: "desk", role: "reception" } as { username: string; role: string } | null,
  authorize: vi.fn(), see: vi.fn(), read: vi.fn(), decide: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: async () => state.session }));
vi.mock("../lib/operational-access", () => ({ authorizeVisit: state.authorize }));
vi.mock("../lib/walkout-access", () => ({ canSeeWalkout: state.see }));
vi.mock("../lib/operational-checkout-db", () => ({ readOperationalHandoff: state.read, decideOperationalHandoff: state.decide }));
const { GET, POST } = await import("../app/api/visits/[id]/operational-checkout/route");
const version = "finished:2026-10-10T09:00:00.123456Z";
const body = { patientId: 7, finishVersion: version, receivable: null, status: "handled", reason: "خروج دون فاتورة جديدة" };
const context = (id = "41") => ({ params: Promise.resolve({ id }) });
const get = (id = "41") => GET(new Request(`http://localhost/api/visits/${id}/operational-checkout`), context(id));
const post = (value: unknown = body) => POST(new Request("http://localhost/api/visits/41/operational-checkout", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
}), context());
beforeEach(() => {
  vi.clearAllMocks(); state.session = { username: "desk", role: "reception" };
  state.authorize.mockResolvedValue({ ok: true, patientId: 7 }); state.see.mockResolvedValue(true);
  state.read.mockResolvedValue({ version: 1, item: { visitId: 41, patientId: 7 }, receivable: null });
  state.decide.mockResolvedValue({ ok: true, item: { visitId: 41, status: "handled" } });
});
describe("versioned operational checkout authority and mutation contract", () => {
  it.each(["doctor", "assistant", "cashier", "accountant", "patient"])("denies %s before any patient or financial read", async role => {
    state.session = { username: role, role };
    expect((await get()).status).toBe(403); expect((await post()).status).toBe(403);
    expect(state.authorize).not.toHaveBeenCalled(); expect(state.read).not.toHaveBeenCalled(); expect(state.decide).not.toHaveBeenCalled();
  });
  it("requires session and exact resource ownership before reading or recording", async () => {
    state.session = null; expect((await get()).status).toBe(401); expect((await post()).status).toBe(401);
    state.session = { username: "desk", role: "admin" };
    for (const id of ["0", "-1", "1.5", "01", "9007199254740992"]) expect((await get(id)).status).toBe(400);
    state.authorize.mockResolvedValue({ ok: false, status: 404, message: "غير موجود" }); expect((await get()).status).toBe(404);
    state.authorize.mockResolvedValue({ ok: true, patientId: null }); expect((await get()).status).toBe(403);
    state.authorize.mockResolvedValue({ ok: true, patientId: 8 }); expect((await post()).status).toBe(409);
    expect(state.decide).not.toHaveBeenCalled();
  });
  it("requires a bounded typed version/decision and canonical receivable proof, not a client signature", async () => {
    for (const value of [{ ...body, signedAt: "2026-10-10T09:00:00Z" }, { ...body, finishVersion: "2026-10-10" },
      { ...body, patientId: "7" }, { ...body, reason: "a" }, { ...body, reason: "x".repeat(301) },
      { ...body, status: "collected" }, { ...body, receivable: undefined }, { ...body, receivable: { invoiceId: 8, currency: ["YER"] } }]) {
      expect((await post(value)).status).toBe(400);
    }
    expect(state.decide).not.toHaveBeenCalled();
    const response = await post(); expect(response.status).toBe(200);
    expect(state.decide).toHaveBeenCalledWith({ visitId: 41, ...body }, { actor: "desk", actorRole: "reception" });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("keeps late signing, changed proof and failed reads explicit rather than financial zero", async () => {
    const response = await get(); expect((await response.json()).owner).toEqual(state.session);
    state.read.mockResolvedValue(null); expect((await get()).status).toBe(409);
    state.decide.mockResolvedValue({ ok: false, reason: "stale" }); expect((await post()).status).toBe(409);
    state.read.mockRejectedValue(new Error("private diagnostic"));
    const failed = await get(); expect(failed.status).toBe(500); expect(await failed.text()).not.toContain("private diagnostic");
    state.decide.mockRejectedValue(new Error("private diagnostic")); expect((await post()).status).toBe(500);
  });
});
