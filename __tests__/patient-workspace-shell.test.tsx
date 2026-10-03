import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PatientWorkspace } from "../components/patient-workspace/PatientWorkspace";

const fixture = vi.hoisted(() => ({ role: "doctor", permissions: {} as Record<string, boolean>, available: true, financial: false }));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ username: "synthetic", role: fixture.role, permissions: fixture.permissions }) }));
vi.mock("../components/PatientContactPanel", () => ({ PatientFlagChips: () => null }));
vi.mock("../components/patient-workspace/usePatientWorkspace", () => ({ usePatientWorkspace: () => ({
  file: fixture.available ? { patient: { id: 91, fullName: "مريض اختبار الواجهة", patientNumber: "UI-91", gender: "unknown", phone: null, birthYear: null, birthDate: null, medicalAlert: null }, visits: [], appointments: [] } : null,
  summary: { planVisible: true, canSeeFinancial: fixture.financial, activePlans: [], plannedVisits: [], counts: { visits: 0, openLabOrders: 0, documents: 0, orthoCase: false }, openVisit: null, today: "2026-10-03" },
  loading: !fixture.available, error: null, summaryError: null, confirmedAlert: undefined, reload: vi.fn(), updatePatient: vi.fn(), confirmMedicalAlert: vi.fn(),
}) }));
vi.mock("../components/patient-workspace/usePatientReadiness", () => ({ usePatientReadiness: () => ({ visit: null, alerts: [], readinessKnown: false, chairsKnown: false, busy: false, message: null, active: false, statusLine: "لا زيارة اليوم", freeChairs: [], selectedChair: null, canEnterChair: false, clear: vi.fn(), enterChair: vi.fn(), setChair: vi.fn() }) }));
vi.mock("../components/patient-workspace/WorkspaceSections", () => ({ WorkspaceSectionContent: ({ section, canViewProfitability, isAdministrator }: { section: string; canViewProfitability: boolean; isAdministrator: boolean }) => <div data-section={section} data-can-profit={String(canViewProfitability)} data-admin={String(isAdministrator)} /> }));
vi.mock("../components/patient-workspace/WorkspaceDialogs", () => ({ WorkspaceDialogs: () => null }));
beforeEach(() => { fixture.role = "doctor"; fixture.permissions = {}; fixture.available = true; fixture.financial = false; });

describe("single rebuilt patient shell", () => {
  it("renders one identity/safety header, grouped RTL navigation and native mobile selector", () => {
    const html = renderToStaticMarkup(<PatientWorkspace id="91" />);
    expect((html.match(/data-testid="patient-workspace-header"/g) ?? []).length).toBe(1);
    expect(html).toContain('dir="rtl"'); expect(html).toContain('data-testid="workspace-mobile-navigation"');
    expect(html).toContain("مريض اختبار الواجهة"); expect(html).toContain("UI-91");
    expect(html).toContain("عدم ظهور تنبيه لا يؤكد اكتمال المراجعة");
  });
  it("does not mount an account or profitability grant from a denied financial read", () => {
    const html = renderToStaticMarkup(<PatientWorkspace id="91" />);
    expect(html).not.toContain('data-testid="workspace-nav-account"');
    expect(html).toContain('data-can-profit="false"'); expect(html).toContain('data-admin="false"');
  });
  it("financial overview permission alone cannot grant profitability or administration", () => {
    fixture.financial = true;
    const html = renderToStaticMarkup(<PatientWorkspace id="91" />);
    expect(html).toContain('data-testid="workspace-nav-account"');
    expect(html).toContain('data-can-profit="false"'); expect(html).toContain('data-admin="false"');
  });
  it("grants explicitly permitted profitability while leaving administration unavailable", () => {
    fixture.permissions = { canViewCostPrices: true, canViewClinicProfits: true };
    const html = renderToStaticMarkup(<PatientWorkspace id="91" />);
    expect(html).toContain('data-can-profit="true"'); expect(html).toContain('data-admin="false"');
  });
  it("limits assistant navigation to the existing Today scope", () => {
    fixture.role = "assistant";
    const html = renderToStaticMarkup(<PatientWorkspace id="91" />);
    expect(html).toContain('data-testid="workspace-nav-today"');
    for (const section of ["identity", "account", "plans", "files", "reports", "specialties"]) expect(html).not.toContain(`data-testid="workspace-nav-${section}"`);
  });
  it("handles loading before identity without rendering fictitious patient information", () => {
    fixture.available = false;
    const html = renderToStaticMarkup(<PatientWorkspace id="91" />);
    expect(html).toContain("جارٍ تحميل ملف المريض"); expect(html).not.toContain("UI-91");
  });
  it("prevents restricted financial roles from mounting clinical workspace", () => {
    fixture.role = "cashier";
    const html = renderToStaticMarkup(<PatientWorkspace id="91" />);
    expect(html).toContain("الملف السريري غير متاح لهذا الدور"); expect(html).not.toContain("UI-91");
  });
});
