import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../app/api/visits/readiness/route";

const state = vi.hoisted(() => ({ role: "reception", owns: true, canAccess: true }));
vi.mock("../lib/session", () => ({ requireSession: async () => ({ role: state.role, username: "synthetic" }) }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: async () => state.canAccess }));
vi.mock("../lib/db", () => {
  const row = {
    visitId: 21, patientId: 91, status: "in_chair", chair: 1,
    arrivedAt: "2026-10-03T00:00:00Z", seatedAt: "2026-10-03T00:00:00Z", signedAt: null,
    clearedAt: null, clearedBy: null, medicalAlert: "تنبيه الملف القابل للتعديل", flags: [], intakeAt: null,
    history: { recordedAt: "2026-10-03T00:00:00Z", answers: {}, allergies: [{ substance: "لاتكس", reaction: null, severity: "severe" }], asaClass: null },
    invoiceCurrency: null, invoiceNetMinor: null, deferred: false,
  };
  return {
    CLINIC_TIME_ZONE: "Asia/Aden",
    chairReadinessSettings: async () => ({ requireClearance: false, reviewMonths: 6, balanceThresholds: {} }),
    doctorOwnsPatient: async () => state.owns,
    findUserByUsername: async () => ({ isActive: true, partyId: 5, permissions: {} }),
    listTodayVisitReadinessFacts: async () => [row],
    patientVisitReadinessFacts: async () => row,
    patientDuesByCurrency: async () => new Map(),
  };
});
beforeEach(() => { state.role = "reception"; state.owns = true; state.canAccess = true; });

describe("readiness history alert projection", () => {
  it("adds the explicit derived subset without changing the combined alerts for existing consumers", async () => {
    const response = await GET(new Request("http://localhost/api/visits/readiness?patientId=91"));
    expect(response.status).toBe(200);
    const { visit } = await response.json();
    expect(visit.alerts).toEqual(["تنبيه الملف القابل للتعديل", "حساسية لاتكس (شديدة)"]);
    expect(visit.historyAlerts).toEqual(["حساسية لاتكس (شديدة)"]);
    expect(visit.editableAlert).toBe("تنبيه الملف القابل للتعديل");
  });
  it("redacts the new field wherever combined medical warnings are redacted", async () => {
    state.role = "doctor"; state.owns = false;
    const response = await GET(new Request("http://localhost/api/visits/readiness"));
    expect(response.status).toBe(200);
    const { items } = await response.json();
    expect(items[0]).toMatchObject({ checklist: null, alerts: null, historyAlerts: null, editableAlert: null, balances: null });
  });
  it("preserves patient-level authorization before returning either alert source", async () => {
    state.role = "doctor"; state.canAccess = false;
    const response = await GET(new Request("http://localhost/api/visits/readiness?patientId=91"));
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("حساسية");
  });
});
