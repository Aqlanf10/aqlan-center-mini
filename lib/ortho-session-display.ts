import { PHASE_LABEL, nextAdjustmentDate } from './ortho';
import { auxiliariesText } from './ortho-auxiliaries';
export interface OrthoSessionDetail {
  id: number; doneOn: string; phase: string | null; note: string | null;
  visitId: number | null; visitSigned: boolean | null; nextWeeks: number; recordedBy: string;
  /** 0132; absent or null reads as not recorded, [] as an explicit "none". */
  auxiliaries?: readonly string[] | null; auxiliaryOther?: string | null;
}
export interface OrthoSessionField { label: string; value: string; ltr?: boolean }
/** An interval expectation from this entry, never evidence of a booking or attendance. */
export function sessionExpectedFollowup(doneOn: string, nextWeeks: number): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(doneOn) || !Number.isInteger(nextWeeks) || nextWeeks < 1 || nextWeeks > 52) return null;
  const date = new Date(`${doneOn}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== doneOn) return null;
  try { return nextAdjustmentDate(doneOn, nextWeeks); } catch { return null; }
}
export function sessionDetailFields(entry: OrthoSessionDetail): OrthoSessionField[] {
  const phase = entry.phase === null ? 'غير مسجلة' : Object.hasOwn(PHASE_LABEL, entry.phase) ? PHASE_LABEL[entry.phase as keyof typeof PHASE_LABEL] : entry.phase;
  const signature = entry.visitId === null ? 'لا توجد زيارة مرتبطة؛ حالة التوقيع غير معلومة'
    : entry.visitSigned === true ? 'الزيارة المرتبطة موقّعة وفق القراءة الحالية'
    : entry.visitSigned === false ? 'الزيارة المرتبطة غير موقّعة وفق القراءة الحالية' : 'حالة توقيع الزيارة المرتبطة غير معلومة';
  return [
    { label: 'معرف قيد الجلسة', value: String(entry.id), ltr: true },
    { label: 'تاريخ الجلسة المسجل', value: entry.doneOn, ltr: true },
    { label: 'المرحلة المسجلة لهذه الجلسة', value: phase },
    { label: 'الزيارة المرتبطة', value: entry.visitId === null ? 'غير مرتبطة بزيارة' : String(entry.visitId), ltr: entry.visitId !== null },
    { label: 'حالة توقيع الزيارة', value: signature },
    { label: 'مسجل الجلسة', value: entry.recordedBy || 'غير مسجل' },
    { label: 'ملاحظة الجلسة المسجلة', value: entry.note === null || entry.note === '' ? 'غير مسجلة' : entry.note },
    { label: 'الأجهزة المساعدة المسجلة', value: auxiliariesText(entry.auxiliaries, entry.auxiliaryOther) },
  ];
}
export const SESSION_FOLLOWUP_DISCLAIMER = 'تاريخ متوقع محسوب من فترة المتابعة المسجلة، وليس موعداً محجوزاً أو دليلاً على الحضور أو إتمام العلاج.';
