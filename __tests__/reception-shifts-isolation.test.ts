import { beforeEach, describe, expect, it, vi } from "vitest";

// Synthetic-only. Verify reception denial occurs before any shift, payment or audit DB access.
const mocks = vi.hoisted(() => ({
  session: vi.fn(), findUser: vi.fn(), open: vi.fn(), listPayments: vi.fn(),
  listExpenses: vi.fn(), drawer: vi.fn(), listShifts: vi.fn(), receiptOrigins: vi.fn(),
  create: vi.fn(), close: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  findUserByUsername: mocks.findUser,
  getOpenShift: mocks.open,
  listShiftPayments: mocks.listPayments,
  listShiftExpenses: mocks.listExpenses,
  shiftDrawerBreakdown: mocks.drawer,
  listShifts: mocks.listShifts,
  readReceiptProvenance: mocks.receiptOrigins,
  openShift: mocks.create,
  closeShift: mocks.close,
  recordAudit: mocks.audit,
  asPaymentLikes: () => [],
}));
vi.mock("@/lib/receipt-provenance-db", () => ({ readReceiptProvenance: mocks.receiptOrigins }));
import { GET, POST, PATCH } from "../app/api/shifts/route";
import { apiRouteVerdict } from "../lib/http-permissions";

const url = "https://synthetic.invalid/api/shifts";
const post = () => new Request(url, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ opening: { YER: 0, SAR: 0, USD: 0 } }),
});
const patch = () => new Request(url, {
  method: "PATCH", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ id: 12, counted: { YER: 0, SAR: 0, USD: 0 } }),
});
function signIn(role: "reception" | "admin" | "cashier" | "accountant" | "doctor") {
  mocks.session.mockResolvedValue({
    role, userId: 13, username: "synthetic-staff",
    expiresAt: Date.now() + 60_000, financeAccess: { operateShift: true },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.open.mockResolvedValue(null);
  mocks.listShifts.mockResolvedValue([]);
  mocks.receiptOrigins.mockResolvedValue({});
  mocks.findUser.mockResolvedValue({ permissions: { canViewCashDrawer: true } });
});

describe("P1 clinic-wide shift and drawer isolation", () => {
  it("rejects reception GET/POST/PATCH before reading or mutating any financial rows", async () => {
    signIn("reception");
    for (const response of [await GET(), await POST(post()), await PATCH(patch())]) {
      expect(response.status).toBe(403);
      const body = JSON.stringify(await response.json());
      for (const sensitive of ["expenseTotals", "receiptProvenance", "payments", "expected", "drawer"]) {
        expect(body).not.toContain(sensitive);
      }
    }
    for (const mock of [mocks.open, mocks.listPayments, mocks.listExpenses, mocks.drawer, mocks.listShifts,
      mocks.receiptOrigins, mocks.create, mocks.close, mocks.audit, mocks.findUser]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });

  it("keeps admin/cashier/accountant shift read and doctor explicit read approval", async () => {
    for (const role of ["admin", "cashier", "accountant", "doctor"] as const) {
      signIn(role);
      expect((await GET()).status).toBe(200);
    }
    expect(mocks.listShifts).toHaveBeenCalledTimes(4);
  });

  it("denies unapproved doctor shift read without database finance reads", async () => {
    signIn("doctor");
    mocks.findUser.mockResolvedValue({ permissions: { canViewCashDrawer: false } });
    expect((await GET()).status).toBe(403);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("preserves 401 on missing session", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(post())).status).toBe(401);
    expect((await PATCH(patch())).status).toBe(401);
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("enforces same ceiling at proxy but retains patient-specific collection and ledger", () => {
    for (const method of ["GET", "POST", "PATCH"]) {
      const rule = apiRouteVerdict("/api/shifts", method);
      expect(rule.kind).toBe("registered");
      if (rule.kind === "registered") {
        expect(rule.access).not.toContain("reception");
        expect(rule.access).toContain("admin");
        expect(rule.access).toContain("cashier");
      }
    }
    for (const [path, method] of [["/api/payments", "POST"], ["/api/patients/17/ledger", "GET"]] as const) {
      const rule = apiRouteVerdict(path, method);
      expect(rule.kind).toBe("registered");
      if (rule.kind === "registered") expect(rule.access).toContain("reception");
    }
  });
});
