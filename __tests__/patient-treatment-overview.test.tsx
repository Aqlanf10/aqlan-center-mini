import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TreatmentChartWorkspace } from "../components/patient/TreatmentChartWorkspace";
import type { WorkflowSummary } from "../components/patient/SummaryTab";

function makeSummary(): WorkflowSummary {
  return {
    openVisit: null,
    lastVisit: null,
    nextAppointment: null,
    activePlans: [
      {
        id: 31, title: "خطة التقويم", specialty: "orthodontics",
        primaryDoctorName: "طبيب التقويم", consentAt: "2026-09-01",
        itemsCount: 4, doneItems: 1, totalMinor: 0, doneMinor: 0,
        remainingMinor: 0, nextDueDate: null, overdueMinor: 0,
      },
      {
        id: 44, title: "خطة علاج الجذور", specialty: "endodontics",
        primaryDoctorName: "طبيب الجذور", consentAt: "2026-09-03",
        itemsCount: 3, doneItems: 2, totalMinor: 0, doneMinor: 0,
        remainingMinor: 0, nextDueDate: null, overdueMinor: 0,
      },
    ],
    plannedVisits: [],
    counts: { visits: 0, openLabOrders: 0, documents: 0, orthoCase: true },
    financial: null,
    alerts: [],
    canSeeFinancial: false,
  };
}

function render(summary: WorkflowSummary | null) {
  return renderToStaticMarkup(createElement(TreatmentChartWorkspace, {
    patientId: 101,
    summary,
    onOpenPlans: () => {},
    onOpenOrtho: () => {},
    onOpenToday: () => {},
    onOpenFiles: () => {},
  }));
}

describe("patient treatment executive overview", () => {
  it("displays each active plan separately, without merging their progress", () => {
    const html = render(makeSummary());
    expect(html).toContain('data-testid="patient-active-plans"');
    expect(html).toContain("خطة التقويم");
    expect(html).toContain("خطة علاج الجذور");
    expect(html).toContain('aria-label="الخطة المعروضة بجانب مخطط الأسنان"');
    expect(html).toContain('<option value="31" selected="">خطة التقويم</option>');
    expect(html).toContain('<option value="44">خطة علاج الجذور</option>');
    expect(html).toContain("هذه نسبة الخطة المختارة فقط");
    // First plan = 1 / 4, not the combined (1+2) / (4+3) value.
    expect(html).toContain('aria-valuenow="25"');
    expect(html).not.toContain('aria-valuenow="43"');
  });

  it("does not invent a plan or a completion percentage on an unavailable read", () => {
    const html = render(null);
    expect(html).toContain("لا تتوفر بيانات موثوقة حالياً");
    expect(html).not.toContain('role="progressbar"');
    expect(html).not.toContain('data-testid="patient-active-plans"');
  });
});
