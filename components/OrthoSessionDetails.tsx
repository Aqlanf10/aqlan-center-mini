import { sessionDetailFields, type OrthoSessionDetail } from '@/lib/ortho-session-display';
/** Read-only provenance; no historical signing, edits, financial or photo actions. */
export default function OrthoSessionDetails({ entry }: { entry: OrthoSessionDetail }) {
  return <details className="mt-2 min-w-0 rounded border border-slate-200 p-2 text-xs">
    <summary className="min-h-11 cursor-pointer font-bold">تفاصيل الجلسة المسجلة #{entry.id}</summary>
    <dl className="space-y-2">{sessionDetailFields(entry).map(field => <div key={field.label}>
      <dt className="font-bold text-slate-600">{field.label}</dt>
      <dd dir={field.ltr ? 'ltr' : 'auto'} className="whitespace-pre-wrap break-words">{field.value}</dd>
    </div>)}</dl>
    <p className="mt-2 text-slate-500">التوقيع يخص الزيارة المرتبطة وفق القراءة الحالية؛ لا يثبت حضوراً أو موافقة سريرية جديدة، ولا يمثل حالة التوقيع وقت الجلسة.</p>
  </details>;
}
