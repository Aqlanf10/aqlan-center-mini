/** In-process existing GET contract, synthetic boundaries only. This is not a
 * built HTTP/RBAC test and deliberately makes no server/DB changes. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  session: { username: "synthetic-admin", role: "admin" } as { username: string; role: string } | null,
  createLabOrder: vi.fn(), findUserByUsername: vi.fn(), getSettings: vi.fn(), labCounts: vi.fn(),
  listLabNames: vi.fn(), listLabOrders: vi.fn(), listLabServices: vi.fn(), listParties: vi.fn(), recordAudit: vi.fn(),
  doctorOwnsPatient: vi.fn(), patientHasVisitToday: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => boundary.session }));
vi.mock("@/lib/db", () => boundary);
import { GET } from "../app/api/lab/route";
const request = () => new Request("http://test.invalid/api/lab?patientId=101");
beforeEach(() => {
  vi.resetAllMocks(); boundary.session = { username: "synthetic-admin", role: "admin" };
  boundary.listLabOrders.mockResolvedValue([{ id: 301, patientId: 101, costMinor: 100, costCurrency: "YER" }]);
  boundary.listLabNames.mockResolvedValue([{ labName: "Synthetic lab", labPhone: null }]);
  boundary.doctorOwnsPatient.mockResolvedValue(true);
});
describe("existing patient lab GET contract", () => {
  it("provides the patient envelope without requiring a broad fallback", async () => {
    const res = await GET(request()); expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orders: [{ id: 301, patientId: 101, costMinor: 100, costCurrency: "YER" }], labs: [{ labName: "Synthetic lab", labPhone: null }] });
    // Canonical retrieval is patient-scoped before its unchanged bound.
    expect(boundary.listLabOrders).toHaveBeenCalledExactlyOnceWith({ patientId: 101 });
  });
  it("returns a genuine empty envelope", async () => {
    boundary.listLabOrders.mockResolvedValue([]); const res = await GET(request());
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ orders: [], labs: expect.any(Array) });
  });
  it("retains session failure as 401 and does not read lab data", async () => {
    boundary.session = null; const res = await GET(request()); expect(res.status).toBe(401);
    expect(boundary.listLabOrders).not.toHaveBeenCalled();
  });
  it("retains storage failure as 500 rather than an empty response", async () => {
    boundary.listLabOrders.mockRejectedValue(new Error("Synthetic storage failure"));
    const res = await GET(request()); expect(res.status).toBe(500); expect(await res.json()).not.toHaveProperty("orders");
  });
  it("retains existing doctor cost redaction", async () => {
    boundary.session = { username: "synthetic-doctor", role: "doctor" };
    boundary.findUserByUsername.mockResolvedValue({ isActive: true, partyId: 601, permissions: {} });
    const res = await GET(request()); expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ orders: [{ id: 301, costMinor: null, costCurrency: null }] });
  });
});
