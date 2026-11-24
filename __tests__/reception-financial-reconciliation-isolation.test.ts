import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Synthetic-only regression: never connect to PostgreSQL or load a real patient's data.
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  openShift: vi.fn(), shiftPayments: vi.fn(), shiftExpenses: vi.fn(), drawer: vi.fn(),
  shifts: vi.fn(), labMappings: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getOpenShift: mocks.openShift,
  listShifts: mocks.shifts,
  listShiftPayments: mocks.shiftPayments,
  listShiftExpenses: mocks.shiftExpenses,
  shiftDrawerBreakdown: mocks.drawer,
  listLabAccountingMappings: mocks.labMappings,
}));
import { GET as readShiftReconciliation } from "../app/api/finance/reconciliation/route";
import { GET as readLabAccounting } from "../app/api/finance/lab-accounting/route";
import { apiRouteVerdict } from "../lib/http-permissions";

const request = () => new NextRequest("https://synthetic.invalid/api/finance/reconciliation");
const readers = [mocks.openShift, mocks.shiftPayments, mocks.shiftExpenses, mocks.drawer, mocks.shifts, mocks.labMappings];
const signIn = (role: string) =>
  mocks.session.mockResolvedValue({ role, userId: 7000, username: "synthetic-user", expiresAt: Date.now() + 60000 });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.openShift.mockResolvedValue(null);
  mocks.shifts.mockResolvedValue([]);
  mocks.labMappings.mockResolvedValue([]);
});

describe("P1: clinic-wide financial read confidentiality", () => {
  it("rejects reception from shifts reconciliation and laboratory accounting before any DB reads", async () => {
    signIn("reception");
    for (const response of [await readShiftReconciliation(request()), await readLabAccounting()]) {
      expect(response.status).toBe(403);
      const body = JSON.stringify(await response.json());
      for (const forbidden of ["openShift", "expenses", "income", "totalOwedMinor", "totalPaidMinor", "totalDueMinor", "mappings"]) {
        expect(body).not.toContain(forbidden);
      }
    }
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
  });

  it("denies other non-finance roles and anonymous callers before accessing financial rows", async () => {
    for (const role of ["doctor", "cashier", "assistant"]) {
      signIn(role);
      expect((await readShiftReconciliation(request())).status).toBe(403);
      expect((await readLabAccounting()).status).toBe(403);
    }
    mocks.session.mockResolvedValue(null);
    expect((await readShiftReconciliation(request())).status).toBe(401);
    expect((await readLabAccounting()).status).toBe(401);
    for (const reader of readers) expect(reader).not.toHaveBeenCalled();
  });

  it("preserves authorized admin and accountant read paths with synthetic empty ledgers", async () => {
    for (const role of ["admin", "accountant"]) {
      signIn(role);
      const shift = await readShiftReconciliation(request());
      expect(shift.status).toBe(200);
      expect((await shift.json()).shifts).toEqual([]);
      const lab = await readLabAccounting();
      expect(lab.status).toBe(200);
      expect((await lab.json()).summary.totalLabs).toBe(0);
    }
    expect(mocks.openShift).toHaveBeenCalledTimes(2);
    expect(mocks.shifts).toHaveBeenCalledTimes(2);
    expect(mocks.labMappings).toHaveBeenCalledTimes(2);
  });

  it("matches the fail-closed proxy matrix while preserving patient-specific collections", () => {
    for (const path of ["/api/finance/reconciliation", "/api/finance/lab-accounting"]) {
      const verdict = apiRouteVerdict(path, "GET");
      expect(verdict).toEqual({ kind: "registered", pattern: path, access: ["admin", "accountant"] });
    }
    for (const [path, method] of [["/api/payments", "POST"], ["/api/patients/17/ledger", "GET"]] as const) {
      const verdict = apiRouteVerdict(path, method);
      expect(verdict.kind).toBe("registered");
      if (verdict.kind === "registered") expect(verdict.access).toContain("reception");
    }
  });
});
