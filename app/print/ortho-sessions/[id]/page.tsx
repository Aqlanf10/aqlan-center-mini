import {notFound} from 'next/navigation';
import {requireSession} from '@/lib/session';
import {getSettingsSafe} from '@/lib/db';
import {routeId} from '@/lib/ortho-journey-route';
import {prepareOrthoSessionReport,OrthoSessionReportError} from '@/lib/ortho-session-report';
import {sessionDetailFields,sessionExpectedFollowup,SESSION_FOLLOWUP_DISCLAIMER} from '@/lib/ortho-session-display';
import {ELASTIC_LABEL} from '@/lib/ortho';
import {PrintHeader} from '@/components/PrintHeader';
import {OrthoStudyPrintButton} from '@/components/OrthoStudyPrintButton';
export const dynamic='force-dynamic';
const expired=(expiresAt:number)=>expiresAt<Date.now();
export default async function SessionReportPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireSession(),q=await searchParams,orthoCaseId=routeId((await params).id),patientId=routeId(q.patientId);
 if(!session||!['admin','doctor','reception'].includes(session.role)||!patientId||!orthoCaseId||Object.keys(q).some(k=>k!=='patientId'))notFound();
 const settings=await getSettingsSafe();
 let report;
 try{report=await prepareOrthoSessionReport({session,patientId,orthoCaseId});}catch(error){
  if(error instanceof OrthoSessionReportError){if(error.code==='session_report_bridge_unavailable')return <main dir="rtl" className="sheet sheet-a4"><p role="alert">يتطلب هذا التقرير رابطاً سريرياً واحداً متحققاً لحالة التقويم. الرابط غير متاح أو غير متطابق؛ لم تُنشأ روابط ولم يتغير سجل الجلسات الحالي.</p></main>;notFound();}throw error;
 }
 if(report.patientId!==patientId||report.orthoCaseId!==orthoCaseId||report.actorId!==session.userId||expired(session.expiresAt))notFound();
 return <main dir="rtl" className="sheet sheet-a4 space-y-4 break-words">
  <div className="print:hidden"><OrthoStudyPrintButton/><p>قراءة جديدة عند إعداد التقرير، وقد تختلف عن الشاشة المفتوحة. ليست نسخة تاريخية ثابتة.</p></div>
  <PrintHeader settings={settings} title="تسلسل جلسات التقويم"/>
  <p>{report.patientName} · المريض <bdi>{patientId}</bdi> · حالة التقويم <bdi>{orthoCaseId}</bdi> · الرابط السريري المتحقق <bdi>{report.clinicalCaseId}</bdi></p>
  <p>بداية إعداد القراءة: <bdi dir="ltr">{report.generatedAt}</bdi> · عدد القيود: <bdi>{report.entries.length}</bdi></p>
  <p>الترتيب حسب تاريخ الجلسة المسجل ثم معرف القيد. تاريخ الجلسة ليس بالضرورة تاريخ الزيارة أو وقت التوقيع. حالة التوقيع وفق القراءة الحالية ولا تثبت وحدها إتمام العلاج.</p>
  <p>{SESSION_FOLLOWUP_DISCLAIMER}</p>
  {!report.entries.length?<p>لا توجد قيود جلسات في هذه القراءة؛ لا يثبت ذلك عدم وجود علاج سابق.</p>:report.entries.map(entry=><section key={entry.id} className="border-t pt-3 space-y-2">
   <h2 className="font-bold">قيد الجلسة <bdi>{entry.id}</bdi></h2>
   <dl>{sessionDetailFields(entry).map(field=><div key={field.label}><dt className="font-semibold">{field.label}</dt><dd className="whitespace-pre-wrap" dir={field.ltr?'ltr':'auto'}>{field.value}</dd></div>)}</dl>
   <p>السلك العلوي: <bdi>{entry.upperWire??'غير مسجل'}</bdi> · السلك السفلي: <bdi>{entry.lowerWire??'غير مسجل'}</bdi></p>
   <p>المطاط المسجل: {ELASTIC_LABEL[entry.elastics]} · {entry.elasticNote??'دون ملاحظة مسجلة'}</p>
   <p className="whitespace-pre-wrap" dir="auto">الإجراء المسجل: {entry.done??'غير مسجل'}</p>
   <p>فترة المتابعة المسجلة: <bdi>{entry.nextWeeks}</bdi> أسبوع · التاريخ المتوقع المحسوب: <bdi dir="ltr">{sessionExpectedFollowup(entry.doneOn,entry.nextWeeks)??'غير متاح'}</bdi></p>
  </section>)}
 </main>;
}
