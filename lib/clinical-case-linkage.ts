/** Shared clinical identity checks. No money, mutation, or free-text scope inference. */
import {
  caseSiteFits, lineLinkage, toothScope, validateLineSite,
  type LineSite, type LinkageSpecialty,
} from "./invoice-clinical-linkage";

export type ClinicalCaseRefusal = "bad_case" | "wrong_specialty" | "wrong_site" | "scope_unknown" | "closed";
export interface ClinicalCaseIdentity {
  patientId: number;
  specialty: string;
  status: string;
  site: string | null;
  /** Undefined for an unbridged case; null means the referenced bridge is missing. */
  ortho?: { patientId: number; status: string } | null;
}

/** Lifecycle/specialty/patient fences match invoice linkage; exact scope uses its canonical matcher. */
export function clinicalCaseCompatibility(input: {
  patientId: number; specialty: LinkageSpecialty; site: LineSite | null; target: ClinicalCaseIdentity;
}): ClinicalCaseRefusal | null {
  const { target } = input;
  if (target.patientId !== input.patientId) return "bad_case";
  if (target.specialty !== input.specialty) return "wrong_specialty";
  if (!["active", "waiting"].includes(target.status)) return "closed";
  if (target.ortho !== undefined && (!target.ortho || target.ortho.patientId !== input.patientId
    || !["active", "retention"].includes(target.ortho.status))) return "closed";
  if (!input.site || !(target.site ?? "").trim()) return "scope_unknown";
  return caseSiteFits(input.specialty, target.site, input.site) ? null : "wrong_site";
}

/** plan_items has no authoritative arch/episodeTeeth columns. Never make the target prove its own scope. */
export function planItemClinicalScope(item: {
  serviceId: number | null; category: string | null; toothCode: number | null; surfaces: string | null;
}): { specialty: LinkageSpecialty; site: LineSite | null } | null {
  const linkage = lineLinkage(item);
  if (linkage.kind !== "clinical") return null;
  const mode = toothScope(item.category);
  if (mode === "arch" || mode === "multi_tooth_episode") return { specialty: linkage.specialty, site: null };
  const checked = validateLineSite(item);
  return { specialty: linkage.specialty, site: checked.ok ? checked.site : null };
}

export const CLINICAL_CASE_LINKAGE_MESSAGE: Record<ClinicalCaseRefusal | "signed_case_lock" | "owner_changed", string> = {
  owner_changed: "تغيّر ملف المريض المرتبط بالسجل. أعد تحميل الملف وتحقق من صلاحية الوصول قبل المحاولة.",
  bad_case: "الحالة المختارة لا تخص هذا المريض.",
  wrong_specialty: "تخصص الحالة لا يطابق تخصص العلاج.",
  wrong_site: "موضع الحالة لا يطابق موضع العلاج.",
  scope_unknown: "نطاق العلاج غير محسوم في السجل. يلزم تحديد موضع موثّق قبل تغيير الحالة؛ لا يُستنتج من النص أو الحالة الجديدة.",
  closed: "لا يمكن تغيير الربط إلى علاج أو خطة أو حالة منتهية. راجع السجل السريري أولًا.",
  signed_case_lock: "لهذا البند عمل سريري موقّع؛ لا يمكن تغيير حالته أو فصلها. يمكنك تعديل الأولوية فقط، والتصحيح يحتاج مسارًا مدقّقًا.",
};
