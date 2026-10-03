import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { workflowDocuments, WORKFLOW_DOCUMENT_COUNT_UNAVAILABLE } from "../lib/patient-workflow-documents";
import { GET } from "../app/api/patients/[id]/workflow/route";
import { SummaryTab, type WorkflowSummary } from "../components/patient/SummaryTab";
import { WorkspaceNavigation } from "../components/patient-workspace/WorkspaceNavigation";

// Synthetic collaborators only. Exercise the real patient-access guard; no DB,
// server, document storage, patient data, or document mutation API is used.
const state = vi.hoisted(() => ({ role: "doctor" as string | null, documents: true as unknown,
  plans: true, payments: true, globalMoney: true, owns: true, allPatients: false,
  active: true, found: true, lookupFails: false, todayVisit: true, patientFound: true,
  revokeAfterWorkflow: false, revokeLookupAfterWorkflow: false, documentCount: 73519 as unknown,
  workflow: vi.fn(), lookup: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: async () => state.role === null ? null
  : { userId: 10, username: "synthetic-doctor", role: state.role, partyId: 7, expiresAt: 0 } }));
vi.mock("@/lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden",
  getSettings: async () => ({ "workflow.doctor_financial_view": String(state.globalMoney) }),
  findUserByUsername: state.lookup, doctorOwnsPatient: async () => state.owns,
  doctorOwnedPatientIds: async () => new Set(state.owns ? [91] : []),
  patientHasVisitToday: async () => state.todayVisit, patientWorkflow: state.workflow,
}));
vi.mock("../components/SessionProvider", () => ({ useSession: () => ({ role: state.role }) }));
vi.mock("../components/ReceiptCorrectionLauncher", () => ({ ReceiptCorrectionLauncher: () => null }));
vi.mock("../components/CollectPaymentModal", () => ({ CollectPaymentModal: () => null }));
vi.mock("../components/PortalInviteRow", () => ({ PortalInviteRow: () => null }));
vi.mock("../components/patient/PatientTimeline", () => ({ PatientTimeline: () => null }));
vi.mock("../components/patient/PatientIntakeHistory", () => ({ PatientIntakeHistory: () => null }));

const fixture: WorkflowSummary = {
  planVisible: true, documentsVisible: true, appointmentVisibility: "all", canSeeFinancial: true,
  openVisit: { id: 21, status: "in_chair", chair: 1, arrivedAt: "2026-10-03T09:00:00Z", plannedTitle: "Clinical plan title" },
  lastVisit: { id: 22, date: "2026-10-02", treatmentDone: "Clinical history", proceduresSummary: null, nextPlan: null },
  nextAppointment: null,
  activePlans: [{ id: 31, title: "Clinical plan", specialty: null, primaryDoctorName: null, consentAt: null,
    itemsCount: 1, doneItems: 0, totalMinor: 500, doneMinor: 0, remainingMinor: 500, nextDueDate: null, overdueMinor: 0 }],
  plannedVisits: [], counts: { visits: 3, openLabOrders: 2, documents: 73519, orthoCase: true },
  financial: { balanceMinor: 500, invoicedMinor: 500, paidMinor: 0, openingMinor: 0,
    agreedMinor: 500, treatmentDoneMinor: 0, remainingTreatmentMinor: 500, agreementPaidMinor: 0, agreementRemainingMinor: 500 },
  alerts: [{ kind: "lab_open", severity: "info", text: "Clinical lab reminder" }],
};
const request = (id = "91") => GET(new Request(`http://test.invalid/api/patients/${id}/workflow`), { params: Promise.resolve({ id }) });
const summaryHtml = (summary: WorkflowSummary) => renderToStaticMarkup(<SummaryTab summary={summary}
  patientId={91} patientName="Synthetic patient" patientNumber="SYN-91" patientPhone={null} base="YER"
  onVisitStarted={() => {}} onChanged={() => {}} onGoToTab={() => {}} />);
const navigationHtml = (summary: WorkflowSummary | null) => renderToStaticMarkup(<WorkspaceNavigation
  current="summary" sections={["summary", "files", "lab"]} summary={summary} onNavigate={() => {}} />);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, { role: "doctor", documents: true, plans: true, payments: true, globalMoney: true,
    owns: true, allPatients: false, active: true, found: true, lookupFails: false, todayVisit: true,
    patientFound: true, revokeAfterWorkflow: false, revokeLookupAfterWorkflow: false, documentCount: 73519 });
  state.lookup.mockImplementation(async () => {
    if (state.lookupFails) throw new Error("Synthetic lookup failure");
    return state.found ? { isActive: state.active, partyId: 7, permissions: {
      canViewXrays: state.documents, canViewPlans: state.plans, canViewPatientPayments: state.payments,
      canViewAllPatients: state.allPatients,
    } } : null;
  });
  state.workflow.mockImplementation(async () => {
    if (state.revokeAfterWorkflow) state.documents = false;
    if (state.revokeLookupAfterWorkflow) state.lookupFails = true;
    return { ...fixture, patient: state.patientFound ? { id: 91 } : null,
      counts: { ...fixture.counts, documents: state.documentCount } };
  });
});

describe("workflow document count uses the existing named patient read policy", () => {
  it.each([false, undefined, null, "true", 1])("does not turn %s document permission into a count", async (permission) => {
    state.documents = permission;
    const result = await request(); expect(result.status).toBe(200);
    const payload = await result.json();
    expect(payload).toMatchObject({ documentsVisible: false, counts: { ...fixture.counts, documents: null } });
    expect(JSON.stringify(payload)).not.toContain("73519");
    expect(payload.openVisit).toEqual(fixture.openVisit); expect(payload.lastVisit).toEqual(fixture.lastVisit);
    expect(payload.activePlans).toEqual(fixture.activePlans); expect(payload.financial).toEqual(fixture.financial);
    expect(payload.alerts).toEqual(fixture.alerts); expect(payload.appointmentVisibility).toBe("all");
  });
  it.each([0, 73519])("retains an explicitly readable nonremoved-document count of %s", async (count) => {
    state.documentCount = count;
    const payload = await (await request()).json();
    expect(payload.documentsVisible).toBe(true); expect(payload.counts.documents).toBe(count);
  });
  it.each(["admin", "reception"])("preserves existing %s document reading", async (role) => {
    state.role = role; state.documents = false;
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ documentsVisible: true, counts: { documents: 73519 } });
    expect(state.lookup).not.toHaveBeenCalled();
  });
  it("does not grant document counts from all-patient, plan, or financial access", async () => {
    state.allPatients = true; state.owns = false; state.documents = false;
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ documentsVisible: false, counts: { documents: null },
      planVisible: true, canSeeFinancial: true, appointmentVisibility: "scoped" });
  });
  it("keeps readable documents independent of denied plan and financial access", async () => {
    state.plans = false; state.payments = false;
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ documentsVisible: true, counts: { documents: 73519 },
      planVisible: false, activePlans: [], plannedVisits: [], canSeeFinancial: false, financial: null });
  });
  it("rechecks document authority after the workflow collaborator returns", async () => {
    state.revokeAfterWorkflow = true;
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ documentsVisible: false, counts: { documents: null } });
    expect(payload.openVisit).toEqual(fixture.openVisit);
  });
  it("fails closed when the document permission lookup is unavailable after admission", async () => {
    state.revokeLookupAfterWorkflow = true;
    const result = await request(); expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ documentsVisible: false, counts: { documents: null } });
  });
  it("preserves the assistant ceiling even when the upstream summary has a positive count and flag", async () => {
    state.role = "assistant";
    const payload = await (await request()).json();
    expect(payload).toMatchObject({ documentsVisible: false, counts: { ...fixture.counts, documents: null },
      appointmentVisibility: "hidden", nextAppointment: null, planVisible: false, activePlans: [], plannedVisits: [],
      canSeeFinancial: false, financial: null, openVisit: { id: 21, plannedTitle: null } });
    expect(JSON.stringify(payload)).not.toContain("73519");
  });
  it.each(["missing", "inactive", "foreign", "lookup-failure", "cashier", "accountant"])("preserves the outer %s admission boundary", async (kind) => {
    if (kind === "missing") state.found = false;
    if (kind === "inactive") state.active = false;
    if (kind === "foreign") state.owns = false;
    if (kind === "lookup-failure") state.lookupFails = true;
    if (kind === "cashier" || kind === "accountant") state.role = kind;
    expect((await request()).status).toBe(403); expect(state.workflow).not.toHaveBeenCalled();
  });
  it("preserves expired-session, invalid-id and missing-patient responses", async () => {
    state.role = null; expect((await request()).status).toBe(401);
    state.role = "admin"; expect((await request("-1")).status).toBe(400);
    expect(state.workflow).not.toHaveBeenCalled();
    state.patientFound = false; expect((await request()).status).toBe(404);
  });
});

describe("document metadata projection and direct badge consumers fail closed", () => {
  it.each([false, undefined, null, "true", "unknown", 1])("requires explicit true authority, including direct %s legacy payloads", (visibility) => {
    const snapshot = { ...fixture, documentsVisible: visibility } as WorkflowSummary;
    expect(workflowDocuments(snapshot)).toEqual({ documentsVisible: visibility === false ? false : null, documents: null });
    for (const html of [summaryHtml(snapshot), navigationHtml(snapshot)]) {
      expect(html).not.toContain("73519"); expect(html).not.toContain("عدد المستندات غير المحذوفة:");
      expect(html).toContain(WORKFLOW_DOCUMENT_COUNT_UNAVAILABLE);
      expect(html).not.toMatch(/لا (?:توجد )?مستندات|لا يوجد مستند/);
    }
  });
  it.each([undefined, null, -1, 1.5, NaN, Infinity, "0", "73519", Number.MAX_SAFE_INTEGER + 1])("rejects malformed allowed counts (%s)", (count) => {
    const snapshot = { ...fixture, counts: { ...fixture.counts, documents: count } } as WorkflowSummary;
    expect(workflowDocuments(snapshot)).toEqual({ documentsVisible: true, documents: null });
    for (const html of [summaryHtml(snapshot), navigationHtml(snapshot)]) {
      expect(html).toContain(WORKFLOW_DOCUMENT_COUNT_UNAVAILABLE);
      expect(html).not.toContain("عدد المستندات غير المحذوفة:");
    }
  });
  it.each([0, 73519])("renders a confirmed count (%s) without claiming deleted documents do not exist", (count) => {
    const snapshot = { ...fixture, counts: { ...fixture.counts, documents: count } };
    expect(workflowDocuments(snapshot).documents).toBe(count);
    for (const html of [summaryHtml(snapshot), navigationHtml(snapshot)]) {
      expect(html).toContain(`عدد المستندات غير المحذوفة: ${count}`);
      expect(html).not.toContain(WORKFLOW_DOCUMENT_COUNT_UNAVAILABLE);
    }
  });
  it("does not turn an unavailable summary or absent count into an empty document record", () => {
    expect(workflowDocuments({ documentsVisible: true })).toEqual({ documentsVisible: true, documents: null });
    expect(navigationHtml(null)).toContain(WORKFLOW_DOCUMENT_COUNT_UNAVAILABLE);
    expect(navigationHtml(null)).not.toContain("عدد المستندات غير المحذوفة:");
  });
});
