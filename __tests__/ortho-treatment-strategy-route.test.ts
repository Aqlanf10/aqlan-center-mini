import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ session: vi.fn(), guard: vi.fn(), getCase: vi.fn(), read: vi.fn(), append: vi.fn() }));
vi.mock("../lib/session", () => ({ requireSession: mock.session }));
vi.mock("../lib/case-route", () => ({ guardPatient: mock.guard }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", getOrthoCase: mock.getCase }));
vi.mock("../lib/ortho-treatment-strategy-store", () => ({ getOrthoTreatmentStrategy: mock.read, appendOrthoTreatmentStrategy: mock.append }));
import { GET, POST } from "../app/api/ortho/[id]/strategy/route";

const session = { username: "synthetic-doctor", userId: 9, role: "doctor", expiresAt: 9999999999999 };
const context = (id = "7") => ({ params: Promise.resolve({ id }) });
const request = (body: unknown) => new Request("https://synthetic.invalid/api/ortho/7/strategy", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  vi.clearAllMocks(); mock.session.mockResolvedValue(session);
  mock.guard.mockResolvedValue({ ok: true, session }); mock.getCase.mockResolvedValue({ id: 7, patientId: 4 });
  mock.read.mockResolvedValue({ ok: true, state: "ready", history: [], revision: null });
  mock.append.mockResolvedValue({ ok: true, replayed: false, revision: { revisionId: 12 } });
});

describe("case strategy route admission and exact history", () => {
  it("authenticates before looking up any case", async () => {
    mock.session.mockResolvedValue(null);
    expect((await GET(new Request("https://synthetic.invalid/api/ortho/7/strategy"), context())).status).toBe(401);
    expect(mock.getCase).not.toHaveBeenCalled(); expect(mock.read).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "1e3", "1.5", "9007199254740992"])("rejects noncanonical case ID %s", async id => {
    expect((await POST(request({}), context(id))).status).toBe(400);
    expect(mock.getCase).not.toHaveBeenCalled(); expect(mock.append).not.toHaveBeenCalled();
  });
  it("uses canonical case ownership rather than any client patient or case value", async () => {
    const command = { patientId: 999, orthoCaseId: 999, unexpected: "must reach strict store validation" };
    await POST(request(command), context());
    expect(mock.guard).toHaveBeenCalledWith(4, true);
    expect(mock.append).toHaveBeenCalledWith({ session, patientId: 4, orthoCaseId: 7, command });
  });
  it("passes exact selected revision without falling back to the latest", async () => {
    mock.read.mockResolvedValue({ ok: false, status: 404, code: "revision_not_found", message: "غير متاحة" });
    const response = await GET(new Request("https://synthetic.invalid/api/ortho/7/strategy?revisionId=12"), context());
    expect(response.status).toBe(404);
    expect(mock.read).toHaveBeenCalledWith({ session, patientId: 4, orthoCaseId: 7, revisionId: 12 });
    expect(mock.append).not.toHaveBeenCalled();
  });
  it.each(["revisionId=", "revisionId=NaN", "revisionId=1&revisionId=2", "patientId=4"])("rejects ambiguous query %s", async query => {
    expect((await GET(new Request(`https://synthetic.invalid/api/ortho/7/strategy?${query}`), context())).status).toBe(400);
    expect(mock.read).not.toHaveBeenCalled();
  });
  it("does not turn a read failure into empty successful history", async () => {
    mock.read.mockRejectedValue(new Error("fixture read failure"));
    const response = await GET(new Request("https://synthetic.invalid/api/ortho/7/strategy"), context());
    expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ code: "strategy_read_failed" });
  });
  it("returns guard rejection without parsing/writing the document", async () => {
    mock.guard.mockResolvedValue({ ok: false, response: new Response("denied", { status: 403 }) });
    expect((await POST(request({}), context())).status).toBe(403); expect(mock.append).not.toHaveBeenCalled();
  });
  it("uses bounded JSON and rejects oversized content before the writer", async () => {
    const response = await POST(request({ reason: "x".repeat(300 * 1024) }), context());
    expect(response.status).toBe(413); expect(mock.append).not.toHaveBeenCalled();
  });
  it("preserves typed stale/permission/corrupt failures from transaction authority", async () => {
    mock.append.mockResolvedValue({ ok: false, status: 409, code: "stale_revision", message: "مراجعة قديمة" });
    const response = await POST(request({}), context());
    expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ code: "stale_revision" });
  });
  it("returns201 on append,200 on exact replay, and never caches the clinical result", async () => {
    const first = await POST(request({}), context()); expect(first.status).toBe(201);
    expect(first.headers.get("Cache-Control")).toBe("private, no-store");
    mock.append.mockResolvedValue({ ok: true, replayed: true, revision: { revisionId: 12 } });
    const replay = await POST(request({}), context()); expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ revision: { revisionId: 12 }, replayed: true });
  });
  it("reports uncertain write outcome rather than encouraging a second command", async () => {
    mock.append.mockRejectedValue(new Error("commit response lost"));
    const response = await POST(request({}), context());
    expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ code: "strategy_result_unknown" });
    expect(mock.append).toHaveBeenCalledTimes(1);
  });
});
