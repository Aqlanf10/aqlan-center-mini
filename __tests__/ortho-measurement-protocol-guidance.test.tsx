import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OrthoAssessmentMeasurementsV2 } from "../components/OrthoAssessmentMeasurementsV2";
import { blankMeasurementEditorV2 } from "../lib/ortho-assessment-measurement-editor-v2";

// Real React render of the existing editor. Guidance must be present even while
// the draft is empty/read-only, before a clinician can enter a different span.
function render() {
  const draft = blankMeasurementEditorV2(), before = JSON.stringify(draft), change = vi.fn();
  const html = renderToStaticMarkup(createElement(OrthoAssessmentMeasurementsV2, { draft, onChange: change, sources: [] }));
  expect(JSON.stringify(draft)).toBe(before);
  expect(change).not.toHaveBeenCalled();
  return html;
}
describe("diagnostic measurement span guidance", () => {
  it("distinguishes the ten-tooth arch-space span from twelve-tooth Bolton overall", () => {
    const html = render();
    expect(html).toContain("Arch length discrepancy");
    expect(html).toContain("السطحين الأنسيين للرحى الأولى الدائمة");
    expect(html).toContain("عروض 10 أسنان");
    expect(html).toContain("لا تُضف عرض الرحى الأولى");
    expect(html).toContain("Bolton overall");
    expect(html).toContain("12 سناً في كل فك");
  });
  it("defines the discrepancy sign, actual units and a non-prescriptive reference", () => {
    const html = render();
    expect(html).toContain("المتاح ناقص المطلوب");
    expect(html).toContain("السالب عجز مسافة والموجب فائض مسافة");
    expect(html).toContain("نسبة السفلي إلى العلوي");
    expect(html).toContain("معايرة صالحة");
    expect(html).toContain("ليست حدوداً طبيعية لكل عمر أو جنس أو مجتمع");
  });
});
