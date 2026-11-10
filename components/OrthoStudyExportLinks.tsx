"use client";

import { useSession } from './SessionProvider';
import { canExportOrthoStudy } from '@/lib/ortho-study-export-access';

const control = 'min-h-11 min-w-11 rounded border px-3 py-2';

/** UI affordance only. Every output rechecks the current database grant. */
export function OrthoStudyExportLinks({ patientId, orthoCaseId, revisionId }: {
  patientId: number; orthoCaseId: number; revisionId: number;
}) {
  if (!canExportOrthoStudy(useSession())) return <p role="status">التصدير يحتاج صلاحية مستقلة؛ تبقى مراجعة الدراسة المحفوظة متاحة حسب صلاحيات المصادر.</p>;
  return <div className="flex flex-wrap gap-3 rounded-lg bg-slate-50 p-3 text-sm">
    <a className={control} target="_blank" rel="noopener noreferrer" href={`/print/ortho-study/${orthoCaseId}?patientId=${patientId}&revisionId=${revisionId}`}>طباعة النسخة المحفوظة / PDF نصي</a>
    <a className={control} href={`/api/ortho/${orthoCaseId}/case-study/text-pptx?patientId=${patientId}&revisionId=${revisionId}`}>PowerPoint نصي قابل للتحرير</a>
    <a className={control} href={`/api/ortho/${orthoCaseId}/case-study/illustrated-pptx?patientId=${patientId}&revisionId=${revisionId}`}>PowerPoint مصور قابل للتحرير</a>
    <a className={control} target="_blank" rel="noopener noreferrer" href={`/print/ortho-study/${orthoCaseId}?patientId=${patientId}&revisionId=${revisionId}&mode=illustrated`}>معاينة الدراسة المصورة / PDF</a>
    <p className="w-full">التصدير للنسخة المحفوظة المعروضة فقط؛ الصور وإخفاء الهوية للتعليم غير مشمولين في النسخة النصية.</p>
  </div>;
}
