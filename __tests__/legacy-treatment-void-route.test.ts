import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({ requireSession: vi.fn(), getLegacyVoidPreview: vi.fn(), voidLegacyTreatment: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/legacy-treatment-db", () => ({ getLegacyVoidPreview: boundary.getLegacyVoidPreview, voidLegacyTreatment: boundary.voidLegacyTreatment }));
import { GET, POST } from "../app/api/patients/[id]/legacy-treatments/[agreementId]/void/route";
import { HTTP_PERMISSIONS } from "../lib/http-permissions";
const context = () => ({ params: Promise.resolve({ id: "7", agreementId: "11" }) });
const get = (mode = "ordinary") => new Request(`http://test.invalid/api/patients/7/legacy-treatments/11/void?mode=${mode}`);
const post = (body: unknown) => new Request(get().url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-owner", role: "admin" });
  boundary.getLegacyVoidPreview.mockResolvedValue({ ok: true, preview: { patientId: 7, agreementId: 11 } });
  boundary.voidLegacyTreatment.mockResolvedValue({ ok: true, agreement: { id: 11, status: "void" } });
});
describe("void HTTP authority and explicit operation", () => {
  it("registers both operations for the unchanged admin role only", () => {
    expect(HTTP_PERMISSIONS["/api/patients/[id]/legacy-treatments/[agreementId]/void"]).toEqual({ GET: ["admin"], POST: ["admin"] });
  });
  it.each(["reception", "doctor", "cashier", "accountant", "assistant", "manager"])("denies %s before financial reads or writes", async (role) => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-user", role });
    expect((await GET(get(), context())).status).toBe(403);
    expect((await POST(post({ reason: "Historical correction", mode: "manager_authorized", previewToken: "a".repeat(64) }), context())).status).toBe(403);
    expect(boundary.getLegacyVoidPreview).not.toHaveBeenCalled();
    expect(boundary.voidLegacyTreatment).not.toHaveBeenCalled();
  });
  it("denies missing sessions", async () => {
    boundary.requireSession.mockResolvedValue(null);
    expect((await GET(get(), context())).status).toBe(401);
    expect((await POST(post({ reason: "Historical correction" }), context())).status).toBe(401);
  });
  it("binds read mode and authenticated actor, and never caches the preview", async () => {
    const response = await GET(get("manager_authorized"), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(boundary.getLegacyVoidPreview).toHaveBeenCalledExactlyOnceWith({ patientId: 7, agreementId: 11,
      actor: "synthetic-owner", actorRole: "admin", mode: "manager_authorized" });
  });
  it("ordinary remains default, and client fields cannot grant authority", async () => {
    expect((await POST(post({ reason: "Historical correction" }), context())).status).toBe(200);
    expect(boundary.voidLegacyTreatment).toHaveBeenCalledWith(expect.objectContaining({ mode: "ordinary", actorRole: "admin" }));
    boundary.voidLegacyTreatment.mockClear();
    expect((await POST(post({ reason: "Historical correction", actorRole: "admin" }), context())).status).toBe(400);
    expect(boundary.voidLegacyTreatment).not.toHaveBeenCalled();
  });
  it("requires a preview before explicit manager action", async () => {
    const response = await POST(post({ reason: "Historical correction", mode: "manager_authorized" }), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ reason: "preview_required" });
    expect(boundary.voidLegacyTreatment).not.toHaveBeenCalled();
  });
  it("returns stale and collection refusals without retrying or downgrading the operation", async () => {
    boundary.voidLegacyTreatment.mockResolvedValue({ ok: false, reason: "preview_stale" });
    const response = await POST(post({ reason: "Historical correction", mode: "manager_authorized", previewToken: "a".repeat(64) }), context());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ reason: "preview_stale" });
    expect(boundary.voidLegacyTreatment).toHaveBeenCalledTimes(1);
  });
});
