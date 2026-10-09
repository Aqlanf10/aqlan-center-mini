import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SummaryTab, type WorkflowSummary } from "../components/patient/SummaryTab";
import { formatMoney } from "../lib/money";

// Test the real Summary markup while keeping network-owning leaves out of SSR.
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/ReceiptCorrectionLauncher", () => ({ ReceiptCorrectionLauncher: () => null }));
vi.mock("../components/PortalInviteRow", () => ({ PortalInviteRow: () => createElement("div", { "data-testid": "portal-invite" }) }));
vi.mock("../components/patient/PatientTimeline", () => ({ PatientTimeline: () => createElement("div", { "data-testid": "timeline" }) }));
vi.mock("../components/patient/PatientIntakeHistory", () => ({ PatientIntakeHistory: () => createElement("section", { "data-testid": "intake-history" }, "Self-reported medical information") }));

const noop = () => undefined;
const summary: WorkflowSummary = {
  openVisit: null, lastVisit: null, nextAppointment: null, activePlans: [],
  plannedVisits: [{ id: 71, planTitle: "خطة اصطناعية", sequence: 1, title: "جلسة اصطناعية",
    doctorName: null, durationMinutes: 30, status: "planned", appointmentDate: null, appointmentTime: null, note: null }],
  counts: { visits: 0, openLabOrders: 0, documents: 0, orthoCase: false },
  financial: null, alerts: [{ kind: "medical", severity: "danger", text: "تحذير يحتاج المراجعة" }], canSeeFinancial: false,
};
function render(patch: Partial<WorkflowSummary> = {}) {
  return renderToStaticMarkup(createElement(SummaryTab, {
    summary: { ...summary, ...patch }, patientId: 91, patientName: "مريض اصطناعي", patientNumber: "SYNTH-91", patientPhone: null,
    base: "YER", onVisitStarted: noop, onChanged: noop, onGoToTab: noop,
    patientDetails: createElement("div", { "data-testid": "contact-family" }, "Existing patient editors"),
  }));
}
function before(html: string, first: string, second: string) {
  expect(html.indexOf(first)).toBeGreaterThanOrEqual(0);
  expect(html.indexOf(second)).toBeGreaterThan(html.indexOf(first));
}

describe("task-first Summary presentation", () => {
  it("keeps safety, shortcuts and planned work before secondary administration", () => {
    const html = render();
    before(html, "تحذير يحتاج المراجعة", 'data-testid="summary-current-work"');
    before(html, 'data-testid="summary-open-ortho"', 'data-testid="summary-administrative-details"');
    before(html, 'data-testid="summary-current-work"', "الجلسات المخطَّطة (1)");
    before(html, "الجلسات المخطَّطة (1)", 'data-testid="intake-history"');
    before(html, 'data-testid="intake-history"', 'data-testid="summary-administrative-details"');
    before(html, 'data-testid="summary-administrative-details"', 'data-testid="timeline"');
    expect(html).toContain('href="/print/patient-card/91"');
    expect(html).toContain('data-testid="contact-family"');
    expect(html).toContain('data-testid="portal-invite"');
    const disclosure = html.match(/<details[^>]*data-testid="summary-administrative-details"[^>]*>/)?.[0];
    expect(disclosure).toBeTruthy();
    expect(disclosure).not.toMatch(/\bopen(?:=|\s|>)/);
    // Self-reported health information is not concealed by this disclosure.
    expect(html.indexOf('data-testid="intake-history"')).toBeLessThan(html.indexOf("<details"));
  });

  it("retains no-appointment/no-plan states without inventing clinical or financial work", () => {
    const html = render({ plannedVisits: [], alerts: [] });
    expect(html).toContain("لا يوجد موعد قادم");
    expect(html).toContain("لا خطة جارية");
    expect(html).toContain("لا جلسة مخطَّطة");
    expect(html).not.toContain('aria-label="الحساب"');
    expect(html).not.toContain("تحصيل دفعة");
    expect(html).not.toContain("ابدأ الزيارة");
  });

  it("preserves existing historical labels and native currency values unchanged", () => {
    const row = { balanceMinor: 180000, invoicedMinor: 0, paidMinor: 0, openingMinor: 180000,
      agreedMinor: 300000, treatmentDoneMinor: 0, remainingTreatmentMinor: 0,
      agreementPaidMinor: 120000, agreementRemainingMinor: 180000,
      clinicalProgress: { historicalItems: 1, knownItems: 0, knownDoneItems: 0, knownDoneMinor: 0, knownRemainingMinor: 0 } };
    const sar = { ...row, balanceMinor: 2300, openingMinor: 2300, agreedMinor: 3000, agreementPaidMinor: 700, agreementRemainingMinor: 2300 };
    const zero = { balanceMinor: 0, invoicedMinor: 0, paidMinor: 0, openingMinor: 0, agreedMinor: 0, treatmentDoneMinor: 0, remainingTreatmentMinor: 0 };
    const financial = { ...row, byCurrency: { YER: row, SAR: sar, USD: zero } };
    const original = JSON.stringify(financial);
    const html = render({ financial, canSeeFinancial: true });
    expect(html).toContain(formatMoney(180000, "YER"));
    expect(html).toContain(formatMoney(2300, "SAR"));
    expect(html).toContain("الباقي السريري غير معلومين");
    expect(html).not.toContain("علاج غير منفّذ");
    expect(html).not.toContain(formatMoney(182300, "YER"));
    expect(JSON.stringify(financial)).toBe(original);
  });
});
