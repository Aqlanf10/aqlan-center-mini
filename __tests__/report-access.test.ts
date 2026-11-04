import { describe, expect, it } from "vitest";
import { canAccessUnifiedReport, reportIsAdminOnly, reportVisibleToRole, UNIFIED_REPORT_IDS } from "../lib/report-access";

describe("reports access policy", () => {
  it("keeps center-wide financial and commission reports admin-only", () => {
    for (const report of ["daily", "monthly", "annual", "collections", "services", "patients", "debt", "aging", "specialty", "doctor", "doctor-commission", "treatment-plans", "lab", "suppliers"]) {
      expect(reportIsAdminOnly(report)).toBe(true);
      expect(canAccessUnifiedReport("reception", report)).toBe(false);
      expect(canAccessUnifiedReport("admin", report)).toBe(true);
    }
  });

  it("lets reception use operational reports without exposing clinic income", () => {
    for (const report of ["visits", "appointments", "recall", "inventory", "patient-statement"]) {
      expect(reportIsAdminOnly(report)).toBe(false);
      expect(canAccessUnifiedReport("reception", report)).toBe(true);
    }
  });

  it("does not expose unified reports to doctors", () => {
    expect(canAccessUnifiedReport("doctor", "visits")).toBe(false);
    expect(canAccessUnifiedReport("doctor", "doctor")).toBe(false);
  });
  it("applies the accountant's report grant to every known report and the navigation projection", () => {
    for (const report of ["options", ...UNIFIED_REPORT_IDS]) {
      expect(canAccessUnifiedReport("accountant", report, { viewReports: false, viewCommissions: true })).toBe(false);
      expect(reportVisibleToRole("accountant", report, { viewReports: false })).toBe(false);
    }
    expect(canAccessUnifiedReport("accountant", "daily", { viewReports: true })).toBe(true);
    expect(canAccessUnifiedReport("accountant", "doctor-commission", { viewReports: true, viewCommissions: false })).toBe(false);
    expect(canAccessUnifiedReport("admin", "daily", { viewReports: false })).toBe(true);
    expect(canAccessUnifiedReport("reception", "visits", { viewReports: false })).toBe(true);
  });
});
