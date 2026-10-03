import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/patients/[id]/workflow/route";
import { SummaryTab, type WorkflowSummary } from "../components/patient/SummaryTab";
import { WorkspaceOverview } from "../components/patient-workspace/WorkspaceOverview";
import { findUserByUsername, patientWorkflow } from "../lib/db";
import { formatMoney } from "../lib/money";

// Source-linked route regression: use the real patient-access guard with
// synthetic database facts, then render the actual SummaryTab projection.
const state = vi.hoisted(() => ({
  role: "doctor" as string | null,
  globalFinancial: false,
  payments: false,
  plans: true,
  owns: true,
  allPatients: false,
  active: true,
  userFound: true,
  lookupFails: false,
  todayVisit: true,
  patientFound: true,
  revokeDuringLookup: false,
  revokePlansDuringLookup: false,
  lookups: 0,
}));
vi.mock("../lib/session", () => ({
  requireSession: async () => state.role === null ? null : { username: "synthetic-doctor", role: state.role },
}));
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden",
  getSettings: async () => ({ "workflow.doctor_financial_view": String(state.globalFinancial) }),
  findUserByUsername: vi.fn(async () => {
    state.lookups += 1;
    if (state.lookupFails) throw new Error("synthetic lookup failure");
    return state.userFound ? {
      isActive: state.active, partyId: 7,
      permissions: {
        canViewAllPatients: state.allPatients,
        canViewPatientPayments: state.payments && !(state.revokeDuringLookup && state.lookups > 1),
        canViewPlans: state.plans && !(state.revokePlansDuringLookup && state.lookups > 1),
      },
    } : null;
  }),
  doctorOwnsPatient: async () => state.owns,
  doctorOwnedPatientIds: async () => new Set(state.owns ? [91] : []),
  patientHasVisitToday: async () => state.todayVisit,
  patientWorkflow: vi.fn(async () => ({ ...fixture, patient: state.patientFound ? fixture.patient : null })),
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => state.role ? { role: state.role } : null }));
vi.mock("../components/ReceiptCorrectionLauncher", () => ({ ReceiptCorrectionLauncher: () => null }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => <div data-testid="collection-modal" /> }));
vi.mock("../components/PortalInviteRow", () => ({ PortalInviteRow: () => null }));
vi.mock("../components/patient/PatientTimeline", () => ({ PatientTimeline: () => null }));
vi.mock("../components/patient/PatientIntakeHistory", () => ({ PatientIntakeHistory: () => null }));

const fixture: Omit<WorkflowSummary, "canSeeFinancial" | "planVisible"> & { patient: { id: number; medicalAlert: string } } = {
  appointmentVisibility: "all",
  patient: { id: 91, medicalAlert: "تنبيه طبي من ملف تجريبي" },
  openVisit: { id: 21, status: "in_chair", chair: 1, arrivedAt: "2026-10-03T00:00:00Z", plannedTitle: "جلسة سريرية" },
  lastVisit: null,
  nextAppointment: { id: 31, date: "2026-10-05", time: "12:00", durationMinutes: 30, appointmentType: null, note: null, status: "scheduled" },
  activePlans: [{
    id: 41, title: "خطة سريرية تجريبية", specialty: "علاج الجذور", primaryDoctorName: null,
    consentAt: null, itemsCount: 4, doneItems: 2, totalMinor: 718234, doneMinor: 218234,
    remainingMinor: 500000, overdueMinor: 619873, nextDueDate: "2026-10-01", baseCurrency: "USD",
  }],
  plannedVisits: [{
    id: 51, planTitle: "خطة سريرية تجريبية", sequence: 1, title: "جلسة مخططة تجريبية",
    doctorName: "طبيب الجلسة المسجل", durationMinutes: 30, status: "planned",
    appointmentId: null, appointmentVisibility: "all", appointmentDate: null, appointmentTime: null, note: null,
  }],
  counts: { visits: 3, openLabOrders: 1, documents: 2, orthoCase: false },
  financial: {
    balanceMinor: 187653, invoicedMinor: 187653, paidMinor: 0, openingMinor: 0,
    agreedMinor: 718234, treatmentDoneMinor: 218234, remainingTreatmentMinor: 500000,
    agreementPaidMinor: 371234, agreementRemainingMinor: 346999,
    byCurrency: {
      YER: { balanceMinor: 187653, invoicedMinor: 187653, paidMinor: 0, openingMinor: 0, agreedMinor: 718234, treatmentDoneMinor: 218234, remainingTreatmentMinor: 500000, agreementPaidMinor: 371234, agreementRemainingMinor: 346999 },
      USD: { balanceMinor: 100, invoicedMinor: 200, paidMinor: 100, openingMinor: 0, agreedMinor: 718234, treatmentDoneMinor: 218234, remainingTreatmentMinor: 500000, agreementPaidMinor: 371234, agreementRemainingMinor: 346999 },
      SAR: { balanceMinor: 0, invoicedMinor: 0, paidMinor: 0, openingMinor: 0, agreedMinor: 0, treatmentDoneMinor: 0, remainingTreatmentMinor: 0, agreementPaidMinor: 0, agreementRemainingMinor: 0 },
    },
  },
  alerts: [
    { kind: "overdue_installment", severity: "danger", text: "PRIVATE_FINANCIAL_ALERT 619873 USD" },
    { kind: "unreviewed_financial_kind", severity: "warning", text: "UNKNOWN_FINANCIAL_ALERT 998877" },
    ...["unscheduled_visit", "lab_open", "plan_ready", "plan_blocked", "case_waiting", "referral_blocker", "referral_returned", "active_problems"]
      .map((kind) => ({ kind, severity: "info" as const, text: `سياق سريري ${kind}` })),
  ],
};

beforeEach(() => {
  Object.assign(state, {
    role: "doctor", globalFinancial: false, payments: false, plans: true, owns: true, allPatients: false,
    active: true, userFound: true, lookupFails: false, todayVisit: true, patientFound: true,
    revokeDuringLookup: false, revokePlansDuringLookup: false, lookups: 0,
  });
  vi.clearAllMocks();
});

const request = (id = "91") => GET(new Request(`http://localhost/api/patients/${id}/workflow`), {
  params: Promise.resolve({ id }),
});
const render = (summary: WorkflowSummary) => renderToStaticMarkup(<SummaryTab
  summary={summary} patientId={91} patientName="مريض تجريبي" patientNumber="SYN-91" patientPhone={null}
  base="YER" onVisitStarted={() => {}} onChanged={() => {}} onGoToTab={() => {}}
/>);

function expectRedacted(payload: WorkflowSummary) {
  expect(payload.canSeeFinancial).toBe(false);
  expect(payload.planVisible).toBe(true);
  expect(payload.financial).toBeNull();
  expect(payload.activePlans[0]).toEqual({
    id: 41, title: "خطة سريرية تجريبية", specialty: "علاج الجذور", primaryDoctorName: null,
    consentAt: null, itemsCount: 4, doneItems: 2, totalMinor: null, doneMinor: null,
    remainingMinor: null, overdueMinor: null, nextDueDate: null, financialVisible: false,
  });
  expect(payload.alerts).toEqual(fixture.alerts.slice(2).filter((alert) => alert.kind !== "unscheduled_visit" || state.owns));
  const serialized = JSON.stringify(payload);
  for (const secret of ["718234", "218234", "500000", "619873", "187653", "998877", "PRIVATE_FINANCIAL_ALERT", "UNKNOWN_FINANCIAL_ALERT"]) {
    expect(serialized).not.toContain(secret);
  }
}

describe("patient workspace workflow finance projection", () => {
  it.each([[false, false], [false, true], [true, false]])(
    "requires both configured doctor visibility (%s) and canonical payment permission (%s)", async (config, payments) => {
      state.globalFinancial = config; state.payments = payments;
      const response = await request();
      expect(response.status).toBe(200);
      const payload = await response.json();
      expectRedacted(payload);
      expect(payload.openVisit).toEqual(fixture.openVisit);
      expect(payload.plannedVisits).toEqual(fixture.plannedVisits);
      expect(payload.nextAppointment).toEqual(fixture.nextAppointment);
    },
  );

  it("preserves authorized doctor numeric data without granting collection", async () => {
    state.globalFinancial = true; state.payments = true;
    const payload = await (await request()).json();
    expect(payload.canSeeFinancial).toBe(true);
    expect(payload.financial).toEqual(fixture.financial);
    expect(payload.activePlans).toEqual(fixture.activePlans);
    expect(payload.alerts).toEqual(fixture.alerts);
    expect(findUserByUsername).toHaveBeenCalledTimes(5);
    const html = render(payload);
    expect(html).toContain("باقي علاج");
    expect(html).toContain(formatMoney(500000, "USD"));
    expect(html).not.toContain("تحصيل دفعة");
    expect(html).not.toContain("collection-modal");
  });

  it.each(["admin", "reception"])("keeps existing %s financial access and collection UI", async (role) => {
    state.role = role;
    const payload = await (await request()).json();
    expect(payload.canSeeFinancial).toBe(true);
    expect(payload.financial).toEqual(fixture.financial);
    expect(payload.activePlans).toEqual(fixture.activePlans);
    expect(findUserByUsername).not.toHaveBeenCalled();
    const html = render(payload);
    expect(html).toContain("تحصيل دفعة");
    expect(html).toContain("collection-modal");
  });

  it("honors permission revocation between file access and financial projection", async () => {
    state.globalFinancial = true; state.payments = true; state.revokeDuringLookup = true;
    const payload = await (await request()).json();
    expectRedacted(payload);
    expect(findUserByUsername).toHaveBeenCalledTimes(5);
  });

  it("does not equate access to all patient files with access to their payments", async () => {
    state.globalFinancial = true; state.allPatients = true; state.owns = false;
    expectRedacted(await (await request()).json());
  });

  it("retains assistant restrictions and removes generated financial warning text", async () => {
    state.role = "assistant"; state.globalFinancial = true; state.payments = true;
    const response = await request();
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      activePlans: [], plannedVisits: [], nextAppointment: null, financial: null, canSeeFinancial: false,
      planVisible: false, openVisit: { ...fixture.openVisit, plannedTitle: null }, patient: fixture.patient,
    });
    expect(payload.alerts).toEqual(fixture.alerts.filter((alert) => ["lab_open", "case_waiting", "referral_blocker", "referral_returned", "active_problems"].includes(alert.kind)));
    expect(JSON.stringify(payload)).not.toMatch(/PRIVATE_FINANCIAL_ALERT|UNKNOWN_FINANCIAL_ALERT|718234|619873|187653/);
  });

  it.each(["missing", "inactive", "foreign", "lookup-failure"])("denies %s doctor before querying the workflow", async (kind) => {
    state.globalFinancial = true; state.payments = true;
    if (kind === "missing") state.userFound = false;
    if (kind === "inactive") state.active = false;
    if (kind === "foreign") state.owns = false;
    if (kind === "lookup-failure") state.lookupFails = true;
    expect((await request()).status).toBe(403);
    expect(patientWorkflow).not.toHaveBeenCalled();
  });

  it.each(["cashier", "accountant", "unknown-role"])("does not expand patient-file access to %s", async (role) => {
    state.role = role;
    expect((await request()).status).toBe(403);
    expect(patientWorkflow).not.toHaveBeenCalled();
  });

  it("denies an assistant without a visit today before querying the workflow", async () => {
    state.role = "assistant"; state.todayVisit = false;
    expect((await request()).status).toBe(403);
    expect(patientWorkflow).not.toHaveBeenCalled();
  });

  it("retains expired-session, invalid-id and missing-patient responses", async () => {
    state.role = null;
    expect((await request()).status).toBe(401);
    state.role = "admin";
    expect((await request("-1")).status).toBe(400);
    expect(patientWorkflow).not.toHaveBeenCalled();
    state.patientFound = false;
    expect((await request()).status).toBe(404);
  });
});

describe("patient workspace hidden-money summary rendering", () => {
  it("preserves clinical counts and consent while rendering neither money nor false zero-balance labels", async () => {
    const payload = await (await request()).json();
    const html = render(payload);
    expect(html).toContain("خطة سريرية تجريبية");
    expect(html).toContain("2 من 4 إجراءات");
    expect(html).toContain("موافقة العلاج لم تُسجّل");
    expect(html).not.toContain("باقي علاج");
    expect(html).not.toContain("المستحق الحالي مسدّد");
    expect(html).not.toContain("لا مبالغ مستحقة");
    expect(html).not.toContain("تحصيل دفعة");
    expect(html).not.toContain("collection-modal");
    expect(html).not.toContain("PRIVATE_FINANCIAL_ALERT");
  });

  it("keeps the financial permission guard even if stale numeric payloads are still in local state", async () => {
    const payload: WorkflowSummary = await (await request()).json();
    const html = render({ ...payload, financial: fixture.financial, activePlans: fixture.activePlans });
    expect(html).not.toContain("باقي علاج");
    expect(html).not.toContain("المستحق الحالي:");
    expect(html).not.toContain("تحصيل دفعة");
  });

  it("does not format a redacted plan amount as zero even when summary visibility is true", async () => {
    const payload: WorkflowSummary = await (await request()).json();
    const html = render({ ...payload, canSeeFinancial: true });
    expect(html).toContain("2 من 4 إجراءات");
    expect(html).not.toContain("باقي علاج");
    expect(html).not.toContain("المستحق الحالي مسدّد");
  });
});

describe("patient workspace plan capability is independent of money visibility", () => {
  it.each([false, true])("withholds plan-derived context without inventing empty-plan facts (money visible: %s)", async (money) => {
    state.plans = false; state.globalFinancial = money; state.payments = money;
    const response = await request();
    expect(response.status).toBe(200);
    const payload: WorkflowSummary = await response.json();
    expect(payload.planVisible).toBe(false);
    expect(payload.activePlans).toEqual([]);
    expect(payload.plannedVisits).toEqual([]);
    expect(payload.openVisit).toEqual({ ...fixture.openVisit, plannedTitle: null });
    expect(payload.alerts).toEqual(fixture.alerts.filter((alert) => ["lab_open", "case_waiting", "referral_blocker", "referral_returned", "active_problems"].includes(alert.kind)));
    expect(payload.canSeeFinancial).toBe(money);
    if (money) {
      expect(payload.financial).toMatchObject({
        balanceMinor: 187653, invoicedMinor: 187653, paidMinor: 0, openingMinor: 0,
        agreedMinor: null, treatmentDoneMinor: null, remainingTreatmentMinor: null,
        agreementPaidMinor: null, agreementRemainingMinor: null,
      });
      for (const row of Object.values(payload.financial!.byCurrency!)) {
        expect(row).toMatchObject({ agreedMinor: null, treatmentDoneMinor: null, remainingTreatmentMinor: null,
          agreementPaidMinor: null, agreementRemainingMinor: null });
      }
    } else expect(payload.financial).toBeNull();
    const serialized = JSON.stringify(payload);
    for (const hidden of ["خطة سريرية تجريبية", "جلسة مخططة تجريبية", "طبيب الجلسة المسجل", "جلسة سريرية", "718234", "218234", "500000", "619873", "371234", "346999"]) {
      expect(serialized).not.toContain(hidden);
    }
    const html = render(payload);
    expect(html).toContain("غير متاح لهذه الصلاحية");
    expect(html).not.toContain("لا خطة جارية");
    expect(html).not.toContain("لا جلسة مخطَّطة");
    expect(html).not.toContain("الجلسات المتبقّية: 0");
    expect(html).not.toContain("باقي علاج");
    expect(html).not.toContain("قيمة العلاج المتفق عليه");
  });

  it("rechecks plan capability after the patient-access check", async () => {
    state.revokePlansDuringLookup = true;
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ planVisible: false, activePlans: [], plannedVisits: [] });
    expect(findUserByUsername).toHaveBeenCalledTimes(4);
  });

  it("does not let an all-patient grant restore denied plan capability", async () => {
    state.plans = false; state.allPatients = true; state.owns = false;
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ planVisible: false, activePlans: [], plannedVisits: [] });
  });

  it("hides stale plan arrays and amounts under a current denied capability in the view", async () => {
    state.plans = false; state.globalFinancial = true; state.payments = true;
    const payload: WorkflowSummary = await (await request()).json();
    const html = render({ ...payload, activePlans: fixture.activePlans, plannedVisits: fixture.plannedVisits, financial: fixture.financial });
    expect(html).toContain("غير متاح لهذه الصلاحية");
    expect(html).not.toContain("خطة سريرية تجريبية");
    expect(html).not.toContain("طبيب الجلسة المسجل");
    expect(html).not.toContain("متبقّي من اتفاق العلاج:");
    expect(html).not.toContain("قيمة العلاج المتفق عليه");
  });
});

describe("summary calendar read-state wording and scheduling offers", () => {
  it.each(["scoped", "hidden", "unknown", undefined] as const)("does not turn %s metadata into a booking-absence claim", (visibility) => {
    const html = render({ ...fixture, planVisible: true, canSeeFinancial: false, financial: null,
      appointmentVisibility: visibility, nextAppointment: null, openVisit: null,
      plannedVisits: [{ ...fixture.plannedVisits[0], appointmentVisibility: visibility, status: "scheduled" }],
      alerts: [{ kind: "unscheduled_visit", severity: "warning", text: "BOOKING_ABSENCE" }],
    });
    expect(html).toContain("جلسة مخططة تجريبية");
    expect(html).not.toContain("لا يوجد موعد قادم"); expect(html).not.toContain("جدولها");
    expect(html).not.toContain("BOOKING_ABSENCE"); expect(html).toContain("ابدأ الزيارة");
  });
  it("allows the existing scheduling offer only on confirmed all-read unbooked planned rows", () => {
    const html = render({ ...fixture, planVisible: true, canSeeFinancial: false, financial: null,
      appointmentVisibility: "all", nextAppointment: null, openVisit: null });
    expect(html).toContain("لا يوجد موعد قادم"); expect(html).toContain("جدولها");
  });
  it.each(["hidden", "unknown", undefined] as const)("hides stale positive next/nested metadata when %s", (visibility) => {
    const html = render({ ...fixture, planVisible: true, canSeeFinancial: false, financial: null,
      appointmentVisibility: visibility, openVisit: null,
      nextAppointment: { ...fixture.nextAppointment!, note: "CALENDAR_ONLY" },
      plannedVisits: [{ ...fixture.plannedVisits[0], appointmentId: 991, appointmentDate: "2026-11-12", appointmentTime: "15:47" }],
    });
    expect(html).not.toContain("CALENDAR_ONLY"); expect(html).not.toContain("15:47");
    expect(html).not.toContain("جدولها"); expect(html).toContain("جلسة مخططة تجريبية");
  });
  it("labels a scoped positive appointment as the next visible appointment", () => {
    const html = render({ ...fixture, planVisible: true, canSeeFinancial: false, financial: null, appointmentVisibility: "scoped" });
    expect(html).toContain("الموعد القادم الظاهر");
  });
});


describe("workspace overview calendar copy", () => {
  const patient = { id: 91, patientNumber: "SYN-91" } as Parameters<typeof WorkspaceOverview>[0]["patient"];
  it.each(["hidden", "unknown", undefined] as const)("ignores stale positive appointment values under %s state", (appointmentVisibility) => {
    const html = renderToStaticMarkup(<WorkspaceOverview patient={patient} onChanged={() => {}} onNavigate={() => {}}
      summary={{ ...fixture, canSeeFinancial: false, planVisible: true, financial: null, appointmentVisibility,
        nextAppointment: { ...fixture.nextAppointment!, note: "CALENDAR_ONLY" },
        alerts: [{ kind: "unscheduled_visit", severity: "warning", text: "BOOKING_ABSENCE" }] }} />);
    expect(html).not.toContain("CALENDAR_ONLY"); expect(html).not.toContain("BOOKING_ABSENCE");
    expect(html).not.toContain("لا يوجد موعد"); expect(html).toContain("خطة سريرية تجريبية");
  });
  it.each(["all", "scoped"] as const)("qualifies %s empty next-appointment state", (appointmentVisibility) => {
    const html = renderToStaticMarkup(<WorkspaceOverview patient={patient} onChanged={() => {}} onNavigate={() => {}}
      summary={{ ...fixture, canSeeFinancial: false, planVisible: true, financial: null, appointmentVisibility, nextAppointment: null }} />);
    if (appointmentVisibility === "all") expect(html).toContain("لا يوجد موعد قادم");
    else { expect(html).toContain("قد توجد مواعيد أخرى غير ظاهرة"); expect(html).not.toContain("لا يوجد موعد قادم"); }
  });
});
