import { describe, expect, it } from "vitest";

import {
  NAV_ITEMS,
  groupNavItems,
  isNavItemActive,
  visibleNavItems,
} from "./nav-items";

describe("navigation information architecture", () => {
  it("keeps modules in a stable task-oriented order", () => {
    const groups = groupNavItems(visibleNavItems("ADMIN"));
    expect(groups.map((group) => group.section)).toEqual([
      null,
      "dailyOperations",
      "clinical",
      "finance",
      "partners",
      "administration",
    ]);
    expect(groups[0]!.items.map((item) => item.href)).toEqual(["/dashboard"]);
    expect(groups[1]!.items.map((item) => item.href)).toEqual([
      "/today",
      "/appointments",
      "/follow-up",
      "/reports",
    ]);
  });

  it("applies role visibility centrally", () => {
    const reception = visibleNavItems("RECEPTION").map((item) => item.href);
    expect(reception).toContain("/finance/receipts");
    expect(reception).not.toContain("/finance");
    expect(reception).not.toContain("/finance/vouchers");
    expect(reception).not.toContain("/settings/audit-log");

    const doctor = visibleNavItems("DOCTOR").map((item) => item.href);
    expect(doctor).toContain("/my-work");
    expect(doctor).not.toContain("/finance/commissions");
  });

  it("highlights only the most-specific visible finance route", () => {
    const adminItems = visibleNavItems("ADMIN");
    expect(isNavItemActive("/finance/receipts", "/finance", adminItems)).toBe(false);
    expect(
      isNavItemActive("/finance/receipts", "/finance/receipts", adminItems)
    ).toBe(true);
  });

  it("keeps a parent active on detail pages without a deeper nav item", () => {
    expect(isNavItemActive("/patients/p-123", "/patients", NAV_ITEMS)).toBe(true);
  });
});
