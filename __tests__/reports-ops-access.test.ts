import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UNIFIED_REPORT_IDS, canAccessUnifiedReport } from "../lib/report-access";

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
});
