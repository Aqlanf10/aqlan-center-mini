import { describe, expect, it } from "vitest";
import { parseDoctorPermissions } from "../lib/doctor-permissions";
import { financeReportAccess, projectFinanceSummary } from "../lib/finance-report-visibility";
import { financeSummaryFixture as summary } from "./fixtures/finance-summary";

const doctor = (raw: unknown) => financeReportAccess("doctor", parseDoctorPermissions(raw));
const deniedFields = ["expenses", "openingSettlements", "netMinor"];

describe("financial summary least-privilege projection", () => {
  it.each([undefined, null, {}, "{broken", { financialScope: "clinic_and_own" },
    { canViewExpenses: true }, { canViewClinicProfits: true }, { canViewAdminReports: true }])("denies a doctor without explicit clinic revenue access: %j", (permissions) => {
    expect(projectFinanceSummary(summary, doctor(permissions))).toBeNull();
  });

  it.each(["canViewClinicRevenue", "canViewClinicFinance"])("%s alone returns only revenue fields", (flag) => {
    const projected = projectFinanceSummary(summary, doctor({ [flag]: true }))!;
    expect(projected.income).toEqual(summary.income);
    expect(projected.refunds).toEqual(summary.refunds);
    expect(projected.invoicedByCurrency).toEqual(summary.invoicedByCurrency);
    expect(projected.topServices).toEqual(summary.topServices);
    for (const key of deniedFields) {
      expect(projected).not.toHaveProperty(key);
      expect(JSON.parse(JSON.stringify(projected))).not.toHaveProperty(key);
    }
  });

  it.each(["canViewClinicProfits", "canViewAdminReports"])("%s never reveals net when expenses are denied", (flag) => {
    const projected = projectFinanceSummary(summary, doctor({ canViewClinicRevenue: true, [flag]: true }))!;
    for (const key of deniedFields) expect(projected).not.toHaveProperty(key);
  });

  it("allows expense and opening-settlement fields without granting profit", () => {
    const projected = projectFinanceSummary(summary, doctor({ canViewClinicRevenue: true, canViewExpenses: true }))!;
    expect(projected.expenses).toEqual(summary.expenses);
    expect(projected.openingSettlements).toEqual(summary.openingSettlements);
    expect(projected).not.toHaveProperty("netMinor");
  });

  it.each(["canViewClinicProfits", "canViewAdminReports"])("keeps the authorized full doctor contract with %s", (flag) => {
    expect(projectFinanceSummary(summary, doctor({ canViewClinicRevenue: true, canViewExpenses: true, [flag]: true })))
      .toEqual(summary);
  });

  it.each(["admin", "accountant"])("preserves every field and amount for %s", (role) => {
    expect(projectFinanceSummary(summary, financeReportAccess(role))).toEqual(summary);
  });

  it.each(["reception", "cashier", "assistant", "unknown"])("does not expand %s access", (role) => {
    expect(projectFinanceSummary(summary, financeReportAccess(role, parseDoctorPermissions({}, "admin")))).toBeNull();
  });

  it("honors the existing accountant report restriction while admin remains unrestricted", () => {
    expect(projectFinanceSummary(summary, financeReportAccess("accountant", null, { viewReports: false }))).toBeNull();
    expect(projectFinanceSummary(summary, financeReportAccess("admin", null, { viewReports: false }))).toEqual(summary);
  });

  it("does not pass through future unclassified fields or mutate the source", () => {
    const expanded = { ...summary, futureSensitiveTotal: 999999,
      income: { ...summary.income, internalExpense: 999999 },
      topServices: summary.topServices.map((row) => ({ ...row, internalCost: 999999 })),
    };
    const projected = projectFinanceSummary(expanded, doctor({ canViewClinicRevenue: true }))!;
    expect(JSON.stringify(projected)).not.toContain("999999");
    expect(expanded.expenses).toEqual(summary.expenses);
    expect(expanded.netMinor).toBe(summary.netMinor);
    expect(projected.income).not.toBe(expanded.income);
    expect(projected.topServices).not.toBe(expanded.topServices);
  });

  it("fails closed for an inconsistent access object and preserves a permitted zero net", () => {
    expect(projectFinanceSummary(summary, { revenue: true, expenses: false, profit: true })).not.toHaveProperty("netMinor");
    expect(projectFinanceSummary({ ...summary, netMinor: 0 }, financeReportAccess("admin"))).toHaveProperty("netMinor", 0);
  });
});
