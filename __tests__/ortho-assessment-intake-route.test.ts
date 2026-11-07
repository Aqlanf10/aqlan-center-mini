import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../proxy";
import { apiRouteVerdict } from "../lib/http-permissions";
const state = vi.hoisted(() => ({
  session: { userId: 7, username: "synthetic-intake", role: "admin", expiresAt: 4102444800000 } as Record<string, unknown> | null,
  access: true, open: vi.fn(), start: vi.fn(),
}));
vi.mock("../lib/session", () => ({ requireSession: async () => state.session }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: async () => state.access }));
vi.mock("../lib/ortho-assessment-intake-store", () => ({ openOrthoAssessment: state.open, startOrthoTreatment: state.start }));
import { POST as intake } from "../app/api/ortho/intake/route";
import { POST as start } from "../app/api/ortho/[id]/treatment-start/route";
import { JSON_BODY_LIMIT_BYTES } from "../lib/security-limits";
const command = { schemaVersion: 1, clientRequestId: "synthetic_route_intake_001", reason: "Synthetic intake" };
const request = (body: unknown = { patientId: 19, command }, query = "") => new Request(`http://localhost/api/ortho/intake${query}`, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
beforeEach(() => {
  state.session = { userId: 7, username: "synthetic-intake", role: "admin", expiresAt: 4102444800000 };
  state.access = true; state.open.mockReset(); state.start.mockReset();
});
describe("assessment intake route admission", () => {
  it.each([null, { userId: 7, role: "reception" }])("denies unauthenticated or non-clinical writes before storage: %j", async session => {
    state.session = session;
    const response = await intake(request());
    expect(response.status).toBe(session ? 403 : 401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(state.open).not.toHaveBeenCalled();
  });
  it("refuses malformed scope or extra query/body fields before storage", async () => {
    for (const bad of [request({ patientId: 0, command }), request({ patientId: 19, command, planId: 7 }), request(undefined, "?planId=7")]) {
      expect((await intake(bad)).status).toBe(400);
    }
    expect(state.open).not.toHaveBeenCalled();
  });
  it("bounds request size without dispatching a write", async () => {
    expect((await intake(request({ patientId: 19, command: { reason: "x".repeat(JSON_BODY_LIMIT_BYTES) } }))).status).toBe(413);
    expect(state.open).not.toHaveBeenCalled();
  });
  it("binds the admitted session and owner and preserves new/replayed status codes", async () => {
    state.open.mockResolvedValue({ ok: true, mode: "created", orthoCaseId: 41 });
    const response = await intake(request());
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(state.open).toHaveBeenCalledWith({ patientId: 19, command, session: state.session });
    state.start.mockResolvedValue({ ok: true, mode: "replayed", orthoCaseId: 41 });
    expect((await start(request(), { params: Promise.resolve({ id: "41" }) })).status).toBe(200);
    expect(state.start).toHaveBeenCalledWith(expect.objectContaining({ patientId: 19, orthoCaseId: 41, command, session: state.session }));
  });
  it("refuses a forbidden patient or malformed treatment case before storage", async () => {
    state.access = false;
    expect((await start(request(), { params: Promise.resolve({ id: "41" }) })).status).toBe(403);
    state.access = true;
    expect((await start(request(), { params: Promise.resolve({ id: "41abc" }) })).status).toBe(400);
    expect(state.start).not.toHaveBeenCalled();
  });
  it("reports an uncertain write privately rather than an invented success", async () => {
    state.open.mockRejectedValue(Error("synthetic connection interruption"));
    const response = await intake(request());
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ ok: false, code: "write_unconfirmed" });
  });
});

const proxySecret = "synthetic-intake-proxy-tests-not-a-live-credential";
function proxyRequest(path: string, method = "POST", role: string | null = "doctor") {
  const payload = { userId: 7, username: "synthetic-intake", role, expiresAt: Date.now() + 60_000 };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = `${body}.${createHmac("sha256", proxySecret).update(body).digest("base64url")}`;
  return new NextRequest(`https://synthetic.invalid${path}`, {
    method, headers: { ...(role ? { authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
  });
}
afterEach(() => vi.unstubAllEnvs());
describe("intake commands through the production proxy", () => {
  beforeEach(() => { vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SESSION_SECRET", proxySecret); });
  it.each([
    ["/api/ortho/intake", "/api/ortho/intake"],
    ["/api/ortho/41/treatment-start", "/api/ortho/[id]/treatment-start"],
  ])("registers and admits clinical POST %s without broadening verbs", async (path, pattern) => {
    expect(apiRouteVerdict(path, "POST")).toEqual({ kind: "registered", pattern, access: ["admin", "doctor"] });
    for (const role of ["admin", "doctor"]) {
      expect((await proxy(proxyRequest(path, "POST", role))).headers.get("x-middleware-next")).toBe("1");
    }
    for (const method of ["GET", "PATCH", "DELETE"]) {
      expect((await proxy(proxyRequest(path, method))).status).toBe(405);
    }
    expect((await proxy(proxyRequest(path, "POST", null))).status).toBe(401);
    for (const role of ["assistant", "cashier", "accountant"]) {
      expect((await proxy(proxyRequest(path, "POST", role))).status).toBe(403);
    }
  });
  it.each(["reception", "assistant", "cashier", "accountant"])("refuses %s at both handlers before storage even when called directly", async role => {
    state.session = { userId: 7, username: "synthetic-intake", role };
    expect((await intake(request())).status).toBe(403);
    expect((await start(request(), { params: Promise.resolve({ id: "41" }) })).status).toBe(403);
    expect(state.open).not.toHaveBeenCalled(); expect(state.start).not.toHaveBeenCalled();
  });
});
