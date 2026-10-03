import { SPECIALTIES, SPECIALTY_LABEL, type ServiceSpecialty } from "./appointment-services";
import { CASE_STATUSES, PROBLEM_STATUSES, isDependencyMet } from "./cases";
import { isValidTooth } from "./dental";
import { isPatientRecordFocus, resolveCaseFocus, type PatientCaseFocus, type PatientPlanItemFocus, type PatientVisitWorkFocus } from "./patient-workspace-focus";
import { WORKFLOW_ITEM_STATUS_LABEL } from "./workflow";
import type { CasePlanItem, PatientProblem, PlanItemDependency, SpecialtyCase } from "./db";
import type { WorkspaceSection } from "./patient-workspace-navigation";

/** Newly reconstructed read-only presentation adapter, not the missing original source. */
export interface SpecialtyWorkspace {
  id: ServiceSpecialty;
  label: string;
  kind: "dedicated" | "shared";
  destination: WorkspaceSection;
  description: string;
  gap: string;
  aliases: readonly string[];
}
const WORKSPACE_DETAILS: Record<ServiceSpecialty, Omit<SpecialtyWorkspace, "id" | "label">> = {
  general: { kind: "shared", destination: "chart", description: "المخطط السني والترميمات ضمن الزيارة والخطة المشتركة", gap: "المتابعة التخصصية الكاملة ما زالت جزئية.", aliases: ["ترميم", "حشوات", "أسنان عامة"] },
  orthodontics: { kind: "dedicated", destination: "ortho", description: "حالة التقويم والمراحل والتعديلات والسيفالومتري", gap: "التقييم المتقدم والاحتفاظ والتحقق السريري الكامل ما زالت جزئية.", aliases: ["تقويم الأسنان", "سيفالو"] },
  endodontics: { kind: "dedicated", destination: "endo", description: "التشخيص والقنوات والجلسات في حالة علاج الجذور", gap: "ربط الأشعة والمتابعة لكل سن والتحقق السريري الكامل ما زالت جزئية.", aliases: ["علاج العصب", "علاج عصب", "جذور", "عصب"] },
  surgery: { kind: "shared", destination: "cases", description: "الحالات والخطط والموافقات والإحالات المشتركة", gap: "لا مسار جراحي متخصص مكتمل لما قبل العملية وبعدها.", aliases: ["جراحة الفم", "خلع"] },
  implantology: { kind: "shared", destination: "cases", description: "حالة الزراعة وخطتها وروابط المعمل والمستهلكات", gap: "التتبع السريري المتخصص للزرعة ومراحلها غير مكتمل.", aliases: ["زراعة الأسنان", "زرعات"] },
  prosthodontics: { kind: "shared", destination: "lab", description: "التركيبات والطبعات والتجارب والتسليم في طلب المعمل", gap: "مسار المعمل موجود؛ السجل السريري المتخصص الكامل غير مكتمل.", aliases: ["تيجان", "جسور", "تعويضات"] },
  periodontics: { kind: "dedicated", destination: "perio", description: "فحص اللثة وقياساتها مع ارتباط الزيارة والحالة والطبيب", gap: "مساحة الفحص موجودة؛ التحقق الكامل من المسار السريري والإطلاق ما زال مطلوبًا.", aliases: ["دواعم السن", "تنظيف", "لثة"] },
  pediatric: { kind: "shared", destination: "chart", description: "الأسنان اللبنية والحالات والسجل السريري المشترك", gap: "لا بروتوكول أطفال متخصص مكتمل في هذه المساحة.", aliases: ["أسنان الأطفال", "لبنية"] },
  radiology: { kind: "shared", destination: "files", description: "الأشعة والصور والوثائق في ملفات المريض الأصلية", gap: "رفع الصور لا يعني اكتمال دورة طلب الأشعة وتنفيذها واعتماد النتيجة.", aliases: ["صور", "أشعة", "سجلات"] },
  consultation: { kind: "shared", destination: "today", description: "التقييم والملاحظات والمشاكل في الزيارة الحالية", gap: "يستخدم مسار الزيارة المشترك؛ لا نموذج استشارة تخصصي مستقل.", aliases: ["كشف", "استشارة"] },
  emergency: { kind: "shared", destination: "today", description: "توثيق الحالة العاجلة والإجراءات في الزيارة الحالية", gap: "لا يثبت هذا الدليل وجود بروتوكول طوارئ متخصص مكتمل.", aliases: ["ألم", "إسعاف"] },
  cosmetic: { kind: "shared", destination: "cases", description: "الحالة والخطة وروابط التركيبات والخدمات التجميلية", gap: "الأهداف والنتائج التجميلية المتخصصة ليست مسارًا مكتملًا هنا.", aliases: ["تجميل الأسنان", "قشور", "فينير"] },
  other: { kind: "shared", destination: "cases", description: "الحالات والمشاكل والخطط المشتركة دون تصنيف مفترض", gap: "يُحدد نوع العمل من السجل الأصلي؛ لا يُنشأ تخصص إضافي تلقائيًا.", aliases: [] },
};

/** The authoritative 13 service vocabularies, each exactly once; aliases are search only. */
export const SPECIALTY_WORKSPACES: readonly SpecialtyWorkspace[] = SPECIALTIES.map((id) => ({ id, label: SPECIALTY_LABEL[id], ...WORKSPACE_DETAILS[id] }));

// Deliberately omit case item totals and all money. Hidden plan projection must not
// leak through the clinical case row, an unknown spread, or an inferred zero.
export type SpecialtyContextCase = Pick<SpecialtyCase, "id" | "kind" | "orthoCaseId" | "patientId" | "title" | "site" | "problem" | "responsibleName" | "status" | "startedOn" | "outcome"> & { specialty: ServiceSpecialty; waitingOn: string[] };
export type SpecialtyContextProblem = Pick<PatientProblem, "id" | "patientId" | "label" | "site" | "status" | "caseId"> & { specialty: ServiceSpecialty | null };
export type SpecialtyContextItem = Pick<CasePlanItem, "id" | "planId" | "planTitle" | "serviceName" | "toothCode" | "status" | "doctorName" | "caseId">;
export type SpecialtyContextDependency = Pick<PlanItemDependency, "itemId" | "requiresItemId" | "requirement" | "note" | "met">;
export interface SpecialtyContextSnapshot {
  patientId: number;
  cases: SpecialtyContextCase[];
  problems: SpecialtyContextProblem[];
  planVisible: boolean;
  items: SpecialtyContextItem[];
  dependencies: SpecialtyContextDependency[];
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const id = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const nullableId = (value: unknown): value is number | null => value === null || id(value);
const text = (value: unknown): value is string => typeof value === "string";
const nullableText = (value: unknown): value is string | null => value === null || text(value);
const specialty = (value: unknown): value is ServiceSpecialty => SPECIALTIES.some((key) => key === value);
const unavailable = () => new Error("تعذّر تأكيد ارتباطات السجل التخصصي. حدّث الملف؛ لم تُعرض بيانات بديلة.");
const owned = (value: Record<string, unknown>, patientId: number) => !Object.hasOwn(value, "patientId") || value.patientId === patientId;

/** Allowlist one canonical, protected GET /patients/:id/cases. Never writes/bridges. */
export function readSpecialtyContext(payload: unknown, patientId: number): SpecialtyContextSnapshot {
  if (!id(patientId) || !record(payload) || !owned(payload, patientId) || !Array.isArray(payload.cases) || !Array.isArray(payload.problems)
    || typeof payload.planVisible !== "boolean") throw unavailable();
  const caseIds = new Set<number>(), orthoIds = new Set<number>();
  const cases = payload.cases.map((value): SpecialtyContextCase => {
    if (!record(value) || value.patientId !== patientId || !nullableId(value.id) || !nullableId(value.orthoCaseId)
      || !specialty(value.specialty) || !text(value.title) || !value.title.trim() || !nullableText(value.site) || !nullableText(value.problem)
      || !nullableText(value.responsibleName) || !CASE_STATUSES.some((status) => status === value.status)
      || !text(value.startedOn) || !nullableText(value.outcome)
      || (value.waitingOn !== undefined && (!Array.isArray(value.waitingOn) || !value.waitingOn.every(text)))) throw unavailable();
    if (value.kind === "ortho") {
      if (value.id !== null || !id(value.orthoCaseId) || value.specialty !== "orthodontics") throw unavailable();
    } else if (value.kind !== "specialty" || !id(value.id)) throw unavailable();
    if (value.orthoCaseId !== null && (value.specialty !== "orthodontics" || orthoIds.has(value.orthoCaseId))) throw unavailable();
    if (value.id !== null && caseIds.has(value.id)) throw unavailable();
    if (value.id !== null) caseIds.add(value.id);
    if (value.orthoCaseId !== null) orthoIds.add(value.orthoCaseId);
    return { id: value.id, kind: value.kind, orthoCaseId: value.orthoCaseId, patientId,
      specialty: value.specialty, title: value.title, site: value.site, problem: value.problem,
      responsibleName: value.responsibleName, status: value.status as SpecialtyCase["status"], startedOn: value.startedOn,
      outcome: value.outcome, waitingOn: value.waitingOn === undefined ? [] : [...value.waitingOn as string[]] };
  });
  const problemIds = new Set<number>();
  const problems = payload.problems.map((value): SpecialtyContextProblem => {
    if (!record(value) || value.patientId !== patientId || !id(value.id) || problemIds.has(value.id)
      || !text(value.label) || !value.label.trim() || !nullableText(value.site)
      || (value.specialty !== null && !specialty(value.specialty)) || !PROBLEM_STATUSES.some((status) => status === value.status)
      || !nullableId(value.caseId) || (value.caseId !== null && !caseIds.has(value.caseId))) throw unavailable();
    problemIds.add(value.id);
    return { id: value.id, patientId, label: value.label, site: value.site, specialty: value.specialty,
      status: value.status as PatientProblem["status"], caseId: value.caseId };
  });
  // Do not even inspect hidden item/dependency bodies: privacy does not depend on
  // them being empty, well formed, or absent. Case-derived item counts were omitted above.
  if (!payload.planVisible) return { patientId, cases, problems, planVisible: false, items: [], dependencies: [] };
  if (!Array.isArray(payload.items) || !Array.isArray(payload.dependencies)) throw unavailable();
  const itemIds = new Set<number>();
  const items = payload.items.map((value): SpecialtyContextItem => {
    if (!record(value) || !owned(value, patientId) || !id(value.id) || itemIds.has(value.id) || !id(value.planId)
      || !text(value.planTitle) || !text(value.serviceName) || !value.serviceName.trim() || !nullableText(value.doctorName)
      || !nullableId(value.caseId) || (value.caseId !== null && !caseIds.has(value.caseId))
      || !(value.toothCode === null || (id(value.toothCode) && isValidTooth(value.toothCode)))
      || !text(value.status) || !Object.hasOwn(WORKFLOW_ITEM_STATUS_LABEL, value.status)) throw unavailable();
    itemIds.add(value.id);
    return { id: value.id, planId: value.planId, planTitle: value.planTitle, serviceName: value.serviceName,
      caseId: value.caseId, toothCode: value.toothCode, doctorName: value.doctorName, status: value.status };
  });
  const dependencyIds = new Set<string>();
  const dependencies = payload.dependencies.map((value): SpecialtyContextDependency => {
    if (!record(value) || !owned(value, patientId) || !id(value.itemId) || !id(value.requiresItemId) || value.itemId === value.requiresItemId
      || !itemIds.has(value.itemId) || !itemIds.has(value.requiresItemId) || !nullableText(value.note)
      || (value.requirement !== "completed" && value.requirement !== "clearance") || typeof value.met !== "boolean") throw unavailable();
    const key = `${value.itemId}:${value.requiresItemId}`;
    if (dependencyIds.has(key)) throw unavailable();
    dependencyIds.add(key);
    const required = items.find((item) => item.id === value.requiresItemId)!;
    if (value.met !== isDependencyMet(value.requirement, required.status)) throw unavailable();
    return { itemId: value.itemId, requiresItemId: value.requiresItemId, requirement: value.requirement, note: value.note, met: value.met };
  });
  return { patientId, cases, problems, planVisible: true, items, dependencies };
}

export function specialtyCaseFocus(snapshot: SpecialtyContextSnapshot, caseId: number | null): PatientCaseFocus | null {
  if (caseId === null) return null; // An ortho ID is never a saved clinical-case ID.
  const focus: PatientCaseFocus = { kind: "case", patientId: snapshot.patientId, caseId };
  return resolveCaseFocus(snapshot.patientId, focus, snapshot.cases).status === "ready" ? focus : null;
}
function exactItem(snapshot: SpecialtyContextSnapshot, target: SpecialtyContextItem): SpecialtyContextItem | null {
  if (!snapshot.planVisible) return null;
  const matches = snapshot.items.filter((row) => row.id === target.id);
  if (matches.length !== 1) return null;
  const item = matches[0];
  if (item.planId !== target.planId || item.caseId !== target.caseId || item.toothCode !== target.toothCode
    || (item.caseId !== null && !specialtyCaseFocus(snapshot, item.caseId))) return null;
  return item;
}
export function specialtyPlanItemFocus(snapshot: SpecialtyContextSnapshot, target: SpecialtyContextItem): PatientPlanItemFocus | null {
  const item = exactItem(snapshot, target);
  if (!item) return null;
  const focus: PatientPlanItemFocus = { kind: "plan_item", patientId: snapshot.patientId, planId: item.planId, itemId: item.id,
    ...(item.caseId === null ? {} : { caseId: item.caseId }), ...(item.toothCode === null ? {} : { toothCode: item.toothCode }) };
  return isPatientRecordFocus(focus) ? focus : null;
}
/** Review intent only. Current-visit resolver and explicit canonical add own eligibility. */
export function specialtyVisitWorkFocus(snapshot: SpecialtyContextSnapshot, target: SpecialtyContextItem, openVisitId: number | null): PatientVisitWorkFocus | null {
  const item = exactItem(snapshot, target);
  if (!item || !id(openVisitId) || !["planned", "in_progress"].includes(item.status)) return null;
  const focus: PatientVisitWorkFocus = { kind: "visit_work", patientId: snapshot.patientId, visitId: openVisitId,
    planId: item.planId, itemId: item.id, caseId: item.caseId, toothCode: item.toothCode };
  return isPatientRecordFocus(focus) ? focus : null;
}
