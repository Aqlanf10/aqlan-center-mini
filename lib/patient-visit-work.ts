import { SPECIALTIES } from "./appointment-services";
import { isCurrency } from "./money";
import { isBillingRule } from "./workflow";
import { isPatientRecordFocus, type PatientVisitWorkFocus } from "./patient-workspace-focus";
import type { CasePlanItem, SpecialtyCase } from "./db";
import type { PatientPlanProjection } from "./patient-plan-projection";
import type { ProcedureLine } from "./clinical";
import type { BillingRule } from "./workflow";
import type { VisitStatus } from "./flow";
import type { Currency } from "./money";

/** A read adapter only. Eligibility/pricing/writes still belong to the canonical visit. */
export interface VisitWorkOutstanding {
  planItemId: number; serviceId: number | null; planTitle: string; serviceName: string;
  toothCode: number | null; billingRule: BillingRule; sessionCount: number; doneSessions: number;
  unitPriceMinor: number; quantity: number; status: string; planCurrency: Currency;
  includedByAgreement?: boolean; unmetRequirements?: string[];
}
/** Native pg returns the procedure BIGSERIAL as a decimal string. Keep it raw:
 * saved fingerprints compare this same canonical representation across GETs. */
export type VisitWorkProcedure = Omit<ProcedureLine, "id"> & { id: number | string };
export interface VisitWorkSaved {
  id: number; patientId: number | null; status: string; signedAt: string | null;
  doctorId: number | null; procedures: VisitWorkProcedure[]; outstanding: VisitWorkOutstanding[];
  chiefComplaint: string | null; examination: string | null; diagnosis: string | null;
  treatmentDone: string | null; nextPlan: string | null; billingCurrency?: Currency | null;
}
export interface VisitWorkSnapshot {
  visit: VisitWorkSaved;
  plans: PatientPlanProjection[];
  cases: { planVisible: boolean; cases: SpecialtyCase[]; items: CasePlanItem[] };
  workflow: { patient: { id: number } | null; planVisible: boolean; openVisit: { id: number; status: string } | null };
}
export interface VisitWorkDraftIdentity {
  planItemId: number | null; serviceId: number; toothCode: string | number | null;
}
export type VisitWorkFailure = "identity" | "current_visit" | "hidden" | "plan" | "case" | "item" | "changed";
export const VISIT_WORK_FAILURE: Record<VisitWorkFailure, string> = {
  identity: "تعذّر تأكيد هوية المريض والزيارة والبند المحدد. لم يُفتح بديل.",
  current_visit: "الزيارة المحددة ليست الزيارة الحالية المفتوحة أو أصبحت موقّعة/ملغاة. هذا المسار لا يحرّر زيارة تاريخية ولا يبدأ زيارة بديلة.",
  hidden: "تعذّر التحقق من صلاحية قراءة الخطة والحالة. لم يُضف إجراء.",
  plan: "الخطة المحددة لم تعد جارية وموافقًا عليها. راجع الخطة الأصلية قبل التنفيذ.",
  case: "تغيّر ارتباط البند بالحالة أو لم تعد الحالة متاحة. لم تُختر حالة بديلة.",
  item: "البند المحدد لم يعد مطابقًا أو متاحًا في إجراءات الزيارة الأصلية. لم يُختر بند بديل.",
  changed: "تغيّر السجل المحفوظ أو سياق البند منذ المراجعة. ملاحظاتك وإجراءاتك لم تُستبدل؛ احفظ/راجع العمل ثم حدّث المراجعة.",
};
// Canonical queue values from lib/flow.ts; clinical GET alone only exposes signed/open.
const CURRENT_VISIT_QUEUE_STATUSES = ["waiting", "called", "in_chair", "done"] as const satisfies readonly VisitStatus[];
export const isCurrentVisitQueueStatus = (value: string) => CURRENT_VISIT_QUEUE_STATUSES.some((status) => status === value);
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const nullableId = (value: unknown) => value === null || id(value);
const tooth = (value: string | number | null) => value === "" || value === null ? null : Number(value);

/** Stable saved snapshot comparison; structured reference refreshes are deliberately excluded. */
export function visitWorkSavedFingerprint(visit: VisitWorkSaved): string {
  return JSON.stringify([visit.id, visit.patientId, visit.status, visit.signedAt, visit.doctorId,
    visit.chiefComplaint, visit.examination, visit.diagnosis, visit.treatmentDone, visit.nextPlan,
    visit.billingCurrency, visit.procedures]);
}
export type VisitWorkResolution = { status: "unavailable"; reason: VisitWorkFailure } | {
  status: "ready"; item: VisitWorkOutstanding; planItem: PatientPlanProjection["items"][number];
  clinicalCase: SpecialtyCase | null; existing: boolean; fingerprint: string;
};
export function resolveVisitWork(input: {
  focus: PatientVisitWorkFocus; patientId: number; visitId: number; canEditWork: boolean;
  snapshot: VisitWorkSnapshot; loadedVisit: VisitWorkSaved; drafts: readonly VisitWorkDraftIdentity[];
}): VisitWorkResolution {
  const { focus, snapshot, loadedVisit, drafts } = input;
  const fail = (reason: VisitWorkFailure): VisitWorkResolution => ({ status: "unavailable", reason });
  if (!isPatientRecordFocus(focus) || focus.kind !== "visit_work" || focus.patientId !== input.patientId || focus.visitId !== input.visitId) return fail("identity");
  const { visit, workflow, cases, plans } = snapshot;
  if (workflow.patient?.id !== focus.patientId) return fail("identity");
  if (visit.id !== focus.visitId || visit.patientId !== focus.patientId || loadedVisit.id !== focus.visitId || loadedVisit.patientId !== focus.patientId) return fail("identity");
  if (visit.status !== "open" || visit.signedAt !== null || workflow.openVisit?.id !== focus.visitId
    || !isCurrentVisitQueueStatus(workflow.openVisit.status)) return fail("current_visit");
  if (!input.canEditWork || cases.planVisible !== true || workflow.planVisible !== true) return fail("hidden");
  if (visitWorkSavedFingerprint(visit) !== visitWorkSavedFingerprint(loadedVisit)) return fail("changed");
  const parents = plans.filter((row) => row.id === focus.planId);
  if (parents.length !== 1 || parents[0].patientId !== focus.patientId || parents[0].status !== "active" || !parents[0].consentAt) return fail("plan");
  const plan = parents[0];
  const items = plan.items.filter((row) => row.id === focus.itemId);
  const links = cases.items.filter((row) => row.id === focus.itemId);
  const outstanding = visit.outstanding.filter((row) => row.planItemId === focus.itemId);
  if (items.length !== 1 || links.length !== 1 || outstanding.length !== 1) return fail("item");
  const planItem = items[0], link = links[0], item = outstanding[0];
  if (link.planId !== focus.planId || link.caseId !== focus.caseId) return fail("case");
  let clinicalCase: SpecialtyCase | null = null;
  if (focus.caseId !== null) {
    const matches = cases.cases.filter((row) => row.id === focus.caseId);
    if (matches.length !== 1 || matches[0].patientId !== focus.patientId
      || !SPECIALTIES.some((specialty) => specialty === matches[0].specialty)) return fail("case");
    clinicalCase = matches[0];
    if (!nullableId(clinicalCase.responsiblePartyId)) return fail("case");
  }
  if (!["planned", "in_progress"].includes(item.status) || item.status !== planItem.status || link.status !== planItem.status
    || !id(item.serviceId) || item.serviceId !== planItem.serviceId
    || [item.toothCode, planItem.toothCode, link.toothCode].some((value) => value !== focus.toothCode)
    || item.serviceName !== planItem.serviceName || link.serviceName !== planItem.serviceName
    || !isCurrency(item.planCurrency) || item.planCurrency !== plan.baseCurrency || !isBillingRule(item.billingRule)
    || item.billingRule !== planItem.billingRule || item.sessionCount !== planItem.sessionCount
    || !id(item.sessionCount) || !Number.isInteger(item.doneSessions) || item.doneSessions < 0 || item.doneSessions >= item.sessionCount
    || item.doneSessions !== planItem.sessionsCompleted || item.quantity !== planItem.quantity
    || !Number.isSafeInteger(item.unitPriceMinor) || item.unitPriceMinor < 0 || !nullableId(planItem.doctorId) || !nullableId(visit.doctorId)) return fail("item");
  const saved = visit.procedures.filter((row) => row.planItemId === focus.itemId);
  const staged = drafts.filter((row) => row.planItemId === focus.itemId);
  if (saved.length > 1 || staged.length > 1 || (saved.length === 1 && staged.length !== 1)
    || [...saved, ...staged].some((row) => row.serviceId !== item.serviceId || tooth(row.toothCode) !== focus.toothCode)) return fail("changed");
  // Provider roles stay distinct: responsible case doctor, assigned plan doctor,
  // saved visit doctor, and current explicitly editable treating-doctor draft.
  // The latter is not compared/replaced; addPlannedItem owns its existing policy.
  return { status: "ready", item, planItem, clinicalCase, existing: staged.length === 1,
    fingerprint: JSON.stringify([focus, item, planItem, clinicalCase, plan.status, plan.consentAt, plan.baseCurrency]) };
}

/** These are existing protected GETs. A failed read is never an empty projection. */
export async function readVisitWorkSnapshot(focus: PatientVisitWorkFocus, read: typeof fetch = fetch): Promise<VisitWorkSnapshot> {
  const paths = [`/api/visits/${focus.visitId}/clinical`, `/api/patients/${focus.patientId}/plans`,
    `/api/patients/${focus.patientId}/cases`, `/api/patients/${focus.patientId}/workflow`];
  const payloads = await Promise.all(paths.map(async (path) => {
    const response = await read(path, { cache: "no-store" });
    if (!response.ok) throw new Error("protected_read_unavailable");
    return await response.json();
  }));
  const [visit, plans, cases, workflow] = payloads;
  if (!visit || !Array.isArray(visit.procedures) || !Array.isArray(visit.outstanding)
    || !plans || !Array.isArray(plans.plans) || !cases || !Array.isArray(cases.cases) || !Array.isArray(cases.items)
    || !workflow || typeof workflow.planVisible !== "boolean") throw new Error("incomplete_work_projection");
  return { visit, plans: plans.plans, cases, workflow };
}
