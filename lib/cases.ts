/**
 * (CASE-MODEL-1) الحالات التخصصية وقائمة المشاكل واعتماديات بنود الخطة — المنطق الخالص.
 *
 * مريضٌ واحد ← سجلٌّ سريري واحد ← حالاتٌ تخصصية كثيرة. مريض التقويم قد يحتاج علاج عصبٍ في ٢١
 * قبل أن تُركَّب عليه الحاصرة، ثم تاجًا بعده: ثلاث حالات بثلاثة أطباء، وخطة واحدة، وحسابٌ واحد.
 * هنا التحقق والتسميات وقواعد الانتقال واكتشاف الدورات وتقييم الاعتماديات — والقاعدة والشاشة
 * تستهلكانها. التصميم: docs/MULTISPECIALTY_PATIENT_ARCHITECTURE.md §3.
 */

import { SPECIALTIES, SPECIALTY_LABEL, type ServiceSpecialty } from "./appointment-services";

export { SPECIALTY_LABEL };

export const CASE_STATUSES = ["active", "waiting", "completed", "closed", "cancelled"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_STATUS_LABEL: Record<CaseStatus, string> = {
  active: "جارية",
  waiting: "بانتظار",
  completed: "اكتملت",
  closed: "أُغلقت دون إكمال",
  cancelled: "أُلغيت",
};

/** الحالة المنتهية لا تعود: النتيجة سجلٌّ سريري، وتصحيحها حالةٌ جديدة لا إعادة فتح صامتة. */
export const CASE_TERMINAL: readonly CaseStatus[] = ["completed", "closed", "cancelled"];

const CASE_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  active: ["waiting", "completed", "closed", "cancelled"],
  waiting: ["active", "completed", "closed", "cancelled"],
  completed: [],
  closed: [],
  cancelled: [],
};

export function canMoveCase(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_TRANSITIONS[from].includes(to);
}

export const PROBLEM_STATUSES = ["active", "resolved", "inactive"] as const;
export type ProblemStatus = (typeof PROBLEM_STATUSES)[number];

export const PROBLEM_STATUS_LABEL: Record<ProblemStatus, string> = {
  active: "نشطة",
  resolved: "محلولة",
  inactive: "غير نشطة",
};

export const DEPENDENCY_REQUIREMENTS = ["completed", "clearance"] as const;
export type DependencyRequirement = (typeof DEPENDENCY_REQUIREMENTS)[number];

export const DEPENDENCY_REQUIREMENT_LABEL: Record<DependencyRequirement, string> = {
  completed: "بعد اكتماله",
  clearance: "بعد إذنٍ سريري منه",
};

type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const text = (raw: unknown, max: number): string | null => {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value ? value.slice(0, max) : null;
};

const positiveId = (raw: unknown): number | null => {
  const id = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof id === "number" && Number.isInteger(id) && id > 0 ? id : null;
};

export interface CaseDraft {
  specialty: ServiceSpecialty;
  title: string;
  site: string | null;
  problem: string | null;
  responsiblePartyId: number | null;
  orthoCaseId: number | null;
}

export function checkCaseDraft(body: Record<string, unknown>): Checked<CaseDraft> {
  const specialty = body.specialty as ServiceSpecialty;
  if (!SPECIALTIES.includes(specialty)) return { ok: false, message: "اختر تخصص الحالة." };
  const title = text(body.title, 160);
  if (!title) return { ok: false, message: "اكتب عنوان الحالة — مثل «علاج عصب — سن ٣٦»." };
  if (body.responsiblePartyId !== undefined && body.responsiblePartyId !== null && body.responsiblePartyId !== ""
    && positiveId(body.responsiblePartyId) === null) {
    return { ok: false, message: "الطبيب المسؤول غير صالح." };
  }
  if (body.orthoCaseId !== undefined && body.orthoCaseId !== null && positiveId(body.orthoCaseId) === null) {
    return { ok: false, message: "حالة التقويم غير صالحة." };
  }
  return {
    ok: true,
    value: {
      specialty, title,
      site: text(body.site, 60),
      problem: text(body.problem, 2000),
      responsiblePartyId: positiveId(body.responsiblePartyId),
      orthoCaseId: positiveId(body.orthoCaseId),
    },
  };
}

export interface CaseStatusChange { status: CaseStatus; outcome: string | null }

export function checkCaseStatusChange(body: Record<string, unknown>): Checked<CaseStatusChange> {
  const status = body.status as CaseStatus;
  if (!CASE_STATUSES.includes(status)) return { ok: false, message: "حالة غير معروفة." };
  const outcome = text(body.outcome, 2000);
  if (status === "cancelled" && !outcome) return { ok: false, message: "اكتب سبب إلغاء الحالة." };
  return { ok: true, value: { status, outcome } };
}

export interface ProblemDraft {
  label: string;
  site: string | null;
  specialty: ServiceSpecialty | null;
  caseId: number | null;
}

export function checkProblemDraft(body: Record<string, unknown>): Checked<ProblemDraft> {
  const label = text(body.label, 200);
  if (!label) return { ok: false, message: "اكتب المشكلة — مثل «التهاب لب غير عكوس ٣٦»." };
  const specialty = body.specialty === undefined || body.specialty === null || body.specialty === ""
    ? null : body.specialty as ServiceSpecialty;
  if (specialty !== null && !SPECIALTIES.includes(specialty)) return { ok: false, message: "تخصص غير معروف." };
  return { ok: true, value: { label, site: text(body.site, 60), specialty, caseId: positiveId(body.caseId) } };
}

export function checkProblemStatus(body: Record<string, unknown>): Checked<ProblemStatus> {
  const status = body.status as ProblemStatus;
  return PROBLEM_STATUSES.includes(status) ? { ok: true, value: status } : { ok: false, message: "حالة غير معروفة." };
}

export interface DependencyDraft { requiresItemId: number; requirement: DependencyRequirement; note: string | null }

export function checkDependencyDraft(itemId: number, body: Record<string, unknown>): Checked<DependencyDraft> {
  const requiresItemId = positiveId(body.requiresItemId);
  if (!requiresItemId) return { ok: false, message: "اختر البند المطلوب قبله." };
  if (requiresItemId === itemId) return { ok: false, message: "البند لا يتطلب نفسه." };
  const requirement = (body.requirement ?? "completed") as DependencyRequirement;
  if (!DEPENDENCY_REQUIREMENTS.includes(requirement)) return { ok: false, message: "نوع الاعتماد غير معروف." };
  return { ok: true, value: { requiresItemId, requirement, note: text(body.note, 500) } };
}

/**
 * هل إضافة «itemId يتطلب requiresItemId» تصنع دورة؟ نعم إن كان requiresItemId يصل إلى itemId
 * عبر الاعتماديات القائمة — فيصير كلٌّ منهما بانتظار الآخر إلى الأبد.
 */
export function wouldCreateCycle(
  edges: readonly { itemId: number; requiresItemId: number }[],
  itemId: number,
  requiresItemId: number,
): boolean {
  if (itemId === requiresItemId) return true;
  const next = new Map<number, number[]>();
  for (const edge of edges) next.set(edge.itemId, [...(next.get(edge.itemId) ?? []), edge.requiresItemId]);
  const seen = new Set<number>();
  const stack = [requiresItemId];
  while (stack.length > 0) {
    const current = stack.pop() as number;
    if (current === itemId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(next.get(current) ?? []));
  }
  return false;
}

/**
 * الاعتماد متحقَّق إن كان البند المطلوب «منفَّذًا» (أو ملغًى — لا ينتظر أحدٌ بندًا أُلغي)؛
 * و«الإذن السريري» يكفيه أن يكون قد بدأ. تحذيرٌ لا منع: الطبيب يتجاوزه بسببٍ يُدقَّق.
 */
export function isDependencyMet(requirement: DependencyRequirement, requiredStatus: string): boolean {
  if (requiredStatus === "done" || requiredStatus === "cancelled") return true;
  return requirement === "clearance" && requiredStatus === "in_progress";
}
