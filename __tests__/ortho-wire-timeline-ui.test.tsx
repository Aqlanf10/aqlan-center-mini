import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrthoWireTimeline } from "../components/OrthoWireTimeline";
import { AdjustmentForm } from "../components/PatientOrtho";

/** OW-1 presentation. Synthetic data only; the session form is not touched. */
type Props = ComponentProps<typeof OrthoWireTimeline>;
const adjustments: Props["adjustments"] = [
  { id: 3, doneOn: "2026-03-01", phase: null, upperWire: null, lowerWire: "014 NiTi", elastics: "class_ii", elasticNote: "3/16" },
  { id: 2, doneOn: "2026-02-01", phase: null, upperWire: null, lowerWire: "014 NiTi", elastics: "none", elasticNote: null },
  { id: 1, doneOn: "2026-01-04", phase: "aligning", upperWire: "016 NiTi", lowerWire: "014 NiTi", elastics: "none", elasticNote: null },
];
const props: Props = {
  slot: "022", appliance: "fixed_metal", arches: "both", upperWire: null, lowerWire: "014 NiTi", closed: false,
  adjustments, documentedWireRemovals: [{ adjustmentId: 3, arch: "upper" }],
};
const html = (extra: Partial<Props> = {}) => renderToStaticMarkup(createElement(OrthoWireTimeline, { ...props, ...extra }));

describe("OrthoWireTimeline (OW-1)", () => {
  it("shows documented labels, a documented removal, blank sessions as unchanged, and no invented dates", () => {
    const out = html();
    expect(out).toContain("الخط الزمني للأسلاك");
    expect(out).toContain('أول تسجيل موثّق: <bdi dir="ltr">2026-01-04</bdi>');
    expect(out).toContain('آخر جلسة موثّقة: <bdi dir="ltr">2026-02-01</bdi>');
    expect(out).toContain("جلسة واحدة دون إعادة إدخال السلك (بلا تغيير)");
    expect(out).toContain("إزالة موثّقة");
    expect(out).toContain("بلا سلك");
    expect(out).toContain("صنف ثانٍ — 3/16");
    expect(out).not.toMatch(/تاريخ التركيب|مدة السلك|اقتراح|السلك التالي/);
    expect(out).toContain("<details open");
  });

  it("without removal evidence says so and keeps blanks unchanged", () => {
    const out = html({ documentedWireRemovals: undefined });
    expect(out).toContain("دليل إزالة السلك غير متاح في هذه القراءة");
    expect(out).not.toContain("إزالة موثّقة");
  });

  it("renders the equivalent table with the documented columns", () => {
    const out = html({ initialView: "table" });
    for (const head of ["السلك", "أول تسجيل موثّق", "آخر جلسة موثّقة", "الفترة الموثّقة", "الجلسات", "الانتهاء"]) expect(out).toContain(`<th class="p-1">${head}</th>`);
    expect(out).toContain("عرض كخط زمني");
  });

  it("shows the 100-session banner, mismatch with the case wire, and collapses closed cases", () => {
    const out = html({ hasMore: true, upperWire: "019×025 SS", closed: true, documentedWireRemovals: [] });
    expect(out).toContain("يُعرض آخر 100 جلسة فقط؛ أقدم الجلسات غير معروضة.");
    expect(out).toContain("ضمن الجلسات المعروضة فقط");
    expect(out).toContain("الفك العلوي — الحالة: 019×025 SS · آخر جلسة: 016 NiTi");
    expect(out).not.toContain("<details open");
  });

  it("appliances without archwires show only a neutral line", () => {
    const out = html({ appliance: "aligners" });
    expect(out).toContain("هذا الجهاز لا يستخدم أسلاكًا.");
    expect(out).not.toContain("الخط الزمني للأسلاك");
  });

  it("the daily session form renders identically with or without removal evidence (no new step)", () => {
    type Case = ComponentProps<typeof AdjustmentForm>["caseRow"];
    const caseRow = {
      id: 9, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null, status: "active", phase: "aligning",
      startDate: "2026-01-01", plannedMonths: 18, upperWire: "016 NiTi", lowerWire: "014 NiTi", planId: null, retainer: null,
      retainerOn: null, note: null, closedAt: null, closedBy: null, closedNote: null, baselineKind: null, baselineRecordedAt: null,
      elastics: null, responsibleDoctorName: null, legacyFinancialMode: null, remainingObjectives: null,
      adjustments: [{ id: 1, visitId: null, visitSigned: false, doneOn: "2026-01-04", phase: "aligning", upperWire: "016 NiTi",
        lowerWire: "014 NiTi", elastics: "none", elasticNote: null, done: "Synthetic", nextWeeks: 4, note: null, recordedBy: "syn", photos: [] }],
      progress: { monthsElapsed: 0, monthsPlanned: 18, monthsRemaining: 18, percent: 0, overdue: false, adjustments: 1, lastAdjustment: "2026-01-04", daysSinceLast: 1 },
    } as Case;
    const form = (row: Case) => renderToStaticMarkup(createElement(AdjustmentForm, { caseRow: row, today: "2026-01-05", wires: [], patientId: 1, onSaved: () => {}, onError: () => {} }));
    const withEvidence = form({ ...caseRow, documentedWireRemovals: [{ adjustmentId: 1, arch: "upper" }] } as Case);
    expect(withEvidence).toBe(form(caseRow));
    expect(withEvidence).not.toContain("الخط الزمني للأسلاك");
  });
});
