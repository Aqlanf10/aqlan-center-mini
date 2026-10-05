import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdjustmentForm, OrthoComparison } from "../components/PatientOrtho";

type Case = ComponentProps<typeof AdjustmentForm>["caseRow"];
const history = [{ id: 91, visitId: null, visitSigned: false, doneOn: "2026-10-01", phase: "aligning",
  upperWire: "014 NiTi", lowerWire: null, elastics: "none", elasticNote: null, done: "Synthetic clinical adjustment",
  nextWeeks: 4, note: null, recordedBy: "synthetic",
  photos: [{ id: 92, title: "Synthetic private image", isImage: true, photoStage: "initial", photoView: "intraoral_frontal", takenOn: "2026-10-01" }],
}] satisfies Case["adjustments"];
const base: Case = {
  id: 9, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
  status: "active", phase: "aligning", startDate: "2026-10-01", plannedMonths: 18,
  upperWire: "014 NiTi", lowerWire: null, planId: null, retainer: null, retainerOn: null, note: null,
  closedAt: null, closedBy: null, closedNote: null, baselineKind: null, baselineRecordedAt: null,
  elastics: null, responsibleDoctorName: null, legacyFinancialMode: null, remainingObjectives: null,
  adjustments: history,
  progress: { monthsElapsed: 0, monthsPlanned: 18, monthsRemaining: 18, percent: 0,
    overdue: false, adjustments: 1, lastAdjustment: "2026-10-01", daysSinceLast: 2 },
};
function render(caseRow: Case) {
  return renderToStaticMarkup(createElement(AdjustmentForm, {
    caseRow, today: "2026-10-03", wires: [], patientId: 1, onSaved: () => {}, onError: () => {},
  }));
}

describe("ortho withheld-image presentation", () => {
  it("withholds the comparison gallery instead of asserting zero photos when access is denied", () => {
    const html = renderToStaticMarkup(createElement(OrthoComparison, {
      patientId: 1, orthoCaseId: 9, photosVisible: false,
    }));
    expect(html).toContain("صور الجلسات محجوبة حسب صلاحياتك");
    expect(html).not.toContain("صورة مسجلة");
    expect(html).not.toContain("التقط صورًا");
    expect(html).not.toContain("/api/documents/");
  });

  it.each([true, undefined])("retains the visible/legacy comparison (%s)", (photosVisible) => {
    const html = renderToStaticMarkup(createElement(OrthoComparison, { patientId: 1, orthoCaseId: 9, photosVisible }));
    expect(html).toContain("التوثيق الفوتوغرافي ومقارنة المراحل");
    expect(html).not.toContain("محجوبة حسب صلاحياتك");
  });

  it("labels explicit false as restricted and never infers missing images from the withheld history", () => {
    const hidden = { ...base, photosVisible: false,
      adjustments: [{ ...history[0], get photos(): Case["adjustments"][number]["photos"] {
        throw new Error("Withheld image history must not be inspected");
      } }],
    };
    const html = render(hidden);
    expect(html).toContain("صور الجلسات السابقة محجوبة حسب صلاحياتك");
    expect(html).toContain("لا يمكن تقييم اكتمال التوثيق الصوري");
    expect(html).not.toContain("ناقص:");
    expect(html).not.toContain("Synthetic private image");
    expect(html).toContain("ما نُفّذ");
    // Read denial does not grant or revoke the separately guarded upload permission.
    expect(html).toContain("كاميرا الجلسة");
  });

  it.each([true, undefined])("keeps standalone pre-activation history informationally unknown (%s)", (photosVisible) => {
    // Static rendering does not run the existing PR250 layout activation. Neither
    // a supplied album nor an empty array is a current authorized read here.
    for (const adjustments of [base.adjustments, []]) {
      const html = render({ ...base, photosVisible, adjustments });
      expect(html).not.toContain("محجوبة حسب صلاحياتك");
      expect(html).toContain('data-testid="ortho-photo-history-unknown"');
      expect(html).toContain("لا يعني ذلك عدم وجود صور");
      expect(html).not.toContain("ناقص:");
      expect(html).toContain("ما نُفّذ");
      expect(html).toContain("كاميرا الجلسة");
    }
  });
});
