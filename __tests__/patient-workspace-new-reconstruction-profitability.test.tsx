import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CaseProfitabilityModal } from "../components/CaseProfitabilityModal";

describe("new patient profitability reconstruction", () => {
  it("keeps empty patient simulation distinct from zero real-world revenue", () => {
    const html = renderToStaticMarkup(<CaseProfitabilityModal emptyStart patientId={91} patientName="هوية حقيقية للاختبار" patientNumber="REC-91" procedures={[]} onClose={vi.fn()} />);
    expect(html).toContain("هوية حقيقية للاختبار"); expect(html).toContain("لا توجد نتيجة ربحية محسوبة");
    expect(html).not.toContain("تاج زركونيا سن داعم"); expect(html).not.toContain("هامش المساهمة:"); expect(html).not.toContain("نماذج الحالات السريرية الجاهزة");
  });
  it("treats explicit empty procedures as empty even without the new option", () => {
    const html = renderToStaticMarkup(<CaseProfitabilityModal procedures={[]} onClose={vi.fn()} />);
    expect(html).toContain("لا توجد نتيجة ربحية محسوبة"); expect(html).not.toContain('value="تاج زركونيا سن داعم');
  });
  it("preserves omitted-procedures standalone demo behavior", () => {
    const html = renderToStaticMarkup(<CaseProfitabilityModal onClose={vi.fn()} />);
    expect(html).toContain("تاج زركونيا سن داعم"); expect(html).toContain("هامش المساهمة:");
  });
});
