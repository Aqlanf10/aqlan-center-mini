import { describe, expect, it } from "vitest";
import { canAccessUnifiedReport, reportIsAdminOnly } from "../lib/report-access";

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
});
