import { beforeEach, describe, expect, it, vi } from "vitest";

// Synthetic-only test: every backend reader is mocked; no real patients or shared DB access.
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  parties: vi.fn(),
  orders: vi.fn(),
  appointments: vi.fn(),
  balances: vi.fn(),
  schema: vi.fn(),
  settings: vi.fn(),
  audit: vi.fn(),
  settle: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  listParties: mocks.parties,
  listLabOrders: mocks.orders,
  listAppointmentsByDate: mocks.appointments,
  partyDueByCurrency: mocks.balances,
  ensureSchema: mocks.schema,
  getSettings: mocks.settings,
  ratesFromSettings: vi.fn(),
  recordAudit: mocks.audit,
  settleLabOrdersBatch: mocks.settle,
}));

import { GET } from "../app/api/finance/lab-reconciliation/route";
import { apiRouteVerdict } from "../lib/http-permissions";

const request = (query = "") =>
  new Request(`https://synthetic.invalid/api/finance/lab-reconciliation${query}`);
const readers = [
  mocks.parties, mocks.orders, mocks.appointments, mocks.balances,
  mocks.schema, mocks.settings, mocks.audit, mocks.settle,
];
function signIn(role: string) {
  mocks.session.mockResolvedValue({
    role, username: "synthetic-actor", userId: 7000, expiresAt: Date.now() + 60_000,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.parties.mockResolvedValue([]);
  mocks.orders.mockResolvedValue([]);
  mocks.appointments.mockResolvedValue([]);
  mocks.balances.mockResolvedValue([]);
});

describe("P1: laboratory reconciliation financial read boundary", () => {
  it.each(["reception", "doctor", "cashier", "assistant"])(
    "rejects %s for every GET projection before any financial or patient-linked DB reads", async (role) => {
      signIn(role);
      for (const query of ["", "?partyId=17", "?view=lab-balances-v1"]) {
        const response = await GET(request(query));
        expect(response.status).toBe(403);
        expect(response.headers.get("Cache-Control")).toContain("no-store");
        const text = JSON.stringify(await response.json());
        for (const secret of ["patientName", "systemCostMinor", "financialSummary", "orders", "risks"]) {
          expect(text).not.toContain(secret);
        }
      }
      for (const reader of readers) expect(reader).not.toHaveBeenCalled();
    },
  );

  it("rejects anonymous calls with no DB reads", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request("?view=lab-balances-v1"))).status).toBe(401);
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
  });

  it.each(["admin", "accountant"])("retains %s access to synthetic legacy reconciliation", async role => {
    signIn(role);
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.labs).toEqual([]);
    expect(body.risks).toEqual([]);
    expect(mocks.parties).toHaveBeenCalledWith("lab");
    expect(mocks.orders).toHaveBeenCalledWith({ limit: 300 });
    expect(mocks.appointments).toHaveBeenCalledTimes(3);
  });

  it("keeps the existing admin-only canonical balance view intact", async () => {
    signIn("admin");
    const response = await GET(request("?view=lab-balances-v1"));
    expect(response.status).toBe(200);
    expect(mocks.balances).toHaveBeenCalledOnce();
    signIn("accountant");
    const denied = await GET(request("?view=lab-balances-v1"));
    expect(denied.status).toBe(403);
    expect(mocks.balances).toHaveBeenCalledOnce();
  });

  it("matches fail-closed HTTP proxy and preserves receptionist patient collection", () => {
    expect(apiRouteVerdict("/api/finance/lab-reconciliation", "GET")).toEqual({
      kind: "registered", pattern: "/api/finance/lab-reconciliation", access: ["admin", "accountant"],
    });
    for (const [path, method] of [
      ["/api/payments", "POST"],
      ["/api/patients/17/ledger", "GET"],
    ] as const) {
      const verdict = apiRouteVerdict(path, method);
      expect(verdict.kind).toBe("registered");
      if (verdict.kind === "registered") expect(verdict.access).toContain("reception");
    }
  });
});
