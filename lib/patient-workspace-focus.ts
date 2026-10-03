import { isValidTooth } from "./dental";
import type { PatientLocation } from "./patient-navigation";

/** Read-only intent. It is never a clinical, plan, provider or financial write payload. */
export type PatientRecordFocus =
  | { kind: "case"; patientId: number; caseId: number }
  | { kind: "plan_item"; patientId: number; planId: number; itemId: number; caseId?: number; toothCode?: number }
  | { kind: "visit_work"; patientId: number; visitId: number; planId: number; itemId: number; caseId: number | null; toothCode: number | null };
export type PatientCaseFocus = Extract<PatientRecordFocus, { kind: "case" }>;
export type PatientPlanItemFocus = Extract<PatientRecordFocus, { kind: "plan_item" }>;
export type PatientVisitWorkFocus = Extract<PatientRecordFocus, { kind: "visit_work" }>;
export type PatientFocusRead = { status: "none" } | { status: "invalid" } | { status: "valid"; focus: PatientRecordFocus };
export const PATIENT_FOCUS_KEYS = ["focus", "focusPatient", "focusCase", "focusPlan", "focusItem", "focusTooth", "focusVisit"] as const;
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
export function isPatientRecordFocus(value: unknown): value is PatientRecordFocus {
  if (!value || typeof value !== "object") return false;
  const input = value as PatientRecordFocus;
  if (!positiveId(input.patientId)) return false;
  if (input.kind === "case") return positiveId(input.caseId);
  if (input.kind === "visit_work") return positiveId(input.visitId) && positiveId(input.planId) && positiveId(input.itemId)
    && (input.caseId === null || positiveId(input.caseId))
    && (input.toothCode === null || (positiveId(input.toothCode) && isValidTooth(input.toothCode)));
  return input.kind === "plan_item" && positiveId(input.planId) && positiveId(input.itemId)
    && (input.caseId === undefined || positiveId(input.caseId))
    && (input.toothCode === undefined || (positiveId(input.toothCode) && isValidTooth(input.toothCode)));
}
export function readPatientRecordFocus(search: string | URLSearchParams, patientId: number): PatientFocusRead {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  if (!PATIENT_FOCUS_KEYS.some((key) => params.has(key))) return { status: "none" };
  if (!positiveId(patientId) || PATIENT_FOCUS_KEYS.some((key) => params.getAll(key).length > 1)) return { status: "invalid" };
  const number = (key: string) => { const raw = params.get(key); return raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN; };
  const owner = number("focusPatient");
  if (owner !== patientId) return { status: "invalid" };
  const kind = params.get("focus");
  let focus: PatientRecordFocus;
  if (kind !== "visit_work" && params.has("focusVisit")) return { status: "invalid" };
  if (kind === "case") {
    if (params.has("focusPlan") || params.has("focusItem") || params.has("focusTooth")) return { status: "invalid" };
    focus = { kind, patientId: owner, caseId: number("focusCase") };
  } else if (kind === "plan_item") {
    focus = { kind, patientId: owner, planId: number("focusPlan"), itemId: number("focusItem"),
      ...(params.has("focusCase") ? { caseId: number("focusCase") } : {}),
      ...(params.has("focusTooth") ? { toothCode: number("focusTooth") } : {}) };
  } else if (kind === "visit_work") {
    focus = { kind, patientId: owner, visitId: number("focusVisit"), planId: number("focusPlan"), itemId: number("focusItem"),
      caseId: params.get("focusCase") === "none" ? null : number("focusCase"),
      toothCode: params.get("focusTooth") === "none" ? null : number("focusTooth") };
  } else return { status: "invalid" };
  return isPatientRecordFocus(focus) ? { status: "valid", focus } : { status: "invalid" };
}
export function patientRecordFocusKey(focus: PatientRecordFocus | null): string {
  if (!focus) return "none";
  if (focus.kind === "visit_work") return JSON.stringify([focus.kind, focus.patientId, focus.visitId, focus.planId, focus.itemId, focus.caseId, focus.toothCode]);
  return focus.kind === "case" ? JSON.stringify([focus.kind, focus.patientId, focus.caseId])
    : JSON.stringify([focus.kind, focus.patientId, focus.planId, focus.itemId, focus.caseId ?? null, focus.toothCode ?? null]);
}
export function writePatientRecordFocus(params: URLSearchParams, focus: PatientRecordFocus | null): void {
  PATIENT_FOCUS_KEYS.forEach((key) => params.delete(key));
  if (!focus) return;
  params.set("focus", focus.kind); params.set("focusPatient", String(focus.patientId));
  if (focus.kind === "visit_work") {
    params.set("focusVisit", String(focus.visitId)); params.set("focusCase", focus.caseId === null ? "none" : String(focus.caseId));
    params.set("focusTooth", focus.toothCode === null ? "none" : String(focus.toothCode));
    params.set("focusPlan", String(focus.planId)); params.set("focusItem", String(focus.itemId));
    return;
  }
  if (focus.caseId !== undefined) params.set("focusCase", String(focus.caseId));
  if (focus.kind === "plan_item") {
    params.set("focusPlan", String(focus.planId)); params.set("focusItem", String(focus.itemId));
    if (focus.toothCode !== undefined) params.set("focusTooth", String(focus.toothCode));
  }
}
export function focusDestination(focus: PatientRecordFocus): PatientLocation {
  if (focus.kind === "visit_work") return { tab: "today", sub: "chart" };
  return { tab: "treatment", sub: focus.kind === "case" ? "cases" : "plans" };
}
export function focusFitsLocation(focus: PatientRecordFocus, location: PatientLocation): boolean {
  const destination = focusDestination(focus);
  return location.tab === destination.tab && (focus.kind === "visit_work" || location.sub === destination.sub);
}

export type FocusResolution<T> = { status: "ready"; record: T } | { status: "unavailable"; reason: "invalid" | "hidden" | "missing" | "mismatch" | "history_unavailable" };
export function resolveCaseFocus<T extends { id: number | null; patientId: number }>(patientId: number, focus: PatientCaseFocus, cases: readonly T[]): FocusResolution<T> {
  if (!isPatientRecordFocus(focus) || focus.patientId !== patientId) return { status: "unavailable", reason: "invalid" };
  const matches = cases.filter((row) => row.id === focus.caseId);
  if (matches.length !== 1) return { status: "unavailable", reason: "missing" };
  return matches[0].patientId === patientId ? { status: "ready", record: matches[0] } : { status: "unavailable", reason: "mismatch" };
}
interface FocusItem { id: number; toothCode: number | null; status: string }
interface FocusPlan<T extends FocusItem> { id: number; patientId: number; items: readonly T[] }
interface CaseProjection { planVisible: boolean; cases: readonly { id: number | null; patientId: number }[]; items: readonly { id: number; planId: number; caseId: number | null; toothCode: number | null }[] }
export function resolvePlanItemFocus<T extends FocusItem>(patientId: number, focus: PatientPlanItemFocus, plans: readonly FocusPlan<T>[], caseProjection?: CaseProjection | null): FocusResolution<T> {
  if (!isPatientRecordFocus(focus) || focus.patientId !== patientId) return { status: "unavailable", reason: "invalid" };
  const parents = plans.filter((plan) => plan.id === focus.planId);
  if (parents.length !== 1) return { status: "unavailable", reason: "missing" };
  if (parents[0].patientId !== patientId) return { status: "unavailable", reason: "mismatch" };
  const matches = parents[0].items.filter((item) => item.id === focus.itemId);
  if (matches.length !== 1) return { status: "unavailable", reason: "missing" };
  const item = matches[0];
  if (focus.toothCode !== undefined && item.toothCode !== focus.toothCode) return { status: "unavailable", reason: "mismatch" };
  if (focus.caseId !== undefined) {
    if (!caseProjection || caseProjection.planVisible !== true) return { status: "unavailable", reason: "hidden" };
    const cases = caseProjection.cases.filter((row) => row.id === focus.caseId && row.patientId === patientId);
    const links = caseProjection.items.filter((row) => row.id === focus.itemId);
    if (cases.length !== 1 || links.length !== 1 || links[0].planId !== focus.planId || links[0].caseId !== focus.caseId || links[0].toothCode !== item.toothCode) return { status: "unavailable", reason: "mismatch" };
  }
  // The canonical plan grouping does not render cancelled items. This is an
  // explicit history-view limitation, not a missing record or staging rule.
  if (item.status === "cancelled") return { status: "unavailable", reason: "history_unavailable" };
  return { status: "ready", record: item };
}
