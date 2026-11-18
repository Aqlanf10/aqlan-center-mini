import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrthoWireTimeline } from "../components/OrthoWireTimeline";
import { AdjustmentForm } from "../components/PatientOrtho";

/** OW-1 presentation after the owner's redesign (#483 6993812820). Synthetic data only. */
type Props = ComponentProps<typeof OrthoWireTimeline>;
const adjustments: Props["adjustments"] = [
  { id: 3, doneOn: "2026-03-01", phase: null, upperWire: null, lowerWire: "016 NiTi", elastics: "class_ii", elasticNote: "3/16" },
  { id: 2, doneOn: "2026-02-01", phase: null, upperWire: null, lowerWire: null, elastics: "none", elasticNote: null },
  { id: 1, doneOn: "2026-01-04", phase: "aligning", upperWire: "016 NiTi", lowerWire: "014 NiTi", elastics: "none", elasticNote: null },
];
const props: Props = {
  slot: "022", appliance: "fixed_metal", arches: "both", upperWire: null, lowerWire: "016 NiTi", closed: false,
  adjustments, documentedWireRemovals: [{ adjustmentId: 3, arch: "upper" }],
};
const html = (extra: Partial<Props> = {}) => renderToStaticMarkup(createElement(OrthoWireTimeline, { ...props, ...extra }));
const tableRows = (out: string) => out.split("<tbody>")[1].split("</tbody>")[0].split("</tr>").filter(Boolean);
const date = (value: string) => `<bdi dir="ltr" class="tabular-nums">${value}</bdi>`;

describe("OrthoWireTimeline — session rows (OW-1 redesign)", () => {
  it("puts a small summary of the last documented wire per arch above the sessions", () => {
    const out = html();
    const summary = out.split('data-testid="wire-summary"')[1].split("<table")[0];
    expect(summary).toContain("الفك العلوي");
    expect(summary).toContain("بلا سلك — إزالة موثّقة");
    expect(summary).toContain("الفك السفلي");
    expect(summary).toContain(">016 NiTi</bdi>");
    expect(summary).toContain(`أول تسجيل موثّق: ${date("2026-03-01")}`);
    expect(summary).toContain("الفترة الموثّقة: أقل من أسبوع");
    expect(out.indexOf('data-testid="wire-summary"')).toBeLessThan(out.indexOf('data-testid="wire-sessions-table"'));
  });

  it("renders one table row per session, newest first, with fixed upper/lower/elastics columns", () => {
    const out = html();
    for (const head of ["التاريخ", "العلوي", "السفلي", "المطاط"]) expect(out).toContain(`<th class="p-2 font-bold">${head}</th>`);
    const rows = tableRows(out);
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.match(/\d{4}-\d{2}-\d{2}/)?.[0])).toEqual(["2026-03-01", "2026-02-01", "2026-01-04"]);
    expect(rows[0]).toContain("إزالة موثّقة");
    expect(rows[0]).toContain(">016 NiTi</bdi>");
    expect(rows[0]).toContain(">تغيير<");
    expect(rows[2]).toContain("أول تسجيل");
  });

  it("a session without a recorded wire says «بلا تغيير» quietly and names no wire", () => {
    const quiet = tableRows(html())[1];
    expect(quiet.match(/بلا تغيير/g)).toHaveLength(3);
    expect(quiet).not.toContain("NiTi");
    expect(quiet).toContain('class="text-slate-400">بلا تغيير');
  });

  it("stacks sessions vertically for mobile: date first, then upper, lower and elastics", () => {
    const out = html();
    expect(out).toContain('class="space-y-2 sm:hidden" data-testid="wire-sessions-list"');
    expect(out).toContain('class="hidden w-full text-right text-xs sm:table" data-testid="wire-sessions-table"');
    const first = out.split('data-testid="wire-sessions-list"')[1].split("</li>")[0];
    const order = ["2026-03-01", ">العلوي<", ">السفلي<", ">المطاط<"].map(token => first.indexOf(token));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("never invents a date or duration language", () => {
    const out = html();
    expect(out).not.toMatch(/تاريخ التركيب|مدة السلك|اقتراح|السلك التالي/);
    expect(out).toContain("<details open");
  });

  it("without removal evidence says so and shows no removal", () => {
    const out = html({ documentedWireRemovals: undefined });
    expect(out).toContain("دليل إزالة السلك غير متاح في هذه القراءة");
    expect(out).not.toContain("إزالة موثّقة");
  });

  it("shows the 100-session banner and a case/last-session mismatch; closed cases start collapsed", () => {
    const out = html({ hasMore: true, upperWire: "019×025 SS", closed: true, documentedWireRemovals: [] });
    expect(out).toContain("يُعرض آخر 100 جلسة فقط؛ أقدم الجلسات غير معروضة.");
    expect(out).toContain("الفك العلوي — سلك الحالة:");
    expect(out).not.toContain("<details open");
  });

  it("appliances without archwires show only a neutral line", () => {
    const out = html({ appliance: "aligners" });
    expect(out).toContain("هذا الجهاز لا يستخدم أسلاكًا.");
    expect(out).not.toContain("مسار الأسلاك");
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
    expect(withEvidence).not.toContain("مسار الأسلاك");
  });
});
