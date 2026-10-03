import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Actual clinical POST, with only session/access/database boundaries replaced.
 * A rejected save must leave no changes, and the route must invoke one DB writer.
 * The mocked combined boundary is not evidence of real transaction rollback.
 * Database transaction/locking proof belongs to the built-HTTP and PG gates.
 */
const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(),
  canAccessPatient: vi.fn(),
  getClinicalVisit: vi.fn(),
  getSettings: vi.fn(),
  saveClinicalDraft: vi.fn(),
  saveClinicalNotes: vi.fn(),
  setVisitProcedures: vi.fn(),
  recordAudit: vi.fn(),
  addVisitAddendum: vi.fn(),
  signClinicalVisit: vi.fn(),
  ClinicalDraftAccessRejected: class ClinicalDraftAccessRejected extends Error {},
  ClinicalPlanConflict: class ClinicalPlanConflict extends Error {},
  ProcedurePriceRejected: class ProcedurePriceRejected extends Error {},
  InventoryShortage: class InventoryShortage extends Error {},
}));

vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: boundary.canAccessPatient }));
vi.mock("@/lib/db", () => ({ ...boundary, CLINIC_TIME_ZONE: "Asia/Aden" }));

import { assistantProcedureChange } from "../lib/clinical-finalizer";
import { POST } from "../app/api/visits/[id]/clinical/route";

type NoteFields = {
  chiefComplaint: string | null;
  examination: string | null;
  diagnosis: string | null;
  treatmentDone: string | null;
  nextPlan: string | null;
  doctorId: number | null;
};
type Line = {
  id: number;
  serviceId: number;
  doctorId: number | null;
  toothCode: number | null;
  surfaces: string | null;
  quantity: number;
  unitPriceMinor: number;
  note: string | null;
  planItemId: number | null;
};
type Draft = NoteFields & {
  id: number;
  patientId: number;
  patientName: string;
  arrivedAt: string;
  signedAt: string | null;
  billingCurrency: string;
  procedures: Line[];
};

let stored: Draft;
let audits: unknown[];
const changedNotes: NoteFields = {
  chiefComplaint: "replacement chief complaint",
  examination: "replacement examination",
  diagnosis: "replacement diagnosis",
  treatmentDone: "replacement treatment",
  nextPlan: "replacement next plan",
  doctorId: 3,
};

const snapshot = () => structuredClone({ visit: stored, audits });
const replacement = () => ({
  action: "save", ...changedNotes, billingCurrency: "YER",
  procedures: [{ serviceId: 8, doctorId: 3, toothCode: 17, quantity: 1, unitPriceMinor: 20000 }],
});
const post = (body: unknown) => POST(new Request("http://localhost/api/visits/1/clinical", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
}), { params: Promise.resolve({ id: "1" }) });

beforeEach(() => {
  vi.resetAllMocks();
  audits = [];
  stored = {
    id: 1, patientId: 9, patientName: "Synthetic atomic save", arrivedAt: new Date().toISOString(),
    signedAt: null, billingCurrency: "USD", doctorId: 2,
    chiefComplaint: "original chief complaint", examination: "original examination",
    diagnosis: "original diagnosis", treatmentDone: "original treatment", nextPlan: "original next plan",
    procedures: [{ id: 41, serviceId: 8, doctorId: 2, toothCode: 16, surfaces: "MO", quantity: 1,
      unitPriceMinor: 12000, note: "original line note", planItemId: null }],
  };
  boundary.requireSession.mockResolvedValue({ role: "doctor", username: "synthetic-doctor", partyId: 2 });
  boundary.canAccessPatient.mockResolvedValue(true);
  boundary.getClinicalVisit.mockImplementation(async () => structuredClone(stored));
  boundary.getSettings.mockResolvedValue({ "billing.max_discount_percent": "10" });
  boundary.saveClinicalDraft.mockImplementation(async (input: NoteFields & {
    authorizedPatientId: number; actor: { role: string }; procedures?: Omit<Line, "id">[];
    assistantProcedures?: Line[]; billingCurrency?: string;
  }) => {
    if (input.authorizedPatientId !== stored.patientId) throw new boundary.ClinicalDraftAccessRejected("Relinked visit");
    const assistant = input.actor.role === "assistant";
    if (assistant && (input.doctorId !== stored.doctorId
      || input.assistantProcedures && assistantProcedureChange(stored.procedures, input.assistantProcedures))) {
      throw new boundary.ClinicalDraftAccessRejected("Assistant cannot change provider/procedures");
    }
    if (stored.signedAt) return false;
    stored = { ...stored, chiefComplaint: input.chiefComplaint, examination: input.examination,
      diagnosis: input.diagnosis, treatmentDone: input.treatmentDone, nextPlan: input.nextPlan,
      doctorId: assistant ? stored.doctorId : input.doctorId ?? stored.doctorId };
    if (!assistant && input.procedures !== undefined) {
      stored.billingCurrency = input.billingCurrency ?? stored.billingCurrency;
      stored.procedures = input.procedures.map((line, index) => ({ ...line, id: 100 + index }));
    }
    return true;
  });
  boundary.recordAudit.mockImplementation(async (entry: unknown) => { audits.push(structuredClone(entry)); });
});

function expectNoWriter() {
  expect.soft(boundary.saveClinicalDraft).not.toHaveBeenCalled();
  expect.soft(boundary.saveClinicalNotes).not.toHaveBeenCalled();
  expect.soft(boundary.setVisitProcedures).not.toHaveBeenCalled();
  expect.soft(boundary.recordAudit).not.toHaveBeenCalled();
}

describe("clinical draft save rejection is all-or-nothing at the real POST boundary", () => {
  it("returns 400 for applicable invalid currency before persisting any of the five notes or provider", async () => {
    const before = snapshot();
    const response = await post({ ...replacement(), billingCurrency: "JPY" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: "عملة الزيارة غير صالحة." });
    expect.soft(snapshot()).toEqual(before);
    expectNoWriter();
  });

  it("returns price_authority 409 without committing notes/provider when procedure replacement rejects", async () => {
    const before = snapshot();
    boundary.saveClinicalDraft.mockRejectedValue(new boundary.ProcedurePriceRejected("Synthetic rejected price"));
    const response = await post(replacement());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "Synthetic rejected price", code: "price_authority" });
    expect(boundary.saveClinicalDraft).toHaveBeenCalledTimes(1);
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
    expect.soft(snapshot()).toEqual(before);
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });

  it("returns plan conflict 409 without committing notes/provider when procedure replacement rejects", async () => {
    const before = snapshot();
    boundary.saveClinicalDraft.mockRejectedValue(new boundary.ClinicalPlanConflict("Synthetic unavailable plan item"));
    const response = await post(replacement());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "Synthetic unavailable plan item" });
    expect(boundary.saveClinicalDraft).toHaveBeenCalledTimes(1);
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
    expect.soft(snapshot()).toEqual(before);
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
});

describe("existing clinical save compatibility controls", () => {
  it("keeps tokenless successful saves and the full saved-note response", async () => {
    const response = await post(replacement());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ...changedNotes, billingCurrency: "YER" });
    expect(boundary.saveClinicalDraft).toHaveBeenCalledTimes(1);
    expect(boundary.saveClinicalDraft).toHaveBeenCalledWith(expect.objectContaining({
      authorizedPatientId: 9, actor: { username: "synthetic-doctor", role: "doctor" },
    }));
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
    expect(boundary.recordAudit).not.toHaveBeenCalled();
    expect(stored.procedures).toHaveLength(1);
    expect(stored.procedures[0]).toMatchObject({ serviceId: 8, doctorId: 3, toothCode: 17, unitPriceMinor: 20000 });
  });

  it.each([undefined, "not-an-array"])("keeps notes-only semantics for procedures=%s and preserves currency/provider", async (procedures) => {
    const before = snapshot();
    const response = await post({ ...changedNotes, doctorId: null, billingCurrency: "JPY", procedures });
    expect(response.status).toBe(200);
    expect(stored).toMatchObject({ ...changedNotes, doctorId: before.visit.doctorId,
      billingCurrency: before.visit.billingCurrency, procedures: before.visit.procedures });
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
  });

  it("treats an empty procedure array as explicit clearing", async () => {
    const response = await post({ ...replacement(), procedures: [] });
    expect(response.status).toBe(200);
    expect(stored.procedures).toEqual([]);
  });

  it("does not mutate an already signed visit", async () => {
    stored.signedAt = "2026-01-01T09:00:00.000Z";
    const before = snapshot();
    expect((await post(replacement())).status).toBe(409);
    expect(snapshot()).toEqual(before);
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });

  it.each(["missing", "inaccessible"])("does not write a %s visit", async (mode) => {
    const before = snapshot();
    if (mode === "missing") boundary.getClinicalVisit.mockResolvedValue(null);
    else boundary.canAccessPatient.mockResolvedValue(false);
    expect((await post(replacement())).status).toBe(mode === "missing" ? 404 : 403);
    expect(snapshot()).toEqual(before);
    expectNoWriter();
  });

  it("allows assistant notes with the same existing lines, without replacing their IDs or currency", async () => {
    boundary.requireSession.mockResolvedValue({ role: "assistant", username: "synthetic-assistant" });
    const before = snapshot();
    const response = await post({ ...changedNotes, doctorId: stored.doctorId,
      billingCurrency: "JPY", procedures: structuredClone(stored.procedures) });
    expect(response.status).toBe(200);
    expect(stored).toMatchObject({ ...changedNotes, doctorId: before.visit.doctorId,
      billingCurrency: before.visit.billingCurrency, procedures: before.visit.procedures });
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
  });

  it("rejects assistant provider changes before writing notes", async () => {
    boundary.requireSession.mockResolvedValue({ role: "assistant", username: "synthetic-assistant" });
    const before = snapshot();
    expect((await post(replacement())).status).toBe(403);
    expect(snapshot()).toEqual(before);
    expect(boundary.saveClinicalDraft).toHaveBeenCalledTimes(1);
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
  });
});


// NEW AUTHORED UNRUN linked-intent cases. These mocks prove route dispatch and
// denial before a writer, not database transaction/lock behavior.
describe("optional already-linked clinical save intent", () => {
  it("keeps a matching expectation denial-only and authorizes the fresh server owner", async () => {
    const response = await post({ ...replacement(), expectedLinkedPatientId: 9,
      patientId: 999, authorizedPatientId: 999 });
    expect(response.status).toBe(200);
    expect(boundary.canAccessPatient).toHaveBeenCalledWith(expect.objectContaining({ role: "doctor" }), 9);
    expect(boundary.saveClinicalDraft).toHaveBeenCalledTimes(1);
    expect(boundary.saveClinicalDraft).toHaveBeenCalledWith(expect.objectContaining({ authorizedPatientId: 9 }));
    expect(boundary.saveClinicalDraft.mock.calls[0][0]).not.toHaveProperty("expectedLinkedPatientId");
  });

  it("rejects A intent when the fresh authorized preflight already sees B, before any writer", async () => {
    const expectedLinkedPatientId = stored.patientId;
    stored.patientId = 10;
    const before = snapshot();
    const response = await post({ ...replacement(), expectedLinkedPatientId });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      message: "تغيّر ارتباط الزيارة بملف المريض. احتفظ بالمسودة وأعد فتح السياق الصحيح.",
      code: "visit_patient_changed",
    });
    expect(boundary.canAccessPatient).toHaveBeenCalledWith(expect.objectContaining({ role: "doctor" }), 10);
    expect(boundary.getSettings).not.toHaveBeenCalled();
    expectNoWriter();
    expect(snapshot()).toEqual(before);
  });

  it.each([null, "9", 0, -1, 1.5, true, [], {}, Number.MAX_SAFE_INTEGER + 1])(
    "rejects a malformed supplied expectation %j without a writer", async (expectedLinkedPatientId) => {
      const before = snapshot();
      const response = await post({ ...replacement(), expectedLinkedPatientId });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "سياق ملف المريض غير صالح." });
      expect(boundary.getSettings).not.toHaveBeenCalled();
      expectNoWriter();
      expect(snapshot()).toEqual(before);
    },
  );

  it.each([9, 10, "malformed"])("never lets expectation %s replace current-owner access", async (expectedLinkedPatientId) => {
    stored.patientId = 10;
    boundary.canAccessPatient.mockResolvedValue(false);
    const before = snapshot();
    const response = await post({ ...replacement(), expectedLinkedPatientId });
    expect(response.status).toBe(403);
    expect(await response.json()).not.toHaveProperty("code", "visit_patient_changed");
    expect(boundary.canAccessPatient).toHaveBeenCalledWith(expect.objectContaining({ role: "doctor" }), 10);
    expectNoWriter();
    expect(snapshot()).toEqual(before);
  });

  it("preserves omitted-field compatibility without claiming stale-intent protection", async () => {
    stored.patientId = 10;
    expect((await post(replacement())).status).toBe(200);
    expect(boundary.saveClinicalDraft).toHaveBeenCalledWith(expect.objectContaining({ authorizedPatientId: 10 }));
  });

  it("retains the server-to-locked-writer fence after a matching preflight", async () => {
    const preflight = structuredClone(stored);
    boundary.getClinicalVisit.mockImplementationOnce(async () => {
      stored.patientId = 10;
      return preflight;
    });
    const before = { ...snapshot(), visit: { ...structuredClone(stored), patientId: 10 } };
    const response = await post({ ...replacement(), expectedLinkedPatientId: 9 });
    expect(response.status).toBe(403);
    expect(boundary.saveClinicalDraft).toHaveBeenCalledWith(expect.objectContaining({ authorizedPatientId: 9 }));
    expect(snapshot()).toEqual(before);
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });

  it("keeps matching assistant notes-only compatibility", async () => {
    boundary.requireSession.mockResolvedValue({ role: "assistant", username: "synthetic-assistant" });
    const before = snapshot();
    expect((await post({ ...changedNotes, doctorId: stored.doctorId, expectedLinkedPatientId: 9 })).status).toBe(200);
    expect(stored.procedures).toEqual(before.visit.procedures);
    expect(stored.billingCurrency).toBe(before.visit.billingCurrency);
    expect(boundary.saveClinicalDraft).toHaveBeenCalledWith(expect.objectContaining({ authorizedPatientId: 9, actor: { role: "assistant", username: "synthetic-assistant" } }));
  });

  it.each(["sign", "addendum"])("does not extend the precondition to %s", async (action) => {
    boundary.signClinicalVisit.mockResolvedValue({ reason: "already_signed" });
    boundary.addVisitAddendum.mockResolvedValue(true);
    const response = await post({ action, text: "Synthetic addendum", expectedLinkedPatientId: "ignored outside save" });
    expect(response.status).toBe(action === "sign" ? 409 : 200);
    expect(action === "sign" ? boundary.signClinicalVisit : boundary.addVisitAddendum).toHaveBeenCalledTimes(1);
    expect(boundary.saveClinicalDraft).not.toHaveBeenCalled();
  });
});

describe("atomic boundary errors and unrelated actions", () => {
  it.each([
    [new boundary.ClinicalDraftAccessRejected("Locked patient or assistant authority changed"), 403],
    [new Error("Synthetic audit INSERT rejected"), 500],
  ])("maps transaction rejection %s without a fallback writer", async (error, status) => {
    const before = snapshot();
    boundary.saveClinicalDraft.mockRejectedValue(error);
    expect((await post(replacement())).status).toBe(status);
    expect(snapshot()).toEqual(before);
    expect(boundary.saveClinicalNotes).not.toHaveBeenCalled();
    expect(boundary.setVisitProcedures).not.toHaveBeenCalled();
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });

  it("uses only the server-authorized owner, ignoring a request patientId", async () => {
    expect((await post({ ...replacement(), patientId: 999, authorizedPatientId: 999 })).status).toBe(200);
    expect(boundary.saveClinicalDraft).toHaveBeenCalledWith(expect.objectContaining({ authorizedPatientId: 9 }));
  });

  it("passes unmodified assistant intent for a fresh locked comparison", async () => {
    boundary.requireSession.mockResolvedValue({ role: "assistant", username: "synthetic-assistant" });
    const procedures = structuredClone(stored.procedures);
    expect((await post({ ...changedNotes, doctorId: stored.doctorId, procedures })).status).toBe(200);
    expect(boundary.saveClinicalDraft).toHaveBeenCalledWith(expect.objectContaining({
      procedures: undefined, assistantProcedures: procedures,
      actor: { role: "assistant", username: "synthetic-assistant" },
    }));
  });

  it("preserves the addendum path without saving a draft", async () => {
    boundary.addVisitAddendum.mockResolvedValue(true);
    expect((await post({ action: "addendum", text: "Synthetic addendum" })).status).toBe(200);
    expect(boundary.saveClinicalDraft).not.toHaveBeenCalled();
    expect(boundary.addVisitAddendum).toHaveBeenCalledTimes(1);
    expect(boundary.recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "visit.addendum" }));
  });

  it("preserves sign rejection without saving a draft", async () => {
    boundary.signClinicalVisit.mockResolvedValue({ reason: "already_signed" });
    expect((await post({ action: "sign" })).status).toBe(409);
    expect(boundary.saveClinicalDraft).not.toHaveBeenCalled();
    expect(boundary.signClinicalVisit).toHaveBeenCalledTimes(1);
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
});
