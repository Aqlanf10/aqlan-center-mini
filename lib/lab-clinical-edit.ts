import { labToothInputProblem, parseLabTeeth, WORK_TYPES } from "./lab";
import { labShadeSelectionForCode, parseLabShadeSpecification, type LabShadeSpecification } from "./lab-shades";

/** Explicit clinical snapshot, independent from the immutable quoted financial snapshot. */
export interface LabClinicalSnapshot {
  doctorId: number | null;
  workType: string;
  toothNumbers: string | null;
  shade: string | null;
  shadeSpecification: LabShadeSpecification | null;
  partyId: number | null;
  labName: string;
  labPhone: string | null;
}
const keys = ["doctorId", "workType", "toothNumbers", "shade", "shadeSpecification", "partyId", "labName", "labPhone"];
export function parseLabClinicalSnapshot(value: unknown): LabClinicalSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).length !== keys.length || keys.some(key => !Object.hasOwn(v, key))) return null;
  for (const key of ["doctorId", "partyId"]) if (v[key] !== null && (!Number.isSafeInteger(v[key]) || Number(v[key]) <= 0)) return null;
  if (typeof v.workType !== "string" || !v.workType.trim() || v.workType.length > 80
    || typeof v.labName !== "string" || !v.labName.trim() || v.labName.length > 80) return null;
  for (const [key, limit] of [["toothNumbers", 4096], ["shade", 30], ["labPhone", 40]] as const) {
    if (v[key] !== null && (typeof v[key] !== "string" || (v[key] as string).length > limit)) return null;
  }
  const shades = parseLabShadeSpecification(v.shadeSpecification);
  if (!shades.ok) return null;
  return { doctorId: v.doctorId as number | null, partyId: v.partyId as number | null,
    workType: v.workType, labName: v.labName, labPhone: v.labPhone as string | null,
    toothNumbers: v.toothNumbers as string | null, shade: v.shade as string | null, shadeSpecification: shades.value };
}
export function labClinicalEditProblem(next: LabClinicalSnapshot, previous: LabClinicalSnapshot): string | null {
  if (!next.doctorId && previous.doctorId !== null) return "لا يمكن إزالة الطبيب المحفوظ من الإرسالية.";
  if (next.workType !== previous.workType && !WORK_TYPES.filter(work => work !== "أخرى (مخصص)").includes(next.workType)) return "اختر نوع العمل المصحح من الخيارات المعيارية لضمان ظهوره في إرسالية المعمل.";
  const toothProblem = labToothInputProblem(next.toothNumbers, next.workType);
  if (toothProblem) return toothProblem;
  if (next.shade !== previous.shade && next.shade && !labShadeSelectionForCode(next.shade)) return "اختر اللون الجديد من دليل فيتا؛ الرمز السابق لا يُحوّل تلقائيًا.";
  const shade = parseLabShadeSpecification(next.shadeSpecification, Object.keys(parseLabTeeth(next.toothNumbers)).map(Number));
  return shade.ok ? null : shade.error;
}
export function sameLabClinicalSnapshot(a: LabClinicalSnapshot, b: LabClinicalSnapshot): boolean {
  return keys.every(key => JSON.stringify(a[key as keyof LabClinicalSnapshot]) === JSON.stringify(b[key as keyof LabClinicalSnapshot]));
}
