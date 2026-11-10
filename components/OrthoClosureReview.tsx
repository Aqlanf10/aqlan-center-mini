'use client';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { RETAINER_LABEL, type RetainerType } from '@/lib/ortho';
import { clinicalContextHref } from '@/lib/patient-navigation';
import type { RetentionLedgerRead } from '@/lib/ortho-retention-client';
import { CLOSURE_PHOTO_LIMITS, createClosurePhotoReader, projectClosureReview, type ClosurePhotoState } from '@/lib/ortho-closure-review';

type Props = { patientId: number; orthoCaseId: number; ledger: RetentionLedgerRead | null; readUnavailable: boolean;
  legacyRetainer: RetainerType | null; legacyDate: string | null; authority: string; readVersion: number;
  ownerIdentity: object; active: () => boolean; photosVisible?: boolean };
const arch = { upper: 'الفك العلوي', lower: 'الفك السفلي', legacy_unknown: 'الفك غير معلوم' };
const deviceType = { fixed: 'ثابت', removable: 'متحرك', other: 'آخر' };
const deviceState = { in_use: 'الاستخدام مسجل', not_in_use: 'عدم الاستخدام مسجل', lost: 'الفقد مسجل', removed: 'الإزالة مسجلة', replaced: 'الاستبدال مسجل', unknown: 'الاستخدام غير معلوم', ambiguous: 'تحتاج الحالة إلى مراجعة التعارض' };
const date = (value: string | null) => value === null ? 'تاريخ الواقعة غير معلوم' : <bdi dir="ltr">{value}</bdi>;
export function OrthoClosureReview(props: Props) {
  if (!props.active()) return null;
  const review = props.readUnavailable ? null : projectClosureReview(props.ledger, props);
  return <details className="rounded-xl border border-slate-300 bg-white p-3" data-testid="ortho-closure-review">
    <summary className="min-h-11 cursor-pointer py-2 font-bold">مراجعة توثيق نهاية العلاج</summary>
    <div className="space-y-3 text-sm">
      <p>ملخص للسجلات المحفوظة، لا يثبت اكتمال العلاج أو السجلات النهائية ولا يغيّر شرط إغلاق الحالة.</p>
      <p>بيانات المثبّت القديمة: {props.legacyRetainer ? RETAINER_LABEL[props.legacyRetainer] : 'غير مسجلة'} · {date(props.legacyDate)}. لا تمثل هذه الخانة حدث تسليم جهاز.</p>
      {!review ? <p role="status">{props.readUnavailable || props.ledger ? 'تعذّر التحقق من سجل التثبيت؛ لا يُعد فارغاً.' : 'جارٍ التحقق من سجل التثبيت…'}</p> : <>
        <p>رأس سجل التثبيت: {review.headId ?? 'لا توجد أحداث محفوظة'}.</p>
        <h5 className="font-bold">أحداث فك الجهاز المسجلة</h5>
        {!review.debonds.length ? <p>لا يوجد حدث فك جهاز في السجل المقروء؛ لا يعني ذلك أن الفك لم يحدث.</p> : <ul className="space-y-2">{review.debonds.map(event => <li key={event.eventId}>حدث #{event.eventId} · {arch[event.arch]} · {date(event.occurrence.occurredOn)}<p className="break-words">النطاق المسجل: {event.extent}</p></li>)}</ul>}
        <h5 className="font-bold">أجهزة التثبيت المسجلة</h5>
        {!review.devices.length ? <p>لا توجد واقعة تسليم في السجل المقروء؛ لا يُستنتج عدم وجود مثبت.</p> : <ul className="space-y-2">{review.devices.map(device => <li key={device.deviceId}>
          جهاز #{device.deviceId} · {arch[device.arch]} · {deviceType[device.type]} · {date(device.occurrence.occurredOn)}
          <p>{deviceState[device.currentState]} · واقعة التسليم #{device.deliveryRevisionId}{device.replacedDeviceId !== null ? ` · يستبدل الجهاز #${device.replacedDeviceId}` : ''}</p>
          {!!device.ambiguityReasons.length && <p>توجد بيانات غير معلومة أو متعارضة؛ راجع سجل الجهاز.</p>}
        </li>)}</ul>}
        <p>{({ none: 'لا توجد مستندات مرتبطة بالأحداث في هذه القراءة.', matched: 'هويات مصادر الأحداث تطابق الشواهد المحفوظة؛ هذا ليس اعتماداً سريرياً.', mismatch: 'تغيرت هوية مصدر مرتبط بحدث؛ راجع المصدر قبل الاعتماد عليه.', unversioned: 'توجد مصادر تاريخية دون شاهد هوية محفوظ؛ لا تُعد متحققة.' })[review.sourceEvidence]}</p>
      </>}
      {review && <ClosurePhotos key={`${props.patientId}:${props.orthoCaseId}:${props.authority}`} {...props} />}
      <a className="inline-flex min-h-11 items-center underline" href={clinicalContextHref(props.patientId, { orthoCaseId: props.orthoCaseId, pillar: 'diagnostics' }, 'ortho')}>مراجعة السجلات والصور في هذه الحالة</a>
    </div>
  </details>;
}
function ClosurePhotos({ patientId, orthoCaseId, authority, readVersion, ownerIdentity, photosVisible, active }: Props) {
  const lease = useRef(active); useLayoutEffect(() => { lease.current = active; });
  const [state, setState] = useState<{ owner: object; value: ClosurePhotoState } | null>(null);
  const token = useMemo(() => ({ patientId, orthoCaseId, authority, readVersion, ownerIdentity, photosVisible }), [patientId, orthoCaseId, authority, readVersion, ownerIdentity, photosVisible]);
  const controls = useRef<{ token: object; reader: ReturnType<typeof createClosurePhotoReader> } | null>(null);
  useLayoutEffect(() => {
    const reader = createClosurePhotoReader({ patientId, orthoCaseId }, () => lease.current() && photosVisible !== false,
      value => setState({ owner: token, value }));
    controls.current = { token, reader };
    return () => { reader.retire(); if (controls.current?.token === token) controls.current = null; };
  }, [token, patientId, orthoCaseId, photosVisible]);
  const view: ClosurePhotoState = state?.owner === token ? state.value : { status: 'idle' };
  if (!active() || photosVisible === false) return <p>صور مرحلة فك الجهاز غير متاحة بالصلاحية الحالية؛ لا يمكن تحديد وجودها من هذا العرض.</p>;
  return <section aria-label="صور مسجّلة لمرحلة فك الجهاز" className="space-y-2 rounded-lg border p-3">
    <h5 className="font-bold">صور مسجّلة لمرحلة فك الجهاز</h5>
    <p className="text-xs">تصنيف توثيقي اختير عند التسجيل؛ لا يثبت اكتمال السجلات النهائية أو نتيجة العلاج. الصور غير المرتبطة بالحالة والمخفية والمؤرشفة خارج هذا الملخص.</p>
    <button type="button" className="min-h-11 rounded border px-3 disabled:opacity-50" disabled={view.status === 'loading'} onClick={() => { if (controls.current?.token === token) void controls.current.reader.read(); }}>قراءة صور مرحلة فك الجهاز</button>
    {view.status === 'idle' && <p>لم تُقرأ بيانات الصور في هذا الملخص بعد.</p>}
    {view.status === 'loading' && <p role="status">جارٍ التحقق من بيانات الصور…</p>}
    {view.status === 'denied' && <p role="alert">تعذرت إتاحة الصور بالصلاحية الحالية؛ لا يُستنتج عدم وجود صور.</p>}
    {view.status === 'unavailable' && <p role="alert">تعذرت قراءة بيانات الصور أو تجاوزت حدود القراءة؛ لم يُعتبر السجل فارغاً.</p>}
    {view.status === 'available' && <>
      <p>{view.photos.length ? `${view.photos.length} صورة ضمن القراءة الحالية لهذه الحالة والمرحلة.` : 'لا توجد صور لهذه المرحلة ضمن القراءة الحالية؛ لا يثبت ذلك غياب توثيق سابق.'}</p>
      {view.photos.length > CLOSURE_PHOTO_LIMITS.visibleRows && <p>تُعرض أول {CLOSURE_PHOTO_LIMITS.visibleRows} من {view.photos.length} صورة؛ راجع قسم السجلات لبقية الصور.</p>}
      <ul>{view.photos.slice(0, CLOSURE_PHOTO_LIMITS.visibleRows).map(photo => <li key={photo.id}>صورة #{photo.id} · {date(photo.takenOn)}</li>)}</ul>
    </>}
  </section>;
}
