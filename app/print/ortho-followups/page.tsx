import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/session';
import { getSettingsSafe } from '@/lib/db';
import { BUCKET_LABEL, BUCKET_ORDER, isRetentionFollowup, LEGACY_ADJUSTMENT_HISTORY_UNKNOWN, type FollowupBucket } from '@/lib/ortho-followup';
import { OrthoRetentionFollowupContext } from '@/components/OrthoRetentionFollowupContext';
import { PHASE_LABEL } from '@/lib/ortho';
import { prepareOrthoFollowupWorklist, OrthoFollowupWorklistError, type OrthoFollowupWorklist } from '@/lib/ortho-followup-worklist';
import { OrthoFollowupAuthorityError } from '@/lib/ortho-followup-authority';
import { PrintHeader } from '@/components/PrintHeader';
import { OrthoStudyPrintButton } from '@/components/OrthoStudyPrintButton';
export const dynamic = 'force-dynamic';
const expired = (expiresAt: number) => expiresAt < Date.now();
type Booking = OrthoFollowupWorklist['rows'][number]['nextAppointment'];
const statusLabels: Record<string,string> = { booked:'محجوز', arrived:'وصل وفق حالة الموعد', completed:'مكتمل وفق حالة الموعد', cancelled:'ملغى', no_show:'مسجل كغياب' };
function BookingLine({booking}:{booking:Booking}) {
  return booking ? <>موعد #{booking.id} · <bdi dir="ltr">{booking.date} {booking.time}</bdi> · {statusLabels[booking.status] ?? booking.status}</> : <>لا يوجد موعد محدد في هذه القراءة؛ راجع مؤشرات المواعيد الأخرى أدناه.</>;
}
export default async function OrthoFollowupWorklistPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const query = await searchParams;
  if (Object.keys(query).length !== 1 || typeof query.bucket !== 'string' || !BUCKET_ORDER.includes(query.bucket as FollowupBucket)) notFound();
  const bucket = query.bucket as FollowupBucket;
  const session = await requireSession();
  if (!session || !['admin','doctor','reception'].includes(session.role) || expired(session.expiresAt)) notFound();
  // Complete header IO first; the authorized helper owns the final account/ownership snapshot.
  const settings = await getSettingsSafe();
  let report: OrthoFollowupWorklist;
  try { report = await prepareOrthoFollowupWorklist(session,bucket); }
  catch (error) {
    if (error instanceof OrthoFollowupAuthorityError && [401,403].includes(error.status)) notFound();
    if (error instanceof OrthoFollowupWorklistError || error instanceof OrthoFollowupAuthorityError) return <main dir="rtl" className="sheet sheet-a4"><h1>تعذّر إعداد قائمة المتابعة</h1><p role="alert">تعذّر التحقق من القائمة كاملة أو تغيّرت الصلاحية. لم تُعرض قائمة فارغة أو مقتطعة؛ أعد فتحها بعد تحديث لوحة المتابعة.</p></main>;
    throw error;
  }
  if (report.actorId !== session.userId || report.bucket !== bucket || expired(session.expiresAt)) notFound();
  // No asynchronous IO after the final identity/session fence.
  return <main dir="rtl" className="sheet sheet-a4 min-w-0 space-y-4 break-words">
    <div className="print:hidden space-y-2"><h1 className="text-xl font-bold">قائمة متابعة التقويم · {BUCKET_LABEL[bucket]}</h1><OrthoStudyPrintButton /></div>
    <PrintHeader settings={settings} title={`قائمة متابعة التقويم · ${BUCKET_LABEL[bucket]}`} />
    <p>قراءة حالية جديدة قد تختلف عن الشاشة السابقة. إعداد هذه الصفحة لا يثبت طباعتها أو إرسالها أو التواصل مع المرضى.</p>
    <p>وقت الإعداد: <bdi dir="ltr">{report.asOf}</bdi> · يوم العيادة: <bdi dir="ltr">{report.today}</bdi> · المنطقة الزمنية: <bdi dir="ltr">{report.timeZone}</bdi></p>
    <p>عدد الحالات في القائمة المختارة: {report.rows.length}. قد تظهر الحالة في قوائم أخرى أيضاً؛ هذا ليس عدداً فريداً للمرضى عبر القوائم.</p>
    <p>التاريخ المتوقع أدناه تقدير مشتق من منطق اللوحة، وقد يعتمد للحالات غير المسجلة كحالات سابقة للنظام على تاريخ بدء الحالة أو فترة افتراضية قدرها أربعة أسابيع عند غياب جلسة مسجلة. ليس موعداً محجوزاً أو خطة استدعاء موثقة للتثبيت.</p>
    <p>مؤشر الموعد يصف الحالة الحالية لأحدث وقت موعد للمريض، وليس سجل حضور فعلياً أو إثبات إتمام علاج هذه الحالة. التوقيت المحلي المتكرر لا يميّز لحظتي الساعة عند تغيير التوقيت الصيفي.</p>
    {!report.rows.length ? <p role="status">لا توجد حالات مطابقة لهذه القائمة ضمن صلاحية القراءة الحالية. لا يعني ذلك خلو السجل من حالات أو مواعيد أخرى.</p> : report.rows.map(row => <section key={row.caseId} className="min-w-0 space-y-2 border-t pt-3 break-inside-avoid">
      <h2 className="font-bold whitespace-pre-wrap">{row.patientName} · المريض #{row.patientId} · حالة التقويم #{row.caseId}</h2>
      <p>حالة الملف الحالية: {row.status === 'retention' ? 'تثبيت' : 'علاج نشط'} · المرحلة الحالية: {Object.hasOwn(PHASE_LABEL,row.phase) ? PHASE_LABEL[row.phase as keyof typeof PHASE_LABEL] : row.phase}</p>
      <p>آخر جلسة مسجلة: {row.lastAdjustmentDate ? <bdi dir="ltr">{row.lastAdjustmentDate}</bdi> : 'غير مسجلة؛ لا يثبت ذلك عدم إجراء علاج سابق'}</p>
      {isRetentionFollowup(row)?<OrthoRetentionFollowupContext context={row.retentionContext} print/>:row.dueBasis==='legacy_adjustment_history_unknown'?<p>{LEGACY_ADJUSTMENT_HISTORY_UNKNOWN}</p>:<p>التاريخ المتوقع المشتق من اللوحة: {row.dueDate ? <bdi dir="ltr">{row.dueDate}</bdi> : 'غير متاح'}</p>}
      <p>الموعد القادم المحدد للمتابعة: <BookingLine booking={row.nextAppointment}/></p>
      <p>الموعد السابق غير المحسوم: {row.pastUnresolvedAppointment ? <BookingLine booking={row.pastUnresolvedAppointment}/> : 'لا يوجد موعد سابق غير محسوم في القراءة؛ ليس إثبات حضور'}</p>
      <p>مواعيد تحتاج مراجعة الربط: {row.reviewAppointmentCount} · مواعيد أخرى للمريض: {row.otherAppointmentCount}. لا يعني غياب موعد متابعة محدد غياب جميع المواعيد.</p>
      <p>مؤشر أحدث وقت موعد للمريض: {!row.attendance ? 'غير متاح؛ لا يُفترض حضور أو غياب' : row.attendance.outcome === 'conflict' ? 'حالات متعارضة في أحدث وقت موعد؛ يلزم مراجعتها، ولا يُستنتج حضور أو غياب محسوم' : row.attendance.outcome === 'no_show' ? 'مسجل كغياب وفق الحالة الحالية للموعد، وليس حكماً على علاج الحالة' : row.attendance.outcome === 'attendance' ? 'حالة موعد تشير للحضور؛ لا تثبت إتمام علاج الحالة' : 'لا توجد حالة موعد مؤهلة لهذا المؤشر؛ ليس إثبات حضور'}</p>
      {row.attendance && <p>أحدث وقت موعد محلي: <bdi dir="ltr">{row.attendance.latestScheduledLocal ?? 'غير متاح'}</bdi> · حد قراءة الحالات: <bdi dir="ltr">{row.attendance.cutoffLocalDateTime}</bdi></p>}
    </section>)}
  </main>;
}
