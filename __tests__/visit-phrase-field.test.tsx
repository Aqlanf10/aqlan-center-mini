import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VisitPhraseField } from "../components/VisitPhraseField";
import { VisitPlanRequirements } from "../components/VisitPlanRequirements";

describe("visit phrase field uses one clinician-owned narrative", () => {
  it("starts with blank clinical text and never chooses a configured normal finding", () => {
    const onChange = vi.fn(), onPhrase = vi.fn();
    const html = renderToStaticMarkup(<VisitPhraseField label="الفحص" value="" disabled={false}
      phrases={["الأنسجة طبيعية", "فحص سريري آخر"]} onChange={onChange} onPhrase={onPhrase} />);
    expect(html).toContain('aria-label="الفحص"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<textarea[^>]*><\/textarea>/);
    expect(html).not.toContain("الأنسجة طبيعية");
    expect(onChange).not.toHaveBeenCalled(); expect(onPhrase).not.toHaveBeenCalled();
  });
  it("keeps the exact narrative and native disabled state on both textarea and phrase trigger", () => {
    const html = renderToStaticMarkup(<VisitPhraseField label="الشكوى" value="نص الطبيب كما كتبه" maxLength={500}
      disabled phrases={["عبارة"]} onChange={vi.fn()} onPhrase={vi.fn()} />);
    expect(html).toContain("نص الطبيب كما كتبه");
    expect(html).toMatch(/<textarea[^>]*maxLength="500"[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-expanded="false"/);
  });
});

describe("plan requirement display is not clinical authority", () => {
  it.each(["cancelled", "in_progress"])("does not turn %s into completion or clinical consent", (status) => {
    const html = renderToStaticMarkup(<VisitPlanRequirements item={{ planItemId: 17, status, unmetRequirements: [] }} />);
    expect(html).toContain(status === "cancelled" ? "ملغى" : "قيد التنفيذ");
    expect(html).toContain("هذا لا يثبت اكتمال جميع الشروط");
    expect(html).toContain("تفاصيل البنود المرجعية وحالاتها غير متاحة");
    expect(html).not.toContain("حالة البند في المصدر: مكتمل");
    expect(html).not.toContain("الموافقة السريرية في المصدر: مسجلة");
  });
  it("preserves the exact server reason and original signature warning while allowing factual drafts", () => {
    const html = renderToStaticMarkup(<VisitPlanRequirements item={{ planItemId: 17, status: "planned", origin: "invoice",
      financialReviewRequired: true, clinicalConsentRecorded: false, unmetRequirements: ["انتظار تقييم البند #18"] }} />);
    expect(html).toContain("انتظار تقييم البند #18");
    expect(html).toContain("يمكن توثيق العمل كمسودة؛ يحتاج مراجعة مالية قبل التوقيع");
    expect(html).toContain("غير مسجلة");
    expect(html).not.toMatch(/<button|<input|<select/);
  });
  it("distinguishes missing evidence from verified empty or cleared requirements", () => {
    expect(renderToStaticMarkup(<VisitPlanRequirements />)).toContain("غير متاحة في قراءة الزيارة الحالية");
    const html = renderToStaticMarkup(<VisitPlanRequirements item={{ planItemId: 17, status: "pending", origin: "invoice" }} />);
    expect(html).toContain("تعذّر التحقق"); expect(html).toContain("غير معلومة");
    expect(html).not.toContain("جميع الشروط متحققة");
  });
});
