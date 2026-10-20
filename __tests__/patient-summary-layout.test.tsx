import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SummaryTab, type WorkflowSummary } from "../components/patient/SummaryTab";
import { PatientCockpit } from "../components/patient/PatientCockpit";
import { formatMoney } from "../lib/money";

// Test the real Summary markup while keeping network-owning leaves out of SSR.
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/ReceiptCorrectionLauncher", () => ({ ReceiptCorrectionLauncher: () => null }));
vi.mock("../components/PortalInviteRow", () => ({ PortalInviteRow: () => createElement("div", { "data-testid": "portal-invite" }) }));
vi.mock("../components/patient/PatientTimeline", () => ({ PatientTimeline: () => createElement("div", { "data-testid": "timeline" }) }));
vi.mock("../components/patient/PatientIntakeHistory", () => ({ PatientIntakeHistory: () => createElement("section", { "data-testid": "intake-history" }, "Self-reported medical information") }));
vi.mock("../components/SettingsProvider", () => ({ useChairCount: () => 3 }));
const cockpit = vi.hoisted(() => ({ unavailable: false,
  alerts: ["تحذير طبي ظاهر", "تحذير طبي ثانٍ", "تحذير طبي ثالث لا يُخفى في عنوان"] }));
vi.mock("../components/patient/usePatientCockpitReadiness", () => ({ usePatientCockpitReadiness: () => ({
  visit: null, alerts: cockpit.alerts, readiness: cockpit.unavailable ? "unavailable" : "ready",
  chairsState: cockpit.unavailable ? "unavailable" : "ready", coherent: !cockpit.unavailable,
  canOperate: true, active: false, freeChairs: [1], selectedChair: 1, busy: false, message: null,
  canEnterChair: !cockpit.unavailable, setChair: () => undefined, reload: () => undefined,
  clear: () => undefined, enterChair: () => undefined,
}) }));

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
  }));
}
function before(html: string, first: string, second: string) {
  expect(html.indexOf(first)).toBeGreaterThanOrEqual(0);
  expect(html.indexOf(second)).toBeGreaterThan(html.indexOf(first));
}

describe("restored patient Summary presentation", () => {
  it("retains the original compact identity and actions with complete warnings and unknown-state feedback", () => {
    const props = {
      patientId: 91, patientName: "مريض اصطناعي", patientPhone: null, fallbackAlert: null,
      summary: null, onOpenTab: noop, onChanged: noop, compact: true,
      identity: createElement("h1", null, "مريض اصطناعي"),
      primaryAction: createElement("button", { "data-testid": "synthetic-primary" }, "المهمة الحالية"),
      secondaryActions: createElement("button", null, "بيانات المريض والإجراءات"),
    };
    cockpit.unavailable = false;
    const html = renderToStaticMarkup(createElement(PatientCockpit, props));
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html.match(/data-testid="synthetic-primary"/g)).toHaveLength(1);
    expect(html).toContain("بيانات المريض والإجراءات");
    expect(html).toContain("إدخال إلى الكرسي");
    expect(html).toContain("bg-brand-orange");
    expect(html).toContain("تحذير طبي ظاهر");
    const expanded = renderToStaticMarkup(createElement(PatientCockpit, { ...props, compact: false }));
    expect(expanded).toContain(`⚠️ ${cockpit.alerts.join(" • ")}`);
    cockpit.unavailable = true;
    const unavailable = renderToStaticMarkup(createElement(PatientCockpit, props));
    expect(unavailable).toContain("تعذّر التحقق من الزيارة؛ إدخال الكرسي متوقف حتى التحديث.");
    expect(unavailable).toContain("إعادة التحقق");
    expect(unavailable).toContain("تحذير طبي ظاهر");
    cockpit.unavailable = false;
  });

  it("restores visible intake/card/portal before current and planned work without hiding safety", () => {
    const html = render();
    before(html, "تحذير يحتاج المراجعة", 'data-testid="summary-current-work"');
    before(html, "تحذير يحتاج المراجعة", 'data-testid="intake-history"');
    before(html, 'data-testid="intake-history"', 'href="/print/patient-card/91"');
    before(html, 'href="/print/patient-card/91"', 'data-testid="portal-invite"');
    before(html, 'data-testid="portal-invite"', 'data-testid="summary-open-ortho"');
    before(html, 'data-testid="summary-open-ortho"', 'data-testid="summary-current-work"');
    before(html, 'data-testid="summary-current-work"', "الجلسات المخطَّطة (1)");
    before(html, "الجلسات المخطَّطة (1)", 'data-testid="timeline"');
    expect(html).toContain('href="/print/patient-card/91"');
    expect(html).toContain('data-testid="portal-invite"');
    expect(html).not.toContain('data-testid="summary-administrative-details"');
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
      approvedAgreements: { count: 1, available: true, reviewCount: 0, totalMinor: 300000, paidMinor: 120000, remainingMinor: 180000, dueNowMinor: 0 }, classicInstallments: null,
      clinicalProgress: { historicalItems: 1, knownItems: 0, knownDoneItems: 0, knownDoneMinor: 0, knownRemainingMinor: 0 } };
    const sar = { ...row, balanceMinor: 2300, openingMinor: 2300, agreedMinor: 3000, approvedAgreements: { ...row.approvedAgreements, totalMinor: 3000, paidMinor: 700, remainingMinor: 2300 } };
    const zero = { balanceMinor: 0, invoicedMinor: 0, paidMinor: 0, openingMinor: 0, agreedMinor: 0, treatmentDoneMinor: 0, remainingTreatmentMinor: 0, approvedAgreements: null, classicInstallments: null };
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

  const zero = { balanceMinor: 0, invoicedMinor: 0, paidMinor: 0, openingMinor: 0,
    agreedMinor: 0, treatmentDoneMinor: 0, remainingTreatmentMinor: 0, approvedAgreements: null, classicInstallments: null };
  it("separates the approved trio, planned work, and the classic reference without mixing currencies", () => {
    const sar = { ...zero, balanceMinor: 100000, agreedMinor: 220000, remainingTreatmentMinor: 220000,
      approvedAgreements: { count: 1, available: true, reviewCount: 0, totalMinor: 150000, paidMinor: 50000, remainingMinor: 100000, dueNowMinor: 25000 },
      agreementPaidMinor: 876543, agreementRemainingMinor: 987654,
      classicInstallments: { count: 1, totalMinor: 30000, paidMinor: 10000, remainingMinor: 20000 } };
    const html = render({ financial: { ...zero, byCurrency: { YER: { ...zero, agreedMinor: 300000 }, SAR: sar, USD: zero } }, canSeeFinancial: true });
    expect(html).toContain("القيمة المخططة للعلاج الجاري");
    expect(html).toContain("الاتفاقات المالية المعتمدة");
    expect(html).toContain("مرجع خطط التقسيط غير المعتمدة مالياً");
    for (const [label, value] of [["قيمة العلاج المعتمدة", 150000], ["المسدّد من الاتفاق المعتمد", 50000], ["المتبقي من الاتفاق المعتمد", 100000], ["المستحق حسب جدول الاتفاق", 25000]] as const) {
      expect(html).toContain(`${label}</dt><dd class="mt-0.5 font-extrabold text-navy-900">${formatMoney(value, "SAR")}</dd>`);
    }
    expect(html).not.toContain(formatMoney(520000, "YER"));
    expect(html).not.toContain(formatMoney(876543, "SAR"));
    expect(html).not.toContain(formatMoney(987654, "SAR"));
    expect(html).not.toContain("قيمة العلاج المتفق عليه");
  });

  it("retains a review-only currency even without any ledger or active-plan amounts", () => {
    const usd = { ...zero, approvedAgreements: { count: 1, available: false, reviewCount: 1,
      totalMinor: 150000, paidMinor: null, remainingMinor: null, dueNowMinor: null } };
    const html = render({ financial: { ...zero, byCurrency: { YER: zero, SAR: zero, USD: usd } }, canSeeFinancial: true });
    expect(html).toContain('data-testid="approved-agreement-summary" data-currency="USD"');
    expect(html).toContain(formatMoney(150000, "USD"));
    expect(html.match(/غير متاح حتى المراجعة/g)).toHaveLength(3);
    expect(html).toContain("مصدر اتفاق معتمد يحتاج مراجعة");
    expect(html).toContain(`رصيد دفتر الحساب: ${formatMoney(0, "USD")} · ملخص الاتفاقات يحتاج تحقق`);
    expect(html).not.toContain("المستحق الحالي مسدّد");
    expect(html).not.toContain("الاتفاق المعتمد محسوب في رصيد الحساب");
    expect(html).not.toContain("لا حركة مالية ولا خطط علاج في الملخص");
  });

  it("does not invent zero settlement for an older scalar response and honors the financial role gate", () => {
    const old = { balanceMinor: 0, invoicedMinor: 0, paidMinor: 0, openingMinor: 0,
      agreedMinor: 300000, treatmentDoneMinor: 0, remainingTreatmentMinor: 300000 } as NonNullable<WorkflowSummary["financial"]>;
    const html = render({ financial: old, canSeeFinancial: true });
    expect(html).toContain("ملخص الاتفاقات غير متاح");
    expect(html).not.toContain("المستحق الحالي مسدّد");
    expect(html).toContain(formatMoney(300000, "YER"));
    expect(html).not.toContain("قيمة العلاج المعتمدة");
    const hidden = render({ financial: old, canSeeFinancial: false });
    expect(hidden).not.toContain('aria-label="الحساب"');
    expect(hidden).not.toContain(formatMoney(300000, "YER"));
  });
});

