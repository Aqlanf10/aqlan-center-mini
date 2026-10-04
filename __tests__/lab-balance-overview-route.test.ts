/** Actual GET handler and permission helpers; all DB/session reads are synthetic.
 * This does not claim a live proxy, Postgres or Production test. */
import { beforeEach, describe, expect, it, vi } from "vitest";
const boundary = vi.hoisted(() => ({
  session: { username: "synthetic-admin", role: "admin", permissions: {} } as { username: string; role: string; permissions: Record<string, unknown> } | null,
  listParties: vi.fn(), partyDueByCurrency: vi.fn(), listLabOrders: vi.fn(), listAppointmentsByDate: vi.fn(),
  getSettings: vi.fn(), ensureSchema: vi.fn(), settleLabOrdersBatch: vi.fn(), recordAudit: vi.fn(), ratesFromSettings: vi.fn(), findUserByUsername: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => boundary.session }));
vi.mock("@/lib/db", () => ({ ...boundary, CLINIC_TIME_ZONE: "UTC" }));
import { GET } from "../app/api/finance/lab-reconciliation/route";
import { restrictedRouteAllowed } from "../lib/role-routes";
import { apiRouteVerdict } from "../lib/http-permissions";

const path = "/api/finance/lab-reconciliation";
const request = (query = "view=lab-balances-v1") => GET(new Request(`http://test.invalid${path}?${query}`));
const catalog = [{ id: 1, name: "Inactive lab", kind: "lab", currency: "YER", phone: null, isActive: false, note: "private" },
  { id: 2, name: "Empty lab", kind: "lab", currency: "SAR", phone: null }];
const noBusinessReads = () => {
  for (const read of [boundary.listParties, boundary.partyDueByCurrency, boundary.listLabOrders, boundary.listAppointmentsByDate, boundary.getSettings, boundary.ensureSchema]) expect(read).not.toHaveBeenCalled();
};
beforeEach(() => {
  vi.resetAllMocks(); boundary.session = { username: "synthetic-admin", role: "admin", permissions: {} };
  boundary.listParties.mockResolvedValue(catalog);
  boundary.partyDueByCurrency.mockResolvedValue([
    { partyId: 1, name: "Inactive lab", kind: "lab", currency: "USD", dueMinor: -150 },
    { partyId: 1, name: "Inactive lab", kind: "lab", currency: "YER", dueMinor: 12345 },
    { partyId: 9, name: "Supplier excluded", kind: "supplier", currency: "SAR", dueMinor: 888888 },
  ]);
  boundary.listLabOrders.mockResolvedValue([]); boundary.listAppointmentsByDate.mockResolvedValue([]);
  boundary.findUserByUsername.mockResolvedValue({ permissions: { canViewCostPrices: true } });
});

describe("bounded admin-only lab net balance overview", () => {
  it("uses the existing canonical owner once, projects only lab identities/buckets, and does not read orders/settings/appointments", async () => {
    const response = await request(); const body = await response.json();
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(boundary.listParties).toHaveBeenCalledExactlyOnceWith("lab"); expect(boundary.partyDueByCurrency).toHaveBeenCalledExactlyOnceWith();
    expect(boundary.listParties.mock.invocationCallOrder[0]).toBeLessThan(boundary.partyDueByCurrency.mock.invocationCallOrder[0]);
    expect(body.version).toBe("lab-balances-v1"); expect(Number.isFinite(Date.parse(body.observedAt))).toBe(true);
    expect(body.labs[0].partyNetBalance).toEqual({ state: "ready", scope: "whole_party", byCurrency: [
      { currency: "YER", netMinor: 12345 }, { currency: "USD", netMinor: -150 },
    ] });
    expect(body.labs[1].partyNetBalance.byCurrency).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/888888|Supplier excluded|private"|unsettledCostMinor|orders|expenses|advances|payableId/);
    for (const read of [boundary.listLabOrders, boundary.listAppointmentsByDate, boundary.getSettings, boundary.findUserByUsername, boundary.settleLabOrdersBatch, boundary.recordAudit]) expect(read).not.toHaveBeenCalled();
  });
  it("enumerates the catalog before starting canonical reads and does not continue a failed catalog", async () => {
    let resolve!: (value: typeof catalog) => void;
    boundary.listParties.mockReturnValue(new Promise<typeof catalog>((yes) => { resolve = yes; }));
    const pending = request(); await Promise.resolve(); await Promise.resolve();
    expect(boundary.partyDueByCurrency).not.toHaveBeenCalled();
    resolve(catalog); expect((await pending).status).toBe(200);
    boundary.partyDueByCurrency.mockClear(); boundary.listParties.mockRejectedValue(new Error("Synthetic catalog failure"));
    expect((await request()).status).toBe(503); expect(boundary.partyDueByCurrency).not.toHaveBeenCalled();
  });
  it("refuses an expired session before any financial read", async () => {
    boundary.session = null; expect((await request()).status).toBe(401); noBusinessReads();
  });
  it.each(["doctor", "reception", "accountant", "cashier", "assistant"])("refuses %s before any reads, even with cost and finance capabilities", async (role) => {
    boundary.session = { username: "synthetic-user", role, permissions: { canViewCostPrices: true, financeAccess: { viewSuppliers: true, viewReconciliation: true } } };
    expect((await request()).status).toBe(403); noBusinessReads(); expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });
  it.each([[true, false], [false, true], [true, true], [false, false]])("keeps the accountant capability intersection restrictive (%s, %s)", async (viewSuppliers, viewReconciliation) => {
    const access = { viewSuppliers, viewReconciliation };
    expect(restrictedRouteAllowed("accountant", path, "GET", access)).toBe(viewReconciliation);
    expect(restrictedRouteAllowed("accountant", "/api/payables", "GET", access)).toBe(viewSuppliers);
    boundary.session = { username: "synthetic-accountant", role: "accountant", permissions: { financeAccess: access } };
    expect((await request()).status).toBe(403); noBusinessReads();
  });
  it("uses the already registered GET route without granting a new route/capability", () => {
    const verdict = apiRouteVerdict(path, "GET");
    expect(verdict.kind).toBe("registered");
    expect(restrictedRouteAllowed("cashier", path, "GET", { viewSuppliers: true, viewReconciliation: true })).toBe(false);
  });
  it.each(["view=", "view=financial-read-v1", "view=unknown", "view=lab-balances-v1&view=lab-balances-v1",
    "view=lab-balances-v1&partyId=1", "view=lab-balances-v1&partyId=", "view=lab-balances-v1&orderId=1", "view=lab-balances-v1&month=2026-10"])("rejects unsupported/malformed scope %s before reads", async (query) => {
    expect((await request(query)).status).toBe(400); noBusinessReads();
  });
  it.each(["catalog", "canonical", "malformed", "catalog-changed"])("makes failed %s reads unavailable rather than empty/zero", async (kind) => {
    if (kind === "catalog") boundary.listParties.mockRejectedValue(new Error("Synthetic catalog failure"));
    if (kind === "canonical") boundary.partyDueByCurrency.mockRejectedValue(new Error("Synthetic balance failure"));
    if (kind === "malformed") boundary.partyDueByCurrency.mockResolvedValue([{ kind: "lab", partyId: 1, currency: "USD", dueMinor: null }]);
    if (kind === "catalog-changed") boundary.partyDueByCurrency.mockResolvedValue([{ kind: "lab", partyId: 8, currency: "USD", dueMinor: 50 }]);
    const response = await request(); expect(response.status).toBe(503); expect(await response.json()).not.toHaveProperty("labs");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it.each(["admin", "doctor", "reception", "accountant"])("preserves published legacy GET admission for %s without introducing a new cost gate", async (role) => {
    // Handler admission only: the unchanged proxy role/capability rules remain cumulative.
    boundary.session = { username: "legacy-user", role, permissions: { canViewCostPrices: false } };
    const response = await request(""); expect(response.status).toBe(200);
    expect(boundary.partyDueByCurrency).not.toHaveBeenCalled();
    expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });
  it("preserves legacy party detail fields and costs without adding canonical ledger data", async () => {
    boundary.session = { username: "legacy-doctor", role: "doctor", permissions: {} };
    boundary.listLabOrders.mockResolvedValue([{ id: 71, partyId: 1, labName: "Inactive lab", patientName: "Synthetic patient",
      patientNumber: "P-7", workType: "Synthetic crown", toothNumbers: "11", sentDate: "2026-10-01", dueDate: "2026-10-05",
      costMinor: 1500, costCurrency: "USD", status: "sent", financialStatus: "pending_delivery", details: "Synthetic detail" }]);
    const response = await request("partyId=1"); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ party: catalog[0], orders: [{ orderId: 71, patientName: "Synthetic patient",
      patientNumber: "P-7", workType: "Synthetic crown", teeth: "11", sentDate: "2026-10-01", dueDate: "2026-10-05",
      systemCostMinor: 1500, currency: "USD", status: "sent", financialStatus: "pending_delivery", notes: "Synthetic detail" }],
      unsettledCount: 1, risks: [] });
    expect(boundary.partyDueByCurrency).not.toHaveBeenCalled(); expect(boundary.findUserByUsername).not.toHaveBeenCalled();
  });
  it("does not leak canonical data to a cost-enabled doctor through the legacy catalog", async () => {
    boundary.session = { username: "synthetic-doctor", role: "doctor", permissions: { canViewCostPrices: true } };
    const response = await request(""); const body = await response.json();
    expect(response.status).toBe(200); expect(boundary.partyDueByCurrency).not.toHaveBeenCalled();
    expect(body.financialSummary).toEqual({ state: "unavailable", reason: "use_authorized_financial_read" });
    expect(body.clinicalScope).toEqual({ kind: "loaded_global_window", limit: 300 });
    expect(JSON.stringify(body)).not.toMatch(/partyNetBalance|netMinor|unsettledCostMinor/);
  });
});
