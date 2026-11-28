import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  select: vi.fn(), session: vi.fn(), ensure: vi.fn(), available: vi.fn(), query: vi.fn(),
  audit: vi.fn(), grants: vi.fn(), identity: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  ensureSchema: m.ensure, getPool: () => ({ query: m.query }), insertAuditRow: m.audit,
  serviceMaterialRateStorageAvailable: m.available,
}));
vi.mock("@/lib/session", () => ({ requireSession: m.session }));
vi.mock("@/lib/staff-session-admission", () => ({ selectRequestStaffEnvelope: m.select }));
vi.mock("@/lib/staff-capability-editor", () => ({ staffAdmissionRefusal: () => null }));
vi.mock("@/lib/staff-operation-runtime", () => ({
  staffOperationCapabilities: m.grants, staffOperationIdentity: m.identity,
  withStaffOperation: async (pool: unknown, _token: unknown, _action: unknown, fn: (pool: unknown, handle: unknown) => Promise<unknown>) => fn(pool, {}),
}));
vi.mock("@/lib/transactions", () => ({
  withTransaction: async (pool: unknown, fn: (pool: unknown) => Promise<unknown>) => fn(pool),
}));

import { GET, POST } from "@/app/api/settings/material-service-rates/route";

const body = { serviceId: 55, rateBp: 0, revision: "42", reason: "New explicit exemption" };
const post = (input: unknown = body) => POST(new Request("http://test.local/settings", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
}));

beforeEach(() => {
  vi.resetAllMocks();
  m.select.mockResolvedValue({ kind: "legacy" });
  m.session.mockResolvedValue({ role: "admin", username: "synthetic" });
  m.available.mockResolvedValue(true);
});

describe("service material rate Settings route", () => {
  it("does not read or write rates as reception or a canonical delegate without finance permission", async () => {
    m.session.mockResolvedValue({ role: "reception", username: "synthetic" });
    expect((await GET()).status).toBe(403);
    expect((await post()).status).toBe(403);
    m.select.mockResolvedValue({ kind: "canonical", handle: {} });
    m.grants.mockResolvedValue(new Set(["settings.operational.edit"]));
    expect((await post()).status).toBe(403);
    expect(m.query).not.toHaveBeenCalled();
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("keeps the feature locked without the storage, and does not write on a stale revision", async () => {
    m.available.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    expect(await (await GET()).json()).toEqual({ enabled: false, rates: [] });
    expect((await post()).status).toBe(409);
    m.query.mockResolvedValueOnce({ rows: [{ name: "Synthetic service" }] })
      .mockResolvedValueOnce({ rows: [{ revision: "43", rate_bp: 2000 }] });
    expect((await post()).status).toBe(409);
    expect(m.query).toHaveBeenCalledTimes(2);
    expect(m.audit).not.toHaveBeenCalled();
  });

  it("writes an explicit zero and audit together using the canonical actor", async () => {
    m.select.mockResolvedValue({ kind: "canonical", handle: {} });
    m.grants.mockResolvedValue(new Set(["settings.finance.edit"]));
    m.identity.mockResolvedValue({ role: "admin", username: "canonical-synthetic" });
    m.query.mockResolvedValueOnce({ rows: [{ name: "Synthetic service" }] })
      .mockResolvedValueOnce({ rows: [{ revision: "42", rate_bp: 2000 }] })
      .mockResolvedValueOnce({ rows: [{ revision: "43" }] });
    const response = await post();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ ok: true, revision: "43" });
    expect(m.query.mock.calls[2][1]).toEqual([55, 0, "canonical-synthetic", body.reason]);
    expect(m.audit).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      actor: "canonical-synthetic", entityId: 55, action: "material_rate.set",
    }));
  });
});
