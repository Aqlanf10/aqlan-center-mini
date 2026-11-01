import { isKnownZone } from "./clinicZone";
import type { PlanItemStatus, PlanStatus } from "./plans";

export const CLINICAL_PLAN_LIMIT = 100;
export const CLINICAL_PLAN_ITEM_LIMIT = 256;
export const CLINICAL_PLAN_TOTAL_ITEM_LIMIT = 2000;
export interface CanonicalClinicalPlanItem {
  id: number; serviceName: string; category: string | null; toothCode: number | null; surfaces: string | null;
  quantity: number; status: PlanItemStatus; doneAt: string | null; note: string | null;
  plannedVisitNumber: number | null; sessionCount: number | null; sessionsCompleted: number;
  doctorName: string | null; caseSite: string | null;
}
export interface CanonicalClinicalPlan {
  id: number; title: string; status: PlanStatus; startDate: string; createdAt: string; note: string | null;
  consentAt: string | null; consentBy: string | null; consentNote: string | null; items: CanonicalClinicalPlanItem[];
}
export interface CanonicalClinicalPlans {
  projection: "patient-plan-clinical"; clinicTimeZone: string; patientId: number; plans: CanonicalClinicalPlan[]; hasMore: boolean;
}
const integer = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const date = (value: unknown): value is string => text(value) && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const timestamp = (value: unknown): value is string => text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

/** A clinical read is neither a price quote nor authority to perform or bill treatment. */
export function isCanonicalClinicalPlans(value: unknown, patientId: number): value is CanonicalClinicalPlans {
  if (!value || typeof value !== "object") return false;
  const body = value as CanonicalClinicalPlans;
  if (typeof body.clinicTimeZone !== "string" || !isKnownZone(body.clinicTimeZone) || body.projection !== "patient-plan-clinical" || body.patientId !== patientId || !integer(patientId, 1)
    || typeof body.hasMore !== "boolean" || !Array.isArray(body.plans) || body.plans.length > CLINICAL_PLAN_LIMIT) return false;
  const plans = new Set<number>(), items = new Set<number>();
  return body.plans.every(plan => {
    if (!plan || !integer(plan.id, 1) || plans.has(plan.id) || !text(plan.title) || !["active", "completed", "cancelled"].includes(plan.status)
      || !date(plan.startDate) || !timestamp(plan.createdAt) || !nullableText(plan.note) || !nullableText(plan.consentBy) || !nullableText(plan.consentNote)
      || plan.consentAt !== null && !timestamp(plan.consentAt) || !Array.isArray(plan.items) || plan.items.length > CLINICAL_PLAN_ITEM_LIMIT) return false;
    plans.add(plan.id);
    return plan.items.every(item => {
      if (!item || !integer(item.id, 1) || items.has(item.id)) return false;
      items.add(item.id);
      return items.size <= CLINICAL_PLAN_TOTAL_ITEM_LIMIT && text(item.serviceName) && nullableText(item.category) && nullableText(item.surfaces)
        && (item.toothCode === null || integer(item.toothCode)) && integer(item.quantity) && ["planned", "done", "cancelled"].includes(item.status)
        && (item.doneAt === null || timestamp(item.doneAt)) && nullableText(item.note) && nullableText(item.doctorName) && nullableText(item.caseSite)
        && (item.plannedVisitNumber === null || integer(item.plannedVisitNumber)) && (item.sessionCount === null || integer(item.sessionCount)) && integer(item.sessionsCompleted);
    });
  });
}
