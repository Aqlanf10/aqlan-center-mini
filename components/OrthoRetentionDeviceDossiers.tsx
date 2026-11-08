import type { RetentionLedgerRead } from '@/lib/ortho-retention-client';
import { buildSavedRetentionDeviceDossiers } from '@/lib/ortho-retention-device-dossiers';
import { RetentionEventDetails, arches, states } from './OrthoRetentionEventDetails';

const ambiguity: Record<string, string> = {
  dependent_event_arch_mismatch: 'فك حدث مرتبط يختلف عن فك التسليم المصحح؛ لا يُعاد ربط الحدث تلقائياً.',
  delivery_date_unknown: 'تاريخ التسليم غير معلوم.',
  status_date_unknown: 'يوجد حدث حالة أو استبدال بلا تاريخ واقعة معلوم.',
  status_precedes_delivery: 'تاريخ حالة مسجلة يسبق تاريخ التسليم.',
  same_day_order_unknown: 'أحداث حالة في اليوم نفسه؛ ترتيب وقوعها غير معلوم.',
  status_after_replacement: 'توجد حالة مسجلة بتاريخ بعد الاستبدال.',
};
export function retentionDeviceAmbiguity(code: string) { return ambiguity[code] ?? 'سبب التباس غير معروف لهذه الواجهة؛ لا يُستنتج منه تسلسل استخدام.'; }
const relations = {delivery:'توثيق تسليم هذا الجهاز أو تصحيحه',device_reference:'حدث يشير صراحة إلى هذا الجهاز',replacement_out:'حدث استبدال يشير إلى هذا الجهاز بوصفه الجهاز السابق'};

/** One saved projection per read. Native details hold no clinical data or draft state. */
export default function OrthoRetentionDeviceDossiers({data}: {data: RetentionLedgerRead}) {
  const result = buildSavedRetentionDeviceDossiers(data);
  if (!result.ok) return <p role="alert">تعذر التحقق من تاريخ الأجهزة كاملاً؛ لا يمكن عرض ملفات الأجهزة.</p>;
  return <section aria-label="ملفات أجهزة التثبيت المحفوظة" className="min-w-0 space-y-3">
    <h5 className="font-bold">ملفات أجهزة التثبيت المحفوظة</h5>
    <p className="text-xs">رأس السجل #{result.headId ?? 'لا يوجد'} · النسخة {result.headVersion ?? 'لا توجد'}. تُرتب الأحداث حسب نسخة التوثيق، لا حسب ترتيب حدوثها سريرياً.</p>
    <p className="text-xs">الربط بمعرف الجهاز الصريح فقط. أحداث فك التقويم والنيات دون جهاز محدد تبقى في التاريخ الكامل ولا تُنسب لجهاز من الفك أو التاريخ أو النص. عدد النسخ غير المنسوبة لجهاز: {result.unassignedEntryIds.length}.</p>
    <p className="text-xs">التسليم لا يثبت الاستخدام أو الالتزام، والاستبدال لا ينقل نيات الجهاز السابق إلى البديل ولا يثبت تنفيذها. لا تُستنتج مدة استخدام أو اكتمال علاج.</p>
    {result.devices.length === 0 && <p>لا يوجد جهاز موثق التسليم في هذا السجل المحفوظ.</p>}
    {result.devices.map(dossier => {
      const device=dossier.device;
      return <details key={device.deviceId} className="min-w-0 rounded-lg border p-3">
        <summary className="min-h-11 cursor-pointer py-2 font-bold">ملف الجهاز #{device.deviceId} · الفك {arches[device.arch]} · {states[device.currentState]}</summary>
        <div className="space-y-3 text-sm">
          <p className="whitespace-pre-wrap break-words">{device.delivery.description}</p>
          <p>معرف الجهاز الأصلي #{device.deviceId} · نسخة التسليم الحالية #{device.deliveryRevisionId} · آخر حدث مرتبط #{device.lastEventId}</p>
          <p>مرجع الحالة الوثائقية: {device.stateEventId === null ? 'لا يوجد حدث حالة حاسم' : `الحدث #${device.stateEventId}`}.</p>
          <p>الجهاز السابق الذي استُبدل بهذا الجهاز: {dossier.previousDeviceId === null ? 'لا توجد علاقة استبدال مسجلة' : `#${dossier.previousDeviceId}`}.</p>
          <p>الجهاز البديل المسجل لهذا الجهاز: {dossier.nextDeviceId === null ? 'لا توجد علاقة استبدال مسجلة' : `#${dossier.nextDeviceId}`}.</p>
          {device.ambiguityReasons.length > 0 && <ul className="list-inside list-disc">{device.ambiguityReasons.map(reason=><li key={reason}>{retentionDeviceAmbiguity(reason)}</li>)}</ul>}
          {dossier.events.map(({revision,current,relation})=><article key={revision.id} className="min-w-0 space-y-2 border-t py-3">
            <h6 className="font-bold">الحدث #{revision.id} · نسخة التوثيق {revision.version}</h6>
            <p>{relations[relation]}</p>
            <p>{current ? 'نسخة لم يحل محلها تصحيح في هذه القراءة؛ ليست دليلاً على استمرار الحالة سريرياً.' : 'نسخة تاريخية حل محلها تصحيح؛ بقي أصلها محفوظاً.'}</p>
            <p>الفك كما سُجل لهذا الحدث: {arches[revision.content.arch]}</p>
            <p>وقت التسجيل: <bdi dir="ltr">{revision.createdAt}</bdi> · المسجل: {revision.createdBy}</p>
            <p className="whitespace-pre-wrap break-words">سبب التوثيق: {revision.reason}</p>
            {revision.content.supersedesEntryId !== null && <p>تصحيح الحدث #{revision.content.supersedesEntryId} · سبب تصحيح الفك: {revision.content.archCorrectionReason ?? 'لم يُسجل تغيير للفك'}</p>}
            <RetentionEventDetails event={revision.content.payload}/>
            {dossier.sourceMatches.filter(match=>match.entryId===revision.id).map(match=><p key={match.documentId}>مستند #{match.documentId}: {match.identityMatch === true ? 'هويته مطابقة للشاهد المحفوظ؛ ليست مصادقة سريرية على الحدث.' : match.identityMatch === false ? 'تغير مصدر المستند؛ لم تُستبدل الأدلة المحفوظة.' : 'لا يوجد شاهد هوية تاريخي مثبت.'}</p>)}
          </article>)}
        </div>
      </details>;
    })}
  </section>;
}
