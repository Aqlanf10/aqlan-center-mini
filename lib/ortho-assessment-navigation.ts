/** Navigation only. A bookmark carries no findings and never creates a record. */
export const ASSESSMENT_SECTIONS = [
  ["interview", "المقابلة والتاريخ"],
  ["extraoral", "فحص الوجه والابتسامة"],
  ["intraoral", "فحص الفم والإطباق"],
  ["measurements", "الموديلات والقياسات"],
  ["records", "الصور والأشعة"],
  ["ceph", "تحليل السيفالو"],
  ["diagnosis", "التشخيص وقائمة المشاكل"],
  ["comparison", "مقارنة مراحل العلاج"],
] as const;
export type AssessmentSection = typeof ASSESSMENT_SECTIONS[number][0];
const validId = (n: number) => Number.isInteger(n) && n > 0 && n <= 2147483647;
export function assessmentNeighbour(section: AssessmentSection, direction: -1 | 1): AssessmentSection | null {
  const index = ASSESSMENT_SECTIONS.findIndex(([key]) => key === section);
  return index < 0 ? null : ASSESSMENT_SECTIONS[index + direction]?.[0] ?? null;
}
export function assessmentBookmark(patientId: number, caseId: number, section: AssessmentSection): string {
  if (!validId(patientId) || !validId(caseId) || !ASSESSMENT_SECTIONS.some(([key]) => key === section)) throw Error("invalid_assessment_bookmark");
  return `#ortho-assessment/${patientId}/${caseId}/${section}`;
}
export function readAssessmentBookmark(hash: string, patientId: number): { caseId: number; section: AssessmentSection } | null {
  const match = /^#ortho-assessment\/([1-9]\d*)\/([1-9]\d*)\/([a-z]+)$/.exec(hash);
  if (!match || !validId(patientId) || Number(match[1]) !== patientId || !validId(Number(match[2]))
    || !ASSESSMENT_SECTIONS.some(([key]) => key === match[3])) return null;
  return { caseId: Number(match[2]), section: match[3] as AssessmentSection };
}
const BOOKMARK_EVENT = "ortho-assessment-bookmark";
export function subscribeAssessmentBookmark(changed: () => void) {
  window.addEventListener("hashchange", changed);
  window.addEventListener("popstate", changed);
  window.addEventListener(BOOKMARK_EVENT, changed);
  return () => {
    window.removeEventListener("hashchange", changed);
    window.removeEventListener("popstate", changed);
    window.removeEventListener(BOOKMARK_EVENT, changed);
  };
}
export function replaceAssessmentBookmark(host: Window, patientId: number, caseId: number, section: AssessmentSection): boolean {
  if (host.location.pathname !== `/patients/${patientId}`) return false;
  const url = new URL(host.location.href);
  url.hash = assessmentBookmark(patientId, caseId, section);
  host.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  host.dispatchEvent(new Event(BOOKMARK_EVENT));
  return true;
}
