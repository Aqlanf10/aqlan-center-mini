import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNIFIED_REPORT_IDS, canAccessUnifiedReport } from "../lib/report-access";
import { commissionStatementHref } from "../lib/reports";

/**
 * (Slice 7) من يرى تقارير سير العمل الجديد — القاعدة نفسها في الخادم والشاشة:
 * تفصيل العمولات مالي (المدير والمحاسب)، الإحالات الداخلية تشغيلية بلا مال (المدير والاستقبال الذي يحجزها)،
 * وجريان الكرسي رقابي (المدير وحده). الطبيب والكاشير خارج مركز التقارير أصلًا.
 */
describe("(Slice 7) report access", () => {
  const cases: Array<[string, string[]]> = [
    ["commission-detail", ["admin", "accountant"]],
    ["internal-referrals", ["admin", "reception"]],
    ["chair-flow", ["admin"]],
  ];
  it.each(cases)("%s is visible only to %j", (report, allowed) => {
    expect(UNIFIED_REPORT_IDS).toContain(report);
    for (const role of ["admin", "reception", "accountant", "cashier", "doctor"]) {
      expect(canAccessUnifiedReport(role, report)).toBe(allowed.includes(role));
    }
  });

  it("each report is listed in the reports screen", () => {
    const page = readFileSync("app/reports/page.tsx", "utf8");
    for (const [report] of cases) expect(page).toContain(`id: "${report}"`);
  });

  it("an accountant whose viewCommissions is off reaches neither commission report (same rule as the commissions screen)", () => {
    for (const report of ["commission-detail", "doctor-commission"]) {
      expect(canAccessUnifiedReport("accountant", report, { viewCommissions: false })).toBe(false);
      expect(canAccessUnifiedReport("accountant", report, { viewCommissions: true })).toBe(true);
      expect(canAccessUnifiedReport("admin", report, { viewCommissions: false })).toBe(true);
    }
    expect(canAccessUnifiedReport("accountant", "debt", { viewCommissions: false })).toBe(true);
  });

  it("the printable statement link carries the report's currency and specialty filters", () => {
    const base = { doctorId: 7, from: "2026-09-01", to: "2026-09-30" };
    expect(commissionStatementHref({ ...base, currency: "all", specialty: null }))
      .toBe("/print/commission-statement/7?from=2026-09-01&to=2026-09-30");
    expect(commissionStatementHref({ ...base, currency: "USD", specialty: "ortho" }))
      .toBe("/print/commission-statement/7?from=2026-09-01&to=2026-09-30&currency=USD&specialty=ortho");
  });
});
