import { describe, expect, it, vi } from "vitest";
import { pageVisibleToRole, restrictedRouteAllowed } from "../lib/role-routes";
import { verifiedSessionRole } from "../lib/proxy-role";
import { canHandleMoney, canViewFinancialReports, canViewMoney } from "../lib/roles";

/**
 * (P2-1) حدود الكاشير والمحاسب — قائمة سماح عند الباب. كل ما ليس فيها مرفوض،
 * والأدوار القديمة لا تتأثر.
 */

describe("restricted role allowlist", () => {
  it("cashier: the cash desk only — no clinical file, schedule, reports or settings", () => {
    const allowed = (path: string, method = "GET") => restrictedRouteAllowed("cashier", path, method);
    expect(allowed("/finance")).toBe(true);
    expect(allowed("/api/shifts", "POST")).toBe(true);
    expect(allowed("/api/payments", "POST")).toBe(true);
    expect(allowed("/api/expenses", "POST")).toBe(true);
    expect(allowed("/api/patients")).toBe(true);
    expect(allowed("/api/patients/12/ledger")).toBe(true);
    expect(allowed("/print/receipt/5")).toBe(true);
    expect(allowed("/api/auth/me")).toBe(true);
    expect(allowed("/api/auth/logout", "POST")).toBe(true);
    expect(allowed("/api/plans")).toBe(true);
    // الرئيسية لوحة العمليات السريرية — تُعاد إلى الصندوق.
    expect(allowed("/")).toBe(false);

    expect(allowed("/api/patients/12")).toBe(false);
    expect(allowed("/api/patients/12/documents")).toBe(false);
    expect(allowed("/api/appointments")).toBe(false);
    expect(allowed("/api/reports")).toBe(false);
    expect(allowed("/api/settings")).toBe(false);
    expect(allowed("/api/users")).toBe(false);
    expect(allowed("/patients/12")).toBe(false);
    expect(allowed("/api/invoices/3", "DELETE")).toBe(false);
    expect(allowed("/api/patients/abc/ledger")).toBe(false);
    expect(allowed("/api/messages/file/12")).toBe(false);
    expect(allowed("/api/messages/voice/12")).toBe(false);
  });

  it("accountant: reads all money and reports, writes no receipt, voucher or shift", () => {
    const allowed = (path: string, method = "GET") => restrictedRouteAllowed("accountant", path, method);
    for (const path of ["/api/payments", "/api/shifts", "/api/expenses", "/api/payables", "/api/finance/report",
      "/api/finance/commissions", "/api/accounting", "/api/reports", "/reports", "/finance/debts", "/print/party/4"]) {
      expect(allowed(path), path).toBe(true);
    }
    for (const [path, method] of [["/api/payments", "POST"], ["/api/shifts", "POST"], ["/api/shifts", "PATCH"],
      ["/api/expenses", "POST"], ["/api/invoices", "POST"], ["/api/opening-balances", "PUT"]] as const) {
      expect(allowed(path, method), `${method} ${path}`).toBe(false);
    }
    expect(allowed("/api/finance/expense-categories", "POST")).toBe(false);
    expect(allowed("/api/reports/saved", "POST")).toBe(false);
    expect(allowed("/api/patients/3")).toBe(false);
    expect(allowed("/api/ai/chat", "POST")).toBe(false);
    expect(allowed("/api/messages/file/12")).toBe(false);
    expect(allowed("/api/messages/voice/12")).toBe(false);
  });

  it("leaves the original roles to their own route checks", () => {
    for (const role of ["admin", "reception", "doctor", null, undefined]) {
      expect(restrictedRouteAllowed(role, "/api/patients/1", "DELETE")).toBe(true);
    }
    expect(pageVisibleToRole("cashier", "/appointments")).toBe(false);
    expect(pageVisibleToRole("accountant", "/reports")).toBe(true);
    expect(pageVisibleToRole("reception", "/appointments")).toBe(true);
  });

  it("money predicates: accountant reads, never handles", () => {
    expect(canHandleMoney("cashier")).toBe(true);
    expect(canHandleMoney("accountant")).toBe(false);
    expect(canViewMoney("accountant")).toBe(true);
    expect(canViewMoney("doctor")).toBe(false);
    expect(canViewFinancialReports("accountant")).toBe(true);
    expect(canViewFinancialReports("cashier")).toBe(false);
    expect(canViewFinancialReports("reception")).toBe(false);
  });

  it("applies each user's finance settings within the role ceiling", () => {
    expect(restrictedRouteAllowed("cashier", "/api/payments", "POST", { collectPayments: false })).toBe(false);
    expect(restrictedRouteAllowed("cashier", "/api/shifts", "POST", { operateShift: false })).toBe(false);
    expect(restrictedRouteAllowed("cashier", "/api/expenses", "POST", { createExpenses: false })).toBe(false);
    expect(restrictedRouteAllowed("cashier", "/api/finance/debts", "GET", { viewPatientLedger: false })).toBe(false);
    expect(restrictedRouteAllowed("cashier", "/api/reports", "GET", { viewReports: true })).toBe(false);
    expect(restrictedRouteAllowed("accountant", "/api/finance/commissions", "GET", { viewCommissions: false })).toBe(false);
    expect(restrictedRouteAllowed("accountant", "/api/parties", "GET", { viewSuppliers: false })).toBe(false);
    expect(restrictedRouteAllowed("accountant", "/api/payments", "POST", { collectPayments: true })).toBe(false);
  });
});

describe("verifiedSessionRole (proxy, Web Crypto)", () => {
  const secret = "role-test-secret-0123456789abcdef-xyz";
  async function token(payload: Record<string, unknown>, key = secret): Promise<string> {
    const { createHmac } = await import("node:crypto");
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
  }

  it("reads the signed role only when the signature and expiry hold", async () => {
    const future = Date.now() + 60_000;
    expect(await verifiedSessionRole(await token({ role: "cashier", expiresAt: future }), secret)).toBe("cashier");
    expect(await verifiedSessionRole(await token({ role: "cashier", expiresAt: future }, `${secret}-other`), secret)).toBeNull();
    expect(await verifiedSessionRole(await token({ role: "cashier", expiresAt: Date.now() - 1 }), secret)).toBeNull();
    const valid = await token({ role: "cashier", expiresAt: future });
    const forged = `${Buffer.from(JSON.stringify({ role: "admin", expiresAt: future })).toString("base64url")}.${valid.split(".")[1]}`;
    expect(await verifiedSessionRole(forged, secret)).toBeNull();
    expect(await verifiedSessionRole("garbage", secret)).toBeNull();
    expect(await verifiedSessionRole(valid, "short")).toBeNull();
  });

  it("accepts exactly the tokens the server signs (parity with lib/auth)", async () => {
    vi.stubEnv("SESSION_SECRET", secret);
    try {
      const { createSessionToken } = await import("../lib/auth");
      const real = createSessionToken({
        userId: 3, username: "c", role: "accountant", expiresAt: Date.now() + 60_000, partyId: null, credentialVersion: "v",
      });
      expect(await verifiedSessionRole(real)).toBe("accountant");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
