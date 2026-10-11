/** Assessment intake is part of the canonical Ortho case, never an appliance installation. */
import { caseProgress, daysBetween, isOpenOrthoCase, isTreatmentOrthoCase, type CaseStatus, type Appliance, type Arches, type CaseProgress, type OrthoPhase, type SlotSize } from "./ortho";
export type OrthoAssessmentStatus = "assessment" | "assessment_cancelled";
export type OrthoLifecycleStatus = CaseStatus;
export const ORTHO_LIFECYCLE_VERSION = 1 as const;
export const isAssessmentStatus = (status: unknown): status is OrthoAssessmentStatus => status === "assessment" || status === "assessment_cancelled";
export const isOpenOrthoLifecycle = isOpenOrthoCase;
/** Positive admission is required; new states must never inherit treatment privileges. */
export const permitsOrthoTreatmentWrite = isTreatmentOrthoCase;
export const permitsOrthoDocumentation = (status: unknown): status is OrthoLifecycleStatus =>
  typeof status === "string" && ["assessment", "assessment_cancelled", "active", "retention", "completed", "discontinued"].includes(status);
export const orthoDocumentationContext = (status: OrthoLifecycleStatus): "current" | "retrospective" =>
  status === "assessment_cancelled" || status === "completed" || status === "discontinued" ? "retrospective" : "current";
export function orthoBridgeLifecycle(status: OrthoLifecycleStatus): "waiting" | "active" | "completed" | "cancelled" | "closed" {
  if (status === "assessment") return "waiting";
  if (status === "assessment_cancelled") return "cancelled";
  if (status === "active" || status === "retention") return "active";
  return status === "completed" ? "completed" : "closed";
}
export interface UnknownAssessmentTreatment {
  appliance: null; arches: null; slot: null; bracketSystem: null; phase: null; startDate: null; plannedMonths: null;
  upperWire: null; lowerWire: null; retainer: null; retainerOn: null; planId: null;
}
/** Each call returns a detached value. No today's date, both-arch, 18-month or022 defaults. */
export function newAssessmentTreatment(): UnknownAssessmentTreatment {
  return { appliance: null, arches: null, slot: null, bracketSystem: null, phase: null, startDate: null, plannedMonths: null,
    upperWire: null, lowerWire: null, retainer: null, retainerOn: null, planId: null };
}
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const exact = (v: Record<string, unknown>, names: readonly string[]): boolean => Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
const id = (v: unknown): v is number => Number.isSafeInteger(v) && typeof v === "number" && v > 0;
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v === v.trim() && v.length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const commandId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(v);
export type AssessmentBridgeSelection = { mode: "new" } | { mode: "existing"; clinicalCaseId: number; expectedContentHash: string };
export interface OpenAssessmentCommand {
  schemaVersion: 1; kind: "open_assessment"; commandId: string; patientId: number;
  bridge: AssessmentBridgeSelection; intakeKind: "new" | "transferred" | "unknown"; reason: string;
}
export interface CancelAssessmentCommand {
  schemaVersion: 1; kind: "cancel_assessment"; commandId: string; patientId: number; orthoCaseId: number; clinicalCaseId: number;
  expectedLifecycleVersion: number; reason: string;
}
export type RecordedTreatmentStart = { state: "known"; date: string } | { state: "unknown"; reason: string };
export interface ActivateAssessmentCommand {
  schemaVersion: 1; kind: "activate_assessment"; commandId: string; patientId: number; orthoCaseId: number; clinicalCaseId: number;
  expectedLifecycleVersion: number; reason: string;
  treatment: { appliance: Appliance; arches: Arches; slot: SlotSize | null; bracketSystem: string | null; phase: OrthoPhase;
    start: RecordedTreatmentStart; plannedMonths: number | null };
  financialPlan: { id: number; expectedContentHash: string } | null;
}
export type IntakeLifecycleCommand = OpenAssessmentCommand | CancelAssessmentCommand | ActivateAssessmentCommand;
export type LifecycleChecked<T> = { ok: true; value: T } | { ok: false; code: string };
/** No client supplies recorded time, creator, monetary data or inferred clinical treatment fields. */
export function parseIntakeLifecycleCommand(raw: unknown): LifecycleChecked<IntakeLifecycleCommand> {
  const fail = (code: string): LifecycleChecked<never> => ({ ok: false, code });
  if (!plain(raw) || raw.schemaVersion !== 1 || !commandId(raw.commandId) || !id(raw.patientId) || !text(raw.reason, 500)) return fail("invalid_lifecycle_command");
  if (raw.kind === "open_assessment") {
    if (!exact(raw, ["schemaVersion", "kind", "commandId", "patientId", "bridge", "intakeKind", "reason"])
      || typeof raw.intakeKind !== "string" || !["new", "transferred", "unknown"].includes(raw.intakeKind) || !plain(raw.bridge)) return fail("invalid_assessment_open");
    let bridge: AssessmentBridgeSelection;
    if (raw.bridge.mode === "new" && exact(raw.bridge, ["mode"])) bridge = { mode: "new" };
    else if (raw.bridge.mode === "existing" && exact(raw.bridge, ["mode", "clinicalCaseId", "expectedContentHash"])
      && id(raw.bridge.clinicalCaseId) && hash(raw.bridge.expectedContentHash)) bridge = { mode: "existing", clinicalCaseId: raw.bridge.clinicalCaseId, expectedContentHash: raw.bridge.expectedContentHash };
    else return fail("invalid_bridge_selection");
    return { ok: true, value: { schemaVersion: 1, kind: "open_assessment", commandId: raw.commandId, patientId: raw.patientId,
      bridge, intakeKind: raw.intakeKind as OpenAssessmentCommand["intakeKind"], reason: raw.reason } };
  }
  if (raw.kind === "cancel_assessment") {
    if (!exact(raw, ["schemaVersion", "kind", "commandId", "patientId", "orthoCaseId", "clinicalCaseId", "expectedLifecycleVersion", "reason"])
      || !id(raw.orthoCaseId) || !id(raw.clinicalCaseId) || !id(raw.expectedLifecycleVersion)) return fail("invalid_assessment_cancel");
    return { ok: true, value: { schemaVersion: 1, kind: "cancel_assessment", commandId: raw.commandId, patientId: raw.patientId,
      orthoCaseId: raw.orthoCaseId, clinicalCaseId: raw.clinicalCaseId, expectedLifecycleVersion: raw.expectedLifecycleVersion, reason: raw.reason } };
  }
  if (raw.kind === "activate_assessment") {
    if (!exact(raw, ["schemaVersion", "kind", "commandId", "patientId", "orthoCaseId", "clinicalCaseId", "expectedLifecycleVersion", "reason", "treatment", "financialPlan"])
      || !id(raw.orthoCaseId) || !id(raw.clinicalCaseId) || !id(raw.expectedLifecycleVersion) || !plain(raw.treatment)) return fail("invalid_assessment_activation");
    const t = raw.treatment;
    if (!exact(t, ["appliance", "arches", "slot", "bracketSystem", "phase", "start", "plannedMonths"])
      || typeof t.appliance !== "string" || !["fixed_metal", "fixed_ceramic", "aligners", "removable", "functional"].includes(t.appliance)
      || typeof t.arches !== "string" || !["upper", "lower", "both"].includes(t.arches)
      || !(t.slot === null || t.slot === "018" || t.slot === "022")
      || !(t.bracketSystem === null || text(t.bracketSystem, 80))
      || typeof t.phase !== "string" || !["aligning", "working", "finishing", "retention"].includes(t.phase)
      || !(t.plannedMonths === null || Number.isSafeInteger(t.plannedMonths) && typeof t.plannedMonths === "number" && t.plannedMonths >= 1 && t.plannedMonths <= 120)
      || !plain(t.start)) return fail("invalid_activation_facts");
    if (t.appliance !== "fixed_metal" && t.appliance !== "fixed_ceramic" && (t.slot !== null || t.bracketSystem !== null)) return fail("inapplicable_bracket_facts");
    let start: RecordedTreatmentStart;
    if (t.start.state === "known" && exact(t.start, ["state", "date"]) && isOrthoCalendarDate(t.start.date)) start = { state: "known", date: t.start.date };
    else if (t.start.state === "unknown" && exact(t.start, ["state", "reason"]) && text(t.start.reason, 500)) start = { state: "unknown", reason: t.start.reason };
    else return fail("invalid_treatment_start_evidence");
    let financialPlan: ActivateAssessmentCommand["financialPlan"] = null;
    if (raw.financialPlan !== null) {
      if (!plain(raw.financialPlan) || !exact(raw.financialPlan, ["id", "expectedContentHash"]) || !id(raw.financialPlan.id) || !hash(raw.financialPlan.expectedContentHash)) return fail("invalid_plan_witness");
      financialPlan = { id: raw.financialPlan.id, expectedContentHash: raw.financialPlan.expectedContentHash };
    }
    return { ok: true, value: { schemaVersion: 1, kind: "activate_assessment", commandId: raw.commandId, patientId: raw.patientId,
      orthoCaseId: raw.orthoCaseId, clinicalCaseId: raw.clinicalCaseId, expectedLifecycleVersion: raw.expectedLifecycleVersion, reason: raw.reason,
      treatment: { appliance: t.appliance as Appliance, arches: t.arches as Arches, slot: t.slot, bracketSystem: t.bracketSystem,
        phase: t.phase as OrthoPhase, start, plannedMonths: t.plannedMonths as number | null }, financialPlan } };
  }
  return fail("unsupported_lifecycle_action");
}
export const canCancelAssessment = (status: unknown): boolean => status === "assessment";
export interface OrthoTreatmentFacts {
  appliance: Appliance | null; arches: Arches | null; slot: SlotSize | null; phase: OrthoPhase | null;
  startDate: string | null; plannedMonths: number | null;
}
export function isOrthoCalendarDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\d$/.test(v) || Number(v.slice(0, 4)) < 100) return false;
  const d = new Date(v + "T00:00:00.000Z"); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
}
export interface NullableOrthoProgress extends Omit<CaseProgress, "monthsElapsed" | "monthsPlanned" | "monthsRemaining" | "percent" | "overdue"> {
  state: "assessment_only" | "known" | "partly_known" | "unknown";
  monthsElapsed: number | null; monthsPlanned: number | null; monthsRemaining: number | null; percent: number | null; overdue: boolean | null;
}
/** Shared historical plan display boundary; malformed/unknown values stay unknown. */
export function historicalOrthoPlannedMonths(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 120 ? value : null;
}
/** Reuses the existing display-duration convention; intake timestamps are never passed as a start date. */
export function lifecycleProgress(input: {
  status: OrthoLifecycleStatus; startDate: string | null; plannedMonths: number | null; today: string;
  adjustments: number; lastAdjustmentDate: string | null;
}): NullableOrthoProgress {
  const lastAdjustment = isOrthoCalendarDate(input.lastAdjustmentDate) && isOrthoCalendarDate(input.today) && input.lastAdjustmentDate <= input.today ? input.lastAdjustmentDate : null;
  const base = { adjustments: input.adjustments, lastAdjustment, daysSinceLast: lastAdjustment ? daysBetween(lastAdjustment, input.today) : null,
    monthsElapsed: null, monthsPlanned: null, monthsRemaining: null, percent: null, overdue: null };
  if (isAssessmentStatus(input.status)) return { ...base, daysSinceLast: null, state: "assessment_only" };
  const knownStart = isOrthoCalendarDate(input.startDate) && isOrthoCalendarDate(input.today) && input.startDate <= input.today;
  const knownDuration = historicalOrthoPlannedMonths(input.plannedMonths) !== null;
  // Closing the case is a recorded system operation, not an asserted clinical
  // treatment-end date. Keep historical plan/visit facts without a countdown.
  if (input.status === "completed" || input.status === "discontinued") return {
    ...base, state: knownDuration ? "partly_known" : "unknown", daysSinceLast: null,
    monthsPlanned: knownDuration ? input.plannedMonths : null,
  };
  if (!knownStart) return { ...base, state: "unknown", monthsPlanned: knownDuration ? input.plannedMonths : null };
  const value = caseProgress({ startDate: input.startDate!, today: input.today, plannedMonths: knownDuration ? input.plannedMonths! : 0,
    adjustments: input.adjustments, lastAdjustmentDate: lastAdjustment });
  return { ...value, state: knownDuration ? "known" : "partly_known", monthsPlanned: knownDuration ? value.monthsPlanned : null,
    monthsRemaining: knownDuration ? value.monthsRemaining : null, percent: knownDuration ? value.percent : null, overdue: knownDuration ? value.overdue : null };
}
