import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ select: vi.fn(), session: vi.fn(), legacy: vi.fn(), canonical: vi.fn() }));
vi.mock("../lib/staff-session-admission", () => ({ selectRequestStaffEnvelope: mocks.select }));
vi.mock("../lib/session", () => ({ requireSession: mocks.session }));
vi.mock("../lib/db", () => ({ listCephReferenceSets: mocks.legacy }));
vi.mock("../lib/canonical-ceph-references", () => ({ readCanonicalCephReferences: mocks.canonical, CanonicalCephReferenceRefusal: class extends Error {} }));
vi.mock("../lib/canonical-patient-http", () => ({ NO_STORE: { "Cache-Control": "private, no-store" }, canonicalPatientReadFailure: vi.fn() }));
const { GET } = await import("../app/api/ceph-reference-sets/route");
beforeEach(() => { vi.clearAllMocks(); mocks.select.mockResolvedValue({ kind: "legacy" }); mocks.session.mockResolvedValue({ role: "reception" }); mocks.legacy.mockResolvedValue([{ key: "SYN-old", values: { ANB: { mean: 2, sd: 1 } } }]); });
it.each(["admin", "doctor", "reception", "accountant"])("preserves legacy %s catalogue behavior and response shape", async role => {
  mocks.session.mockResolvedValue({ role });
  const response = await GET(new Request("http://localhost/api/ceph-reference-sets"));
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ sets: [{ key: "SYN-old", values: { ANB: { mean: 2, sd: 1 } } }] });
  expect(mocks.legacy).toHaveBeenCalledTimes(1); expect(mocks.canonical).not.toHaveBeenCalled();
});
it("preserves legacy missing-session and backend-failure refusals without raw errors", async () => {
  mocks.session.mockResolvedValue(null);
  expect((await GET(new Request("http://localhost/api/ceph-reference-sets"))).status).toBe(401); expect(mocks.legacy).not.toHaveBeenCalled();
  mocks.session.mockResolvedValue({ role: "doctor" }); mocks.legacy.mockRejectedValue(new Error("SYN private SQL"));
  const response = await GET(new Request("http://localhost/api/ceph-reference-sets")); expect(response.status).toBe(500); expect(JSON.stringify(await response.json())).not.toContain("SYN private SQL");
});
it("does not fall back to the legacy reader for a refused envelope", async () => {
  mocks.select.mockResolvedValue({ kind: "denied" });
  const response = await GET(new Request("http://localhost/api/ceph-reference-sets"));
  expect(response.status).toBe(401); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(mocks.session).not.toHaveBeenCalled(); expect(mocks.legacy).not.toHaveBeenCalled(); expect(mocks.canonical).not.toHaveBeenCalled();
});
