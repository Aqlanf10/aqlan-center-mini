import type { OrthoPillar } from "./patient-navigation";
import type { CaseStatus } from "./ortho";

/** View organisation only. None of these values creates or approves clinical work. */
export const ORTHO_JOURNEY_SECTIONS = ["summary", "records", "plan", "retention", "presentation"] as const;
export type OrthoJourneySection = typeof ORTHO_JOURNEY_SECTIONS[number];
export type OrthoJourneyLocale = "ar" | "en";
export type OrthoJourneyDirection = "rtl" | "ltr";

/** The thirteen input steps retain their order independently of the five containers. */
export const ORTHO_JOURNEY_STEPS = [
  { id: "arrival", section: "summary", order: 1 },
  { id: "interview", section: "records", order: 2 },
  { id: "extraoral", section: "records", order: 3 },
  { id: "intraoral", section: "records", order: 4 },
  { id: "measurements", section: "records", order: 5 },
  { id: "panorama", section: "records", order: 6 },
  { id: "ceph", section: "records", order: 7 },
  { id: "diagnosis", section: "records", order: 8 },
  { id: "treatment_plan", section: "plan", order: 9 },
  { id: "agreement", section: "plan", order: 10 },
  { id: "visits", section: "summary", order: 11 },
  { id: "outcome_retention", section: "retention", order: 12 },
  { id: "study", section: "presentation", order: 13 },
] as const;
export type OrthoJourneyStep = typeof ORTHO_JOURNEY_STEPS[number]["id"];
export interface OrthoJourneySelection {
  readonly section: OrthoJourneySection;
  readonly step: OrthoJourneyStep;
}
export type OrthoJourneyStepStatus = "not_started" | "draft" | "inputs_complete" | "needs_review" | "approved";
/** Absence means unknown, never not_started. Applicability/authority belongs to the source owner. */
export type OrthoJourneyStepEvidence = Readonly<Partial<Record<OrthoJourneyStep, Readonly<{
  status?: OrthoJourneyStepStatus;
  note?: string;
}>>>>;

/** Central copy for this navigation; no patient, clinic, source-document or clinical defaults. */
export const ORTHO_JOURNEY_COPY = {
  ar: {
    navigation: "أقسام حالة التقويم", section: "القسم", step: "خطوة القسم", journey: "مسار ملف التقويم",
    previous: "الخطوة السابقة", next: "الخطوة التالية", stepNumber: "الخطوة", of: "من",
    keyboard: "استخدم السهمين للتنقل بين الأقسام، ثم Enter أو المسافة لفتح القسم. Home للأول وEnd للأخير.",
    unknown: "الحالة غير محددة",
    sections: {
      summary: "ملخص الحالة والجلسة", records: "السجلات والتشخيص", plan: "الخطة والميكانيكا والاتفاق",
      retention: "الإنهاء والتثبيت", presentation: "عرض الحالة",
    },
    steps: {
      arrival: "الوصول وبيانات التعريف", interview: "المقابلة والشكوى", extraoral: "الفحص خارج الفم",
      intraoral: "الفحص داخل الفم", measurements: "القياسات وتحليل الموديلات", panorama: "البانوراما",
      ceph: "السيفالو", diagnosis: "خلاصة التشخيص وقائمة المشكلات", treatment_plan: "الأهداف وخطة العلاج والميكانيكا",
      agreement: "الاتفاق المالي والموافقة", visits: "التركيب والزيارات والتحصيل",
      outcome_retention: "النتيجة والإنهاء والتثبيت", study: "دراسة الحالة الموثقة داخل البرنامج",
    },
    statuses: {
      not_started: "لم تبدأ", draft: "مسودة", inputs_complete: "مكتملة المدخلات", needs_review: "تحتاج مراجعة", approved: "معتمدة",
    },
  },
  en: {
    navigation: "Orthodontic case sections", section: "Section", step: "Section step", journey: "Orthodontic case journey",
    previous: "Previous step", next: "Next step", stepNumber: "Step", of: "of",
    keyboard: "Use Left and Right to focus a section, then Enter or Space to open it. Home focuses the first; End the last.",
    unknown: "Status not specified",
    sections: {
      summary: "Case summary and visit", records: "Records and diagnosis", plan: "Plan, mechanics and agreement",
      retention: "Completion and retention", presentation: "Case presentation",
    },
    steps: {
      arrival: "Arrival and identification", interview: "Interview and complaint", extraoral: "Extraoral examination",
      intraoral: "Intraoral examination", measurements: "Measurements and model analysis", panorama: "Panorama",
      ceph: "Cephalometrics", diagnosis: "Diagnosis and problem list", treatment_plan: "Objectives, treatment plan and mechanics",
      agreement: "Financial agreement and consent", visits: "Appliance placement, visits and collection",
      outcome_retention: "Outcome, completion and retention", study: "Documented in-app case study",
    },
    statuses: {
      not_started: "Not started", draft: "Draft", inputs_complete: "Inputs complete", needs_review: "Needs review", approved: "Approved",
    },
  },
} as const;

export const ORTHO_JOURNEY_SECTION_ENTRY: Readonly<Record<OrthoJourneySection, OrthoJourneyStep>> = {
  summary: "visits", records: "interview", plan: "treatment_plan", retention: "outcome_retention", presentation: "study",
};
/** The canonical route still has exactly FOUR pillars. In particular, plan is prescription. */
export const ORTHO_JOURNEY_COMPATIBILITY_PILLAR: Readonly<Record<OrthoJourneySection, OrthoPillar>> = {
  summary: "wires", records: "diagnostics", plan: "prescription", retention: "retention", presentation: "diagnostics",
};
export type OrthoJourneySubview = "summary" | "assessment" | "records" | "ceph" | "diagnosis" | "plan" | "agreement" | "retention" | "study";
const STEP_SUBVIEW: Readonly<Record<OrthoJourneyStep, OrthoJourneySubview>> = {
  arrival: "summary", interview: "assessment", extraoral: "assessment", intraoral: "assessment", measurements: "assessment",
  panorama: "records", ceph: "ceph", diagnosis: "diagnosis", treatment_plan: "plan", agreement: "agreement",
  visits: "summary", outcome_retention: "retention", study: "study",
};
export interface OrthoJourneyRouteHint {
  readonly pillar: OrthoPillar;
  /** Caller-owned subview, NOT a canonical URL value or clinical reference. */
  readonly subview: OrthoJourneySubview;
}

export function isOrthoJourneySection(value: unknown): value is OrthoJourneySection {
  return ORTHO_JOURNEY_SECTIONS.some(section => section === value);
}
export function isOrthoJourneyStep(value: unknown): value is OrthoJourneyStep {
  return ORTHO_JOURNEY_STEPS.some(step => step.id === value);
}
export function orthoJourneySelection(step: OrthoJourneyStep): OrthoJourneySelection {
  const definition = ORTHO_JOURNEY_STEPS.find(value => value.id === step);
  if (!definition) throw new Error("Invalid orthodontic journey step");
  return { section: definition.section, step: definition.id };
}
export function isOrthoJourneySelection(value: unknown): value is OrthoJourneySelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return ORTHO_JOURNEY_STEPS.some(step => step.id === candidate.step && step.section === candidate.section);
}
export function sameOrthoJourneySelection(a: OrthoJourneySelection, b: OrthoJourneySelection): boolean {
  return a.section === b.section && a.step === b.step;
}
/** Returns fresh display state only. A section click does not complete or save any step. */
export function orthoJourneySectionEntry(section: OrthoJourneySection): OrthoJourneySelection {
  return orthoJourneySelection(ORTHO_JOURNEY_SECTION_ENTRY[section]);
}
export function orthoJourneyStepsForSection(section: OrthoJourneySection) {
  return ORTHO_JOURNEY_STEPS.filter(step => step.section === section);
}
export function adjacentOrthoJourneyStep(selection: OrthoJourneySelection, direction: "previous" | "next"): OrthoJourneySelection | null {
  if (!isOrthoJourneySelection(selection)) return null;
  const index = ORTHO_JOURNEY_STEPS.findIndex(step => step.id === selection.step);
  const target = ORTHO_JOURNEY_STEPS[index + (direction === "previous" ? -1 : 1)];
  return target ? orthoJourneySelection(target.id) : null;
}
/** Explicit canonical URL wins. Missing lifecycle/status never means new or complete. */
export function initialOrthoJourneySelection(input: { pillar?: OrthoPillar | null; status?: CaseStatus | null } = {}): OrthoJourneySelection {
  if (input.pillar === "wires") return orthoJourneySectionEntry("summary");
  if (input.pillar === "diagnostics") return orthoJourneySectionEntry("records");
  if (input.pillar === "prescription") return orthoJourneySectionEntry("plan");
  if (input.pillar === "retention") return orthoJourneySectionEntry("retention");
  // Only the actual, explicit case status can opt into assessment-first navigation.
  return orthoJourneySectionEntry(input.status === "assessment" || input.status === "assessment_cancelled" ? "records" : "summary");
}
export function orthoJourneyRouteHint(selection: OrthoJourneySelection): OrthoJourneyRouteHint {
  if (!isOrthoJourneySelection(selection)) throw new Error("Invalid orthodontic journey selection");
  return { pillar: ORTHO_JOURNEY_COMPATIBILITY_PILLAR[selection.section], subview: STEP_SUBVIEW[selection.step] };
}
/** Manual-activation tab keyboard movement; focusing a tab is not navigation. */
export function orthoJourneyTabFocus(current: OrthoJourneySection, key: string, direction: OrthoJourneyDirection): OrthoJourneySection | null {
  const index = ORTHO_JOURNEY_SECTIONS.indexOf(current);
  if (index < 0) return null;
  if (key === "Home") return ORTHO_JOURNEY_SECTIONS[0];
  if (key === "End") return ORTHO_JOURNEY_SECTIONS[ORTHO_JOURNEY_SECTIONS.length - 1];
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  const delta = (key === "ArrowRight" ? 1 : -1) * (direction === "rtl" ? -1 : 1);
  return ORTHO_JOURNEY_SECTIONS[(index + delta + ORTHO_JOURNEY_SECTIONS.length) % ORTHO_JOURNEY_SECTIONS.length];
}
export function orthoJourneyTabId(id: string, section: OrthoJourneySection): string {
  return `${id}-tab-${section}`;
}
export type OrthoJourneyNavigationSource = "section" | "step" | "previous" | "next";
export interface OrthoJourneyNavigationRequest {
  /** Opaque identity of the caller's current patient/case/authority navigation lifetime. */
  readonly scope: object;
  readonly from: OrthoJourneySelection;
  readonly to: OrthoJourneySelection;
  readonly source: OrthoJourneyNavigationSource;
  readonly route: OrthoJourneyRouteHint;
}
