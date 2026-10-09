import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LegacyPlanHistory } from "../components/LegacyPlanHistory";
import { formatMoney } from "../lib/money";

const item = { id: 1, serviceName: "علاج تاريخي", toothCode: 36, totalMinor: 300_000,
  legacyCoverageState: "verified" as const,
  legacyCoverageSite: { mode: "per_tooth_episode" as const, toothCode: 36, surfaces: null, episodeTeeth: null, scope: null },
  legacyCurrentConsentRequired: false, legacyAgreementId: 5, legacyAgreementStatus: "live" as "live" | "void", billingStatus: "included_in_package" };
const render = (patch = {}, financial = true, consented = false) => renderToStaticMarkup(createElement(LegacyPlanHistory,
  { items: [{ ...item, ...patch }], currency: "YER", canSeeFinancial: financial, consented }));

describe("historical plan presentation", () => {
  it("labels 300,000 as agreed history while stating that progress and historical sessions are not known", () => {
    const html = render();
    expect(html).toContain(formatMoney(300_000, "YER"));
    expect(html).toContain("المتفق عليه تاريخيًّا");
    expect(html).toContain("تقدّم العلاج السابق غير معلوم");
    expect(html).toContain("لا جلسات تاريخية مفترضة");
    expect(html).not.toContain("الجلسة المخططة");
    expect(html).not.toContain("أُنجز");
    expect(html).toContain("الموافقة الفعلية");
    expect(html).toContain("حفظ المسودة متاح");
  });
  it.each([
    { legacyAgreementStatus: "void", billingStatus: "needs_financial_review" },
    { legacyAgreementStatus: "live", billingStatus: "needs_financial_review" },
    { legacyAgreementStatus: undefined },
  ])("keeps review precedence for %j without implying released-to-rebill", (patch) => {
    const html = render(patch);
    expect(html).toContain("يحتاج مراجعة مالية");
    expect(html).toContain("لا تُنشأ فاتورة جديدة لهذا البند");
    expect(html).toContain("حفظ المسودة متاح");
    expect(html).not.toContain("مشمول بالاتفاق التاريخي الحيّ");
    expect(html).not.toContain("حُرِّرت تغطيته");
  });
  it("hides historical amounts without financial authority and respects existing genuine consent", () => {
    expect(render({}, false)).not.toContain(formatMoney(300_000, "YER"));
    expect(render({}, true, true)).not.toContain("يلزم استكمال الموافقة الفعلية");
  });
});

describe("full immutable agreement markup", () => {
  it("displays all episode teeth once and never multiplies the single historical amount", () => {
    const html = render({ toothCode: 14, legacyCoverageSite: { mode: "multi_tooth_episode", toothCode: 14,
      surfaces: null, episodeTeeth: [14, 15, 16], scope: null } });
    expect(html).toContain("أسنان الحلقة: 14، 15، 16");
    expect(html.split(formatMoney(300_000, "YER"))).toHaveLength(2);
    expect(html).not.toContain(formatMoney(900_000, "YER"));
    expect(html).toContain("تقدّم العلاج السابق غير معلوم");
    expect(html).not.toContain("الجلسة المخططة");
  });
  it.each(["unknown", "conflict", undefined])("does not claim covered or current consent for %s, even with stored consent", (state) => {
    const html = render({ legacyCoverageState: state, legacyCoverageSite: null, legacyCurrentConsentRequired: true }, true, true);
    expect(html).toContain(state === "conflict" ? "تعارض في بيانات التغطية" : "نطاق التغطية التاريخية غير معلوم");
    expect(html).toContain("تاريخ الموافقة المخزّن وحده لا يثبت موافقة حالية");
    expect(html).toContain("يحتاج مراجعة مالية");
    expect(html).not.toContain("مشمول بالاتفاق التاريخي الحيّ");
    expect(html).not.toContain("التغطية المحفوظة عند التسجيل");
    expect(html).not.toContain("سن 36");
  });
  it("still requires genuine current consent on a verified new snapshot", () => {
    expect(render({ legacyCurrentConsentRequired: true }, true, true)).toContain("يلزم استكمال الموافقة الفعلية");
    expect(render({ legacyCurrentConsentRequired: undefined }, true, true)).toContain("يلزم استكمال الموافقة الفعلية");
    expect(render({ legacyCurrentConsentRequired: false }, true, true)).not.toContain("يلزم استكمال الموافقة الفعلية");
  });
});
