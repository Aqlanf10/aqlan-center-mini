import type { RetentionLedgerRead } from '@/lib/ortho-retention-client';
import { projectSavedRetentionInstructions } from '@/lib/ortho-retention-instructions';

const reasons: Record<string, string> = {
  interval_anchor_unknown: 'تاريخ بداية الفترة غير معلوم.',
  interval_date_out_of_range: 'التاريخ الناتج عن الفترة خارج النطاق المدعوم.',
  conflicting_timing: 'التاريخ المحدد يختلف عن التاريخ الناتج عن الفترة المسجلة.',
  due_precedes_instruction: 'التاريخ المقصود يسبق تاريخ الواقعة المسجل.',
  arch_unknown: 'الفك غير معلوم في السجل.',
  overlapping_instructions: 'توجد تعليمات متداخلة؛ لا يثبت النص أنها مواعيد مستقلة.',
  device_state_requires_reconciliation: 'حالة الجهاز الموثقة تحتاج مراجعة مع هذه النية.',
  device_arch_changed: 'الفك الحالي الموثق للجهاز يختلف عن فك هذه النية.',
  device_replaced_requires_reconciliation: 'سُجل استبدال الجهاز؛ تبقى نية المتابعة بحاجة إلى مراجعة.',
};
export function retentionInstructionReason(code: string): string {
  return reasons[code] ?? 'سبب التباس غير معروف لهذه الواجهة؛ لا يمكن اعتباره محلولاً.';
}
const arches = { upper: 'العلوي', lower: 'السفلي', legacy_unknown: 'غير معلوم' };
const provenance = { unknown: 'تاريخ غير معلوم', contemporaneous_record: 'سجل معاصر للحدث', retrospective_record: 'توثيق بأثر رجعي', historical_source: 'مصدر تاريخي' };
function DateValue({value}: {value: string | null}) { return value === null ? <>غير محدد</> : <bdi dir="ltr">{value}</bdi>; }

/** No local state, clock, draft or request: lifetime is the verified parent read. */
export default function OrthoRetentionInstructions({data}: {data: RetentionLedgerRead}) {
  const result = projectSavedRetentionInstructions(data);
  if (!result.ok || result.projection.state === 'invalid') return <section aria-label="مراجعة نيات المتابعة المحفوظة" className="rounded-lg border p-3"><p role="alert">تعذر قراءة تاريخ تعليمات التثبيت كاملاً؛ لا يمكن عرض خلاصة موثوقة.</p></section>;
  const {projection} = result;
  return <section aria-label="مراجعة نيات المتابعة المحفوظة" className="min-w-0 space-y-3 rounded-lg border p-3">
    <h5 className="font-bold">مراجعة نيات المتابعة المحفوظة</h5>
    <p className="text-xs">رأس السجل #{result.headId ?? 'لا يوجد'} · النسخة {result.headVersion ?? 'لا توجد'}. قراءة للبيانات المحفوظة فقط؛ المسودة لا تدخل في هذه الخلاصة.</p>
    <p className="text-sm">هذه مراجعة لاتساق التوقيت المسجل، وليست اعتماداً سريرياً للتعليمات أو حجزاً أو إثبات حضور أو إنجاز. المراجعة والاستبدال لا يلغيان نية سابقة ولا يثبتان تنفيذها تلقائياً؛ التصحيح الصريح وحده يحل محل نسخته الأصلية.</p>
    {projection.state === 'not_recorded' && <p>لم تُسجل نية متابعة في هذا التاريخ المحفوظ. لا يعني ذلك عدم الحاجة إلى متابعة.</p>}
    {projection.state === 'ambiguous' && <p role="status">لا يمكن تحديد تاريخ إجمالي: توجد نية بلا توقيت قابل للحسم أو أدلة تحتاج مراجعة. تبقى تفاصيل كل نية أدناه مستقلة.</p>}
    {projection.state === 'recorded' && <p>أبكر تاريخ مقصود بحسب التعليمات المحفوظة القابلة للحسم وثائقياً: <DateValue value={projection.dueDate}/>. ليس موعداً محجوزاً أو توصية جديدة.</p>}
    {projection.intents.map(intent => {
      const revision = data.history.find(row => row.id === intent.eventId)!;
      const matches = result.sourceMatches.filter(row => row.entryId === intent.eventId);
      return <article key={intent.eventId} className="min-w-0 space-y-2 border-t pt-3 text-sm">
        <h6 className="font-bold">نية الحدث #{intent.eventId} · الفك {arches[intent.arch]} · {intent.deviceId === null ? 'دون جهاز محدد' : `الجهاز #${intent.deviceId}`}</h6>
        <p className="whitespace-pre-wrap break-words">النطاق المسجل: {intent.scope || 'غير محدد'}</p>
        <p>تاريخ الواقعة / بداية الفترة: <DateValue value={intent.occurrence.occurredOn}/> · {provenance[intent.occurrence.dateProvenance]}</p>
        <p className="whitespace-pre-wrap break-words">مصدر التاريخ: {intent.occurrence.sourceNote || 'لا نص مسجل'}</p>
        <p>التاريخ المقصود المسجل صراحة: <DateValue value={intent.dueOn}/></p>
        <p>الفترة المسجلة: {intent.intervalDays === null ? 'غير محددة' : <><bdi dir="ltr">{intent.intervalDays}</bdi> يوم</>}</p>
        <p>تاريخ مشتق من الفترة وبدايتها المسجلتين: <DateValue value={intent.intervalDueDate}/></p>
        <p>التوقيت القابل للحسم لهذه النية وحدها: <DateValue value={intent.dueDate}/></p>
        {intent.ambiguityReasons.length > 0 && <ul className="list-inside list-disc">{intent.ambiguityReasons.map(code => <li key={code}>{retentionInstructionReason(code)}</li>)}</ul>}
        <p>نسخة التوثيق {revision.version} · المسجل: {revision.createdBy} · <bdi dir="ltr">{revision.createdAt}</bdi></p>
        {revision.content.supersedesEntryId !== null && <p>تصحيح الحدث #{revision.content.supersedesEntryId}؛ الأصل محفوظ في التاريخ الكامل أدناه.</p>}
        <p className="whitespace-pre-wrap break-words">ملاحظة محفوظة: {revision.content.payload.note || 'لا نص مسجل'}</p>
        {matches.map(match => <p key={match.documentId}>دليل المستند #{match.documentId}: {match.identityMatch === true ? 'هويته مطابقة للشاهد المحفوظ في هذه القراءة؛ لا يثبت ذلك صحة التعليمات سريرياً.' : match.identityMatch === false ? 'تغير مصدر المستند؛ لا تُستبدل الأدلة التاريخية ولا يُعد توقيت النية تحققاً من المصدر.' : 'لا يوجد شاهد هوية تاريخي مثبت؛ لا يُعد توقيت النية تحققاً من المصدر.'}</p>)}
      </article>;
    })}
    <p className="text-xs">راجع معرفات الأحداث وأصول التصحيحات في «التاريخ الكامل والتصحيحات» أدناه. مطابقة المستندات مستقلة عن حساب التوقيت.</p>
  </section>;
}
