/** NEW RECONSTRUCTION: SSR/handler checks are not browser or visual acceptance. */
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHeader } from "../components/patient-workspace/WorkspaceHeader";
import { WorkspaceOverview } from "../components/patient-workspace/WorkspaceOverview";
import { WorkspaceDialogs } from "../components/patient-workspace/WorkspaceDialogs";
import type { Patient } from "../lib/patient";
import type { WorkspaceSummary } from "../components/patient-workspace/usePatientWorkspace";
import type { usePatientReadiness } from "../components/patient-workspace/usePatientReadiness";

const dialogs = vi.hoisted(() => ({ rx: vi.fn(), consent: vi.fn(), book: vi.fn(), vitals: vi.fn(), profit: vi.fn(), postop: vi.fn() }));
vi.mock("../components/PatientContactPanel", () => ({ PatientFlagChips: () => null }));
vi.mock("../components/PrescriptionModal", () => ({ PrescriptionModal: (props: unknown) => { dialogs.rx(props); return null; } }));
vi.mock("../components/ConsentModal", () => ({ ConsentModal: (props: unknown) => { dialogs.consent(props); return null; } }));
vi.mock("../components/QuickAppointmentModal", () => ({ QuickAppointmentModal: (props: unknown) => { dialogs.book(props); return null; } }));
vi.mock("../components/VitalsModal", () => ({ VitalsModal: (props: unknown) => { dialogs.vitals(props); return null; } }));
vi.mock("../components/CaseProfitabilityModal", () => ({ CaseProfitabilityModal: (props: unknown) => { dialogs.profit(props); return null; } }));
vi.mock("../components/PostOpModal", () => ({ PostOpModal: (props: unknown) => { dialogs.postop(props); return null; } }));
const patient: Patient = { id: 91, patientNumber: "REC-0091", fullName: "مريض اختبار فقط", phone: null, altPhone: null, gender: "unknown", birthYear: null, address: null, medicalAlert: null, note: null, createdAt: "2026-10-03" };
const summary: WorkspaceSummary = { planVisible: true, openVisit: null, lastVisit: null, nextAppointment: null, activePlans: [], plannedVisits: [], counts: { visits: 0, openLabOrders: 0, documents: 0, orthoCase: false }, financial: null, canSeeFinancial: false, alerts: [], today: "2026-10-03" };
const readiness: ReturnType<typeof usePatientReadiness> = { visit: null, alerts: [], readinessKnown: false, chairsKnown: false, busy: false, message: null, active: false, statusLine: "حالة الزيارة قيد التحقق", freeChairs: [], selectedChair: null, canEnterChair: false, clear: vi.fn(async () => {}), enterChair: vi.fn(async () => {}), setChair: vi.fn(), reload: vi.fn(async () => null) };
function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [{ type: node.type, props: node.props }, ...elements(node.props.children as ReactNode)];
}
const dialogProps = { authorityKey: "doctor:synthetic:no-money", patient, openVisitId: 301, canWrite: true, canEditPatient: true, canViewProfitability: false, onClose: vi.fn(), onChanged: vi.fn(), onMedicalSaved: vi.fn(), onConsentDraft: vi.fn(), onConsentGuard: vi.fn() };
beforeEach(() => vi.clearAllMocks());
describe("new reconstructed workspace surfaces", () => {
  it("has one contextual identity and does not claim absence of alerts establishes safety", () => {
    const html = renderToStaticMarkup(<WorkspaceHeader patient={patient} today="2026-10-03" readiness={readiness} canEdit canOperate onBook={vi.fn()} onNavigate={vi.fn()} onVitals={vi.fn()} />);
    expect(html).toContain("REC-0091"); expect(html).toContain("رقم الملف"); expect(html).toContain("عدم ظهور تنبيه لا يؤكد اكتمال المراجعة"); expect(html).toContain("حالة الزيارة قيد التحقق"); expect(html).not.toContain("جاهز ✓");
  });
  it("uses provided guarded navigation callbacks rather than location assignment", () => {
    const onNavigate = vi.fn(); const onBook = vi.fn(); const onVitals = vi.fn();
    const tree = WorkspaceHeader({ patient, today: "2026-10-03", readiness, canEdit: true, canOperate: true, onNavigate, onBook, onVitals });
    const buttons = elements(tree).filter((node) => node.type === "button");
    buttons.forEach((node) => (node.props.onClick as () => void)());
    expect(onBook).toHaveBeenCalledOnce(); expect(onVitals).toHaveBeenCalledOnce(); expect(onNavigate.mock.calls).toEqual([["today"], ["identity"]]);
  });
  it("omits write controls when capability flags are absent", () => {
    const html = renderToStaticMarkup(<WorkspaceHeader patient={patient} today="2026-10-03" readiness={readiness} canEdit={false} canOperate={false} onBook={vi.fn()} onNavigate={vi.fn()} onVitals={vi.fn()} />);
    expect(html).not.toContain("حجز موعد"); expect(html).not.toContain("إدخال إلى الكرسي"); expect(html).not.toContain(">العلامات الحيوية<");
  });
  it("distinguishes unloaded overview from empty records and keeps explicit retry", () => {
    const html = renderToStaticMarkup(<WorkspaceOverview patient={patient} summary={null} onNavigate={vi.fn()} onChanged={vi.fn()} />);
    expect(html).toContain("الملخص غير متاح الآن"); expect(html).not.toContain("لا توجد خطة نشطة"); expect(html).toContain("إعادة تحميل الملخص");
  });
  it("never displays supplied money when the canonical financial capability is denied", () => {
    const hidden = { ...summary, financial: { balanceMinor: 987654321 } } as WorkspaceSummary;
    const html = renderToStaticMarkup(<WorkspaceOverview patient={patient} summary={hidden} onNavigate={vi.fn()} onChanged={vi.fn()} />);
    expect(html).toContain("البيانات المالية غير متاحة"); expect(html).not.toContain("987"); expect(html).not.toContain("الحساب والدفعات");
  });
  it("distinguishes a withheld plan from no active plan", () => {
    const html = renderToStaticMarkup(<WorkspaceOverview patient={patient} summary={{ ...summary, planVisible: false }} onNavigate={vi.fn()} onChanged={vi.fn()} />);
    expect(html).toContain("تفاصيل الخطط غير متاحة"); expect(html).not.toContain("لا توجد خطة نشطة"); expect(html).not.toContain("مراجعة الخطط");
  });
  it("keeps general prescriptions patient-only and does not infer visit or provider", () => {
    renderToStaticMarkup(<WorkspaceDialogs {...dialogProps} action="prescription" />);
    expect(dialogs.rx).toHaveBeenCalledOnce(); const props = dialogs.rx.mock.calls[0][0];
    expect(props.patientId).toBe(91); expect(props.isOpen).toBe(true); expect(props).not.toHaveProperty("visitId"); expect(props).not.toHaveProperty("defaultDoctorName");
  });
  it("preserves consent authority and real draft/guard registrations", () => {
    renderToStaticMarkup(<WorkspaceDialogs {...dialogProps} action="consent" />);
    const props = dialogs.consent.mock.calls[0][0]; expect(props.authorityKey).toBe(dialogProps.authorityKey); expect(props.onDraftChange).toBe(dialogProps.onConsentDraft); expect(props.onNavigationGuardChange).toBe(dialogProps.onConsentGuard);
  });
  it("permits booking without granting denied identity editing", () => {
    renderToStaticMarkup(<WorkspaceDialogs {...dialogProps} action="book" canEditPatient={false} />);
    expect(dialogs.book.mock.calls[0][0].isOpen).toBe(true); expect(dialogs.vitals).not.toHaveBeenCalled();
  });
  it("does not mount profitability from ordinary patient access", () => {
    renderToStaticMarkup(<WorkspaceDialogs {...dialogProps} action="profitability" />); expect(dialogs.profit).not.toHaveBeenCalled();
  });
  it("explicitly opts into empty patient simulation only after its permission check", () => {
    renderToStaticMarkup(<WorkspaceDialogs {...dialogProps} action="profitability" canViewProfitability />);
    expect(dialogs.profit.mock.calls[0][0]).toMatchObject({ emptyStart: true, procedures: [], patientId: 91, patientNumber: "REC-0091" });
  });
  it("does not fabricate local-only treatment persistence in tablet mode", () => {
    const html = renderToStaticMarkup(<WorkspaceDialogs {...dialogProps} action="tablet" />);
    expect(html).toContain("أكمل العمل في زيارة اليوم"); expect(html).toContain("لا يحفظ هذه الاختيارات"); expect(html).not.toContain("تم تسجيل إجراء");
  });
});
