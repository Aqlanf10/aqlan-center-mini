import { describe, expect, it } from "vitest";
import { assistantProcedureChange } from "../lib/clinical-finalizer";
import { isGatedRole, isRestrictedRole, restrictedRouteAllowed } from "../lib/role-routes";
import { ROLES, ROLE_LABEL } from "../lib/roles";
import { roleCan } from "../lib/settings-permissions";

/** (P0-F) المساعد السريري: دورٌ محروسٌ عند الباب، لا يعدّل إجراءات الطبيب، ولا مالية ولا إعدادات. */
describe("(P0-F) clinical assistant role", () => {
  it("is a real role, gated at the door, but not a finance-only role", () => {
    expect(ROLES).toContain("assistant");
    expect(ROLE_LABEL.assistant).toBe("مساعد سريري");
    expect(isGatedRole("assistant")).toBe(true);
    expect(isRestrictedRole("assistant")).toBe(false);
    expect(roleCan("assistant", "settings.view")).toBe(false);
  });

  it("reaches today's board, the patient page and the visit sign — nothing else", () => {
    const allowed: [string, string][] = [
      ["/", "GET"], ["/patients/12", "GET"], ["/api/visits", "GET"], ["/api/visits/readiness", "GET"],
      ["/api/visits/5/clinical", "GET"], ["/api/visits/5/clinical", "POST"], ["/api/patients/12", "GET"],
      ["/api/patients/12/workflow", "GET"], ["/api/auth/me", "GET"],
    ];
    for (const [path, method] of allowed) expect([path, restrictedRouteAllowed("assistant", path, method)]).toEqual([path, true]);
    const denied: [string, string][] = [
      ["/finance", "GET"], ["/settings", "GET"], ["/reports", "GET"], ["/appointments", "GET"],
      ["/api/patients/12/ledger", "GET"], ["/api/services", "GET"], ["/api/plans", "GET"], ["/api/payments", "POST"],
      ["/api/invoices/3", "DELETE"], ["/api/users", "GET"], ["/api/parties", "GET"], ["/api/settings", "GET"],
      ["/api/visits", "POST"], ["/api/visits/5", "PATCH"], ["/api/patients/12", "PATCH"],
      ["/api/finance/commissions", "GET"], ["/print/invoice/3", "GET"],
      ["/api/visits/5/billing-preview", "GET"], ["/api/visits/5/materials", "GET"],
      ["/api/inventory/4/movements", "POST"], ["/api/patients/12/intake-history", "POST"],
    ];
    for (const [path, method] of denied) expect([path, method, restrictedRouteAllowed("assistant", path, method)]).toEqual([path, method, false]);
  });

  it("the root rule is the board only, never a prefix for every path", () => {
    expect(restrictedRouteAllowed("assistant", "/", "GET")).toBe(true);
    expect(restrictedRouteAllowed("assistant", "/finance/commissions", "GET")).toBe(false);
  });
});

describe("(P0-F) assistantProcedureChange", () => {
  const saved = [{ serviceId: 3, toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 25000, doctorId: 7, planItemId: null }];
  const same = { serviceId: 3, toothCode: "16", surfaces: "", quantity: 1, unitPriceMinor: 25000, doctorId: 7, planItemId: null };

  it("the same lines (in any order, string ids) are not a change", () => {
    expect(assistantProcedureChange(saved, [same])).toBe(false);
  });

  it("a price, doctor, tooth, quantity, link, added or removed line is a change", () => {
    expect(assistantProcedureChange(saved, [{ ...same, unitPriceMinor: 1000 }])).toBe(true);
    expect(assistantProcedureChange(saved, [{ ...same, doctorId: 8 }])).toBe(true);
    expect(assistantProcedureChange(saved, [{ ...same, toothCode: 17 }])).toBe(true);
    expect(assistantProcedureChange(saved, [{ ...same, quantity: 2 }])).toBe(true);
    expect(assistantProcedureChange(saved, [{ ...same, planItemId: 4 }])).toBe(true);
    expect(assistantProcedureChange(saved, [same, same])).toBe(true);
    expect(assistantProcedureChange(saved, [])).toBe(true);
  });
});
