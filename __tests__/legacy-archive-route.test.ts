import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), history: vi.fn(), user: vi.fn(), owns: vi.fn(), today: vi.fn(),
  findPatient: vi.fn(), patient: vi.fn(), merge: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/db", () => ({
  patientLegacyHistory: mocks.history, findUserByUsername: mocks.user,
  doctorOwnsPatient: mocks.owns, patientHasVisitToday: mocks.today,
  findPatientIdByNumber: mocks.findPatient, getPatient: mocks.patient, mergeDuplicatePatient: mocks.merge,
}));
// Use the real patient-access/financial-permission helpers, not a mocked allow.
import { GET } from "../app/api/patients/[id]/legacy/route";
import { POST } from "../app/api/patients/[id]/merge/route";

const get = (id = "11") => GET(new Request(`http://test.invalid/api/patients/${id}/legacy`), { params: Promise.resolve({ id }) });
const imported = { id: 51, legacyNumber: 901, sourceKind: "legacy_import", historicalAsOf: null,
  treatedOn: "2025-01-01", doctorName: "Synthetic", service: "Historical treatment", currency: "SAR",
  priceMinor: 60000, rate: 143.25, paidMinor: 25000, remainingMinor: 34999, payments: [] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ role: "doctor", username: "synthetic-doctor" });
  mocks.user.mockResolvedValue({ isActive: true, partyId: 31, permissions: { canViewPatientPayments: true } });
  mocks.owns.mockResolvedValue(true); mocks.today.mockResolvedValue(true);
  mocks.history.mockResolvedValue({ treatments: [imported], orphanPayments: [] });
});

describe("legacy archive read authority", () => {
  it("requires a session before querying any archive", async () => {
    mocks.session.mockResolvedValue(null);
    expect((await get()).status).toBe(401); expect(mocks.history).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "1.5", "bad"])("rejects invalid patient %s before archive reads", async (id) => {
    expect((await get(id)).status).toBe(400); expect(mocks.history).not.toHaveBeenCalled();
  });
  it("denies a clinical doctor who lacks the live financial permission", async () => {
    // A permission claimed by the browser/session must not replace the live user record.
    mocks.session.mockResolvedValue({ role: "doctor", username: "synthetic-doctor", permissions: { canViewPatientPayments: true } });
    mocks.user.mockResolvedValue({ isActive: true, partyId: 31, permissions: {} });
    expect((await get()).status).toBe(403); expect(mocks.history).not.toHaveBeenCalled();
  });
  it("denies a financially permitted doctor outside the patient scope", async () => {
    mocks.owns.mockResolvedValue(false);
    expect((await get()).status).toBe(404); expect(mocks.history).not.toHaveBeenCalled();
  });
  it("denies inactive clinicians and failed ownership lookups", async () => {
    mocks.user.mockResolvedValue({ isActive: false, partyId: 31, permissions: { canViewPatientPayments: true } });
    expect((await get()).status).toBe(404);
    mocks.user.mockRejectedValue(new Error("synthetic user lookup failure"));
    expect((await get()).status).toBe(404); expect(mocks.history).not.toHaveBeenCalled();
  });
  it("denies an assistant even when the patient has a visit today", async () => {
    mocks.session.mockResolvedValue({ role: "assistant", username: "synthetic-assistant" });
    expect((await get()).status).toBe(403); expect(mocks.today).toHaveBeenCalledWith(11);
    expect(mocks.history).not.toHaveBeenCalled();
  });
  it.each(["cashier", "accountant", "unknown"])("preserves existing patient-scope denial for %s", async (role) => {
    mocks.session.mockResolvedValue({ role, username: "synthetic-reader" });
    expect((await get()).status).toBe(404); expect(mocks.history).not.toHaveBeenCalled();
  });
  it.each(["admin", "reception", "doctor"])("allows the authorized %s without changing historical facts", async (role) => {
    mocks.session.mockResolvedValue({ role, username: "synthetic-reader" });
    const response = await get(); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ treatments: [imported], orphanPayments: [] });
    expect(mocks.history).toHaveBeenCalledExactlyOnceWith(11);
  });
  it("preserves explicitly granted all-patient doctor scope with financial permission", async () => {
    mocks.user.mockResolvedValue({ isActive: true, permissions: { canViewAllPatients: true, canViewPatientPayments: true } });
    mocks.owns.mockResolvedValue(false);
    expect((await get()).status).toBe(200); expect(mocks.owns).not.toHaveBeenCalled();
  });
  it("returns nullable genuine identities without inventing payment detail", async () => {
    const manual = { ...imported, id: 52, legacyNumber: null, sourceKind: "manual_history", historicalAsOf: "2026-09-01", rate: null };
    mocks.history.mockResolvedValue({ treatments: [manual], orphanPayments: [] });
    expect(await (await get()).json()).toEqual({ treatments: [manual], orphanPayments: [] });
  });
  it("fails a malformed-provenance read without leaking the record or error", async () => {
    mocks.history.mockRejectedValue(new Error("Invalid legacy archive provenance for record 51"));
    const response = await get(); expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر تحميل سجل النظام القديم." });
  });
});

it("returns a clear immutable-archive merge refusal without recommending receipt reversal", async () => {
  mocks.session.mockResolvedValue({ role: "admin", username: "synthetic-admin" });
  mocks.findPatient.mockResolvedValue(12); mocks.patient.mockResolvedValue({ id: 11, fullName: "Synthetic" });
  const counts = { payments: 0, inventoryMovements: 0, openingBalances: 0, legacyTreatments: 1, legacyPayments: 0 };
  mocks.merge.mockResolvedValue({ ok: false, reason: "source_has_financial_history", counts });
  const response = await POST(new Request("http://test.invalid/api/patients/11/merge", { method: "POST",
    body: JSON.stringify({ duplicatePatientNumber: "DUP-1", confirmDuplicateNumber: "DUP-1" }) }), { params: Promise.resolve({ id: "11" }) });
  expect(response.status).toBe(409);
  const result = await response.json(); expect(result.counts).toEqual(counts);
  expect(result.message).toContain("سجل مالي سابق"); expect(result.message).toContain("مسدّدًا بالكامل");
  expect(result.message).not.toMatch(/قيودٍ معاكسة|الاتجاه المعاكس/);
});
