import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/visits/readiness/route";
import { chairReadinessSettings, patientDuesByCurrency, patientVisitReadinessFacts } from "../lib/db";

const state = vi.hoisted(() => ({
  role: "reception" as string | null,
  owns: true,
  canAccess: true,
  doctorFound: true,
  doctorActive: true,
  canViewAllPatients: false,
  canViewPatientPayments: false,
  visitFound: true,
  factsFail: false,
}));

vi.mock("../lib/session", () => ({
  requireSession: async () => state.role === null ? null : { role: state.role, username: "synthetic" },
}));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: async () => state.canAccess }));
vi.mock("../lib/db", () => {
  const row = {
    visitId: 21, patientId: 91, status: "in_chair", chair: 1,
    arrivedAt: "2026-10-03T00:00:00Z", seatedAt: "2026-10-03T00:00:00Z", signedAt: null,
    clearedAt: null, clearedBy: null, medicalAlert: "تنبيه الملف القابل للتعديل", flags: [], intakeAt: null,
    history: {
      recordedAt: "2026-10-03T00:00:00Z", answers: {},
      allergies: [{ substance: "لاتكس", reaction: null, severity: "severe" }], asaClass: null,
    },
    invoiceCurrency: "YER", invoiceNetMinor: 25000, deferred: false,
  };
  return {
    CLINIC_TIME_ZONE: "Asia/Aden",
    chairReadinessSettings: vi.fn(async () => ({ requireClearance: false, reviewMonths: 6, balanceThresholds: {} })),
    doctorOwnsPatient: async () => state.owns,
    findUserByUsername: async () => state.doctorFound ? {
      isActive: state.doctorActive, partyId: 5,
      permissions: { canViewAllPatients: state.canViewAllPatients, canViewPatientPayments: state.canViewPatientPayments },
    } : null,
    listTodayVisitReadinessFacts: async () => [row],
    patientVisitReadinessFacts: vi.fn(async () => {
      if (state.factsFail) throw new Error("synthetic readiness failure");
      return state.visitFound ? row : null;
    }),
    patientDuesByCurrency: vi.fn(async () => new Map([[91, [{ currency: "YER", dueMinor: 25000 }]]])),
  };
});

beforeEach(() => {
  Object.assign(state, {
    role: "reception", owns: true, canAccess: true, doctorFound: true, doctorActive: true,
    canViewAllPatients: false, canViewPatientPayments: false, visitFound: true, factsFail: false,
  });
  vi.clearAllMocks();
});

const patientRequest = () => new Request("http://localhost/api/visits/readiness?patientId=91");

describe("patient workspace authorized readiness projection", () => {
  it.each(["admin", "reception"])("preserves both warning sources and financial access for %s", async (role) => {
    state.role = role;
    const response = await GET(patientRequest());
    expect(response.status).toBe(200);
    const { visit } = await response.json();
    expect(visit.alerts).toEqual(["تنبيه الملف القابل للتعديل", "حساسية لاتكس (شديدة)"]);
    expect(visit.historyAlerts).toEqual(["حساسية لاتكس (شديدة)"]);
    expect(visit.editableAlert).toBe("تنبيه الملف القابل للتعديل");
    expect(visit.balances).toEqual([{ currency: "YER", dueMinor: 25000, warn: false }]);
    expect(patientDuesByCurrency).toHaveBeenCalledWith([91]);
    expect(visit.stepper.steps.map((step: { key: string }) => step.key)).toContain("paid");
  });

  it.each(["assistant", "doctor"])("does not turn medical access into financial access for %s", async (role) => {
    state.role = role;
    const response = await GET(patientRequest());
    expect(response.status).toBe(200);
    const { visit } = await response.json();
    expect(visit.historyAlerts).toEqual(["حساسية لاتكس (شديدة)"]);
    expect(visit.editableAlert).toBe("تنبيه الملف القابل للتعديل");
    expect(visit.balances).toBeNull();
    expect(patientDuesByCurrency).toHaveBeenCalledWith([]);
    expect(visit.stepper.steps.map((step: { key: string }) => step.key)).not.toContain("paid");
  });

  it("retains the explicit doctor patient-payment gate", async () => {
    state.role = "doctor";
    state.canViewPatientPayments = true;
    const response = await GET(patientRequest());
    const { visit } = await response.json();
    expect(visit.balances).toEqual([{ currency: "YER", dueMinor: 25000, warn: false }]);
    expect(patientDuesByCurrency).toHaveBeenCalledWith([91]);
  });

  it("preserves medical-wide doctor access without implicitly granting payment access", async () => {
    state.role = "doctor";
    state.owns = false;
    state.canViewAllPatients = true;
    const response = await GET(new Request("http://localhost/api/visits/readiness"));
    const { items } = await response.json();
    expect(items[0].historyAlerts).toEqual(["حساسية لاتكس (شديدة)"]);
    expect(items[0].editableAlert).toBe("تنبيه الملف القابل للتعديل");
    expect(items[0].balances).toBeNull();
    expect(patientDuesByCurrency).toHaveBeenCalledWith([]);
  });

  it("returns a null visit rather than fabricating an all-clear safety state when no visit exists", async () => {
    state.visitFound = false;
    const response = await GET(patientRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ requireClearance: false, visit: null });
    expect(patientDuesByCurrency).toHaveBeenCalledWith([]);
  });
});

describe("patient workspace readiness denial and failure boundaries", () => {
  it("redacts every medical source and balances on another doctor's board row", async () => {
    state.role = "doctor";
    state.owns = false;
    state.canViewPatientPayments = true;
    const response = await GET(new Request("http://localhost/api/visits/readiness"));
    expect(response.status).toBe(200);
    const { items } = await response.json();
    expect(items[0]).toMatchObject({
      checklist: null, attention: null, alerts: null, historyAlerts: null, editableAlert: null, balances: null,
    });
    expect(patientDuesByCurrency).toHaveBeenCalledWith([]);
  });

  it("checks patient authorization before reading either source or any money", async () => {
    state.role = "doctor";
    state.canAccess = false;
    const response = await GET(patientRequest());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("حساسية");
    expect(chairReadinessSettings).not.toHaveBeenCalled();
    expect(patientVisitReadinessFacts).not.toHaveBeenCalled();
    expect(patientDuesByCurrency).not.toHaveBeenCalled();
  });

  it.each([null, "accountant", "cashier", "unknown-role"])("rejects absent or nonclinical session %s before facts are loaded", async (role) => {
    state.role = role;
    const response = await GET(patientRequest());
    expect(response.status).toBe(role === null ? 401 : 403);
    expect(patientVisitReadinessFacts).not.toHaveBeenCalled();
    expect(patientDuesByCurrency).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "1.5", "not-a-patient", ""])("rejects invalid patientId %s without querying facts", async (id) => {
    const response = await GET(new Request(`http://localhost/api/visits/readiness?patientId=${id}`));
    expect(response.status).toBe(400);
    expect(patientVisitReadinessFacts).not.toHaveBeenCalled();
    expect(patientDuesByCurrency).not.toHaveBeenCalled();
  });

  it.each(["missing", "inactive"])("rejects a %s doctor identity without querying medical facts", async (kind) => {
    state.role = "doctor";
    state.doctorFound = kind !== "missing";
    state.doctorActive = kind !== "inactive";
    const response = await GET(patientRequest());
    expect(response.status).toBe(403);
    expect(patientVisitReadinessFacts).not.toHaveBeenCalled();
    expect(patientDuesByCurrency).not.toHaveBeenCalled();
  });

  it("reports an unavailable readiness response instead of returning a successful empty warning list", async () => {
    state.factsFail = true;
    const response = await GET(patientRequest());
    expect(response.status).toBe(500);
    const payload = await response.json();
    expect(payload).toEqual({ message: "تعذّر تحميل جاهزية الكرسي." });
    expect(patientDuesByCurrency).not.toHaveBeenCalled();
  });
});
