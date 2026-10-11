import { describe, expect, it } from "vitest";
import { canCancelAssessment, isOpenOrthoLifecycle, lifecycleProgress, newAssessmentTreatment, orthoBridgeLifecycle,
  orthoDocumentationContext, parseIntakeLifecycleCommand, permitsOrthoDocumentation, permitsOrthoTreatmentWrite } from "../lib/ortho-assessment-lifecycle";
const open = () => ({ schemaVersion: 1, kind: "open_assessment", commandId: "synthetic_open_command_1", patientId: 7,
  bridge: { mode: "new" }, intakeKind: "new", reason: "Synthetic initial interview" });
describe("explicit canonical assessment intake", () => {
  it("opens with unknown treatment facts rather than an installed appliance or current treatment date", () => {
    const facts = newAssessmentTreatment(); expect(Object.values(facts).every(v => v === null)).toBe(true);
    expect(newAssessmentTreatment()).not.toBe(facts); expect(parseIntakeLifecycleCommand(open()).ok).toBe(true);
  });
  it("rejects automatic finance, clinical defaults and client-authored recorded time", () => {
    for (const extra of [{ planId: 1 }, { startDate: "2026-10-11" }, { arches: "both" }, { appliance: "fixed_metal" }, { recordedAt: "2026-10-11T00:00:00.000Z" }]) {
      expect(parseIntakeLifecycleCommand({ ...open(), ...extra }).ok).toBe(false);
    }
  });
  it("requires explicit exact existing-bridge identity and captures detached command values", () => {
    const command = { ...open(), bridge: { mode: "existing", clinicalCaseId: 9, expectedContentHash: "a".repeat(64) } };
    const parsed = parseIntakeLifecycleCommand(command); expect(parsed.ok).toBe(true);
    command.bridge.clinicalCaseId = 22;
    if (parsed.ok && parsed.value.kind === "open_assessment" && parsed.value.bridge.mode === "existing") expect(parsed.value.bridge.clinicalCaseId).toBe(9);
    for (const bridge of [{ mode: "existing", clinicalCaseId: 9 }, { mode: "new", clinicalCaseId: 9 }, { mode: "existing", clinicalCaseId: "9", expectedContentHash: "a".repeat(64) }]) {
      expect(parseIntakeLifecycleCommand({ ...open(), bridge }).ok).toBe(false);
    }
  });
  it("keeps assessment open for identity reuse while positively refusing every treatment operation", () => {
    expect(isOpenOrthoLifecycle("assessment")).toBe(true); expect(isOpenOrthoLifecycle("assessment_cancelled")).toBe(false);
    for (const state of ["assessment", "assessment_cancelled", "completed", "discontinued", "future_state", null]) expect(permitsOrthoTreatmentWrite(state)).toBe(false);
    for (const state of ["active", "retention"]) expect(permitsOrthoTreatmentWrite(state)).toBe(true);
    expect(permitsOrthoDocumentation("assessment")).toBe(true); expect(permitsOrthoDocumentation("assessment_cancelled")).toBe(true);
    expect(orthoDocumentationContext("assessment_cancelled")).toBe("retrospective");
  });
  it("cancels only an assessment under explicit CAS and maps it to cancellation, never treatment completion", () => {
    const command = { schemaVersion: 1, kind: "cancel_assessment", commandId: "synthetic_cancel_command", patientId: 7,
      orthoCaseId: 8, clinicalCaseId: 9, expectedLifecycleVersion: 1, reason: "Synthetic evaluation episode cancelled" };
    expect(parseIntakeLifecycleCommand(command).ok).toBe(true);
    for (const changed of [{ reason: "" }, { expectedLifecycleVersion: 0 }, { expectedLifecycleVersion: "1" }, { kind: "complete" }]) expect(parseIntakeLifecycleCommand({ ...command, ...changed }).ok).toBe(false);
    expect(canCancelAssessment("assessment")).toBe(true); expect(canCancelAssessment("active")).toBe(false);
    expect(orthoBridgeLifecycle("assessment")).toBe("waiting"); expect(orthoBridgeLifecycle("assessment_cancelled")).toBe("cancelled");
  });
  it("never computes elapsed treatment from opening time, missing start, invalid day or future day", () => {
    const base = { status: "active" as const, startDate: null, plannedMonths: null, today: "2026-10-11", adjustments: 0, lastAdjustmentDate: null };
    expect(lifecycleProgress({ ...base, status: "assessment", startDate: "2026-01-01", plannedMonths: 18 })).toMatchObject({ state: "assessment_only", monthsElapsed: null, percent: null });
    for (const startDate of [null, "2026-02-30", "2026-10-12"]) expect(lifecycleProgress({ ...base, startDate })).toMatchObject({ state: "unknown", monthsElapsed: null, percent: null });
    expect(lifecycleProgress({ ...base, startDate: "2026-01-01" })).toMatchObject({ state: "partly_known", monthsPlanned: null, monthsRemaining: null, percent: null, overdue: null });
    expect(lifecycleProgress({ ...base, startDate: "2026-01-01", plannedMonths: 18 }).state).toBe("known");
  });
});

it("rejects unsupported early-year arithmetic and uses one admitted last-adjustment date in every branch", () => {
  const base = { status: "active" as const, startDate: null, plannedMonths: null, today: "2026-10-11", adjustments: 0, lastAdjustmentDate: null };
  for (const startDate of ["0000-01-01", "0001-01-01", "0099-01-01"]) expect(lifecycleProgress({ ...base, startDate }).monthsElapsed).toBeNull();
  for (const status of ["active", "assessment", "assessment_cancelled"] as const) for (const startDate of [null, "2026-01-01"]) {
    for (const lastAdjustmentDate of ["2026-02-30", "2026-10-12", "0099-01-01", "not-a-date"]) {
      expect(lifecycleProgress({ ...base, status, startDate, lastAdjustmentDate })).toMatchObject({ lastAdjustment: null, daysSinceLast: null });
    }
  }
  expect(lifecycleProgress({ ...base, lastAdjustmentDate: "2026-10-10" })).toMatchObject({ monthsElapsed: null, lastAdjustment: "2026-10-10", daysSinceLast: 1 });
  expect(parseIntakeLifecycleCommand({ ...open(), intakeKind: { toString: "new" } }).ok).toBe(false);
});

it("admits explicit activation facts and unknown start without creating consent or money", () => {
  const command = { schemaVersion: 1, kind: "activate_assessment", commandId: "synthetic_activate_command", patientId: 7,
    orthoCaseId: 8, clinicalCaseId: 9, expectedLifecycleVersion: 1, reason: "Synthetic documented treatment start",
    treatment: { appliance: "fixed_metal", arches: "both", slot: null, bracketSystem: null, phase: "aligning",
      start: { state: "unknown", reason: "Transferred start date not available" }, plannedMonths: null }, financialPlan: null };
  const parsed = parseIntakeLifecycleCommand(command); expect(parsed.ok).toBe(true);
  if (parsed.ok && parsed.value.kind === "activate_assessment") {
    expect(parsed.value.treatment.start).toEqual(command.treatment.start); expect(parsed.value.treatment.slot).toBeNull();
    expect(parsed.value.treatment.plannedMonths).toBeNull(); expect(parsed.value.financialPlan).toBeNull();
  }
  for (const extra of [{ consented: true }, { invoiceId: 1 }, { amountMinor: 1000 }]) expect(parseIntakeLifecycleCommand({ ...command, ...extra }).ok).toBe(false);
  expect(parseIntakeLifecycleCommand({ ...command, treatment: { ...command.treatment, arches: null } }).ok).toBe(false);
  expect(parseIntakeLifecycleCommand({ ...command, treatment: { ...command.treatment, start: { state: "known", date: "2026-02-30" } } }).ok).toBe(false);
  expect(parseIntakeLifecycleCommand({ ...command, treatment: { ...command.treatment, appliance: "aligners", slot: "022" } }).ok).toBe(false);
  expect(parseIntakeLifecycleCommand({ ...command, financialPlan: { id: 1 } }).ok).toBe(false);
});
