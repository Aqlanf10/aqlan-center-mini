import {notFound} from 'next/navigation';
import {requireSession} from '@/lib/session';
import {getSettingsSafe} from '@/lib/db';
import {routeId} from '@/lib/ortho-journey-route';
import {getOrthoSpaceLedger,getOrthoSpaceLedgerForPrint} from '@/lib/ortho-space-store';
import {verifySpaceRead} from '@/lib/ortho-space-client';
import {spacePrintReport} from '@/lib/ortho-space-print';
import {PrintHeader} from '@/components/PrintHeader';
import {OrthoStudyPrintButton} from '@/components/OrthoStudyPrintButton';
export const dynamic='force-dynamic';
const expired=(expiresAt:number)=>expiresAt<Date.now();
// Isolate technical/date tokens from surrounding RTL prose without modifying facts.
function FactLine({text}:{text:string}){
 const parts=text.split(/(\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?|(?:sha256:)?[a-f0-9]{64}|-?\d+(?:\.\d+)? mm)/g);
 return <>{parts.map((part,i)=>i%2?<bdi key={i} dir="ltr">{part}</bdi>:part)}</>;
}
export default async function SpacePrint({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}){
 const session=await requireSession(),q=await searchParams;
 const orthoCaseId=routeId((await params).id),patientId=routeId(q.patientId),clinicalCaseId=routeId(q.clinicalCaseId),headId=routeId(q.headId),headHash=q.headHash;
 if(!session||!orthoCaseId||!patientId||!clinicalCaseId||!headId||typeof headHash!=='string'||!/^[a-f0-9]{64}$/.test(headHash)||Object.keys(q).some(k=>!['patientId','clinicalCaseId','headId','headHash'].includes(k)))notFound();
 const scope={patientId,orthoCaseId,clinicalCaseId},binding={scope,actorId:session.userId};
 const initial=await getOrthoSpaceLedger({session,patientId,orthoCaseId});
 const verified=initial.ok?await verifySpaceRead(initial,patientId,orthoCaseId,binding):null;
 if(!verified||verified.headId!==headId||verified.history[0]?.contentHash!==headHash)notFound();
 const settings=await getSettingsSafe();
 // Header preparation cannot release data after permission/source/head changes.
 const fresh=await getOrthoSpaceLedgerForPrint({session,...scope,headId,headHash});
 const saved=fresh.ok?await verifySpaceRead(fresh,patientId,orthoCaseId,binding):null;
 if(!saved||saved.headId!==headId||saved.history[0]?.contentHash!==headHash||expired(session.expiresAt))notFound();
 const report=spacePrintReport(saved);
 return <main dir="rtl" className="sheet sheet-a4 space-y-5 break-words">
  <div className="print:hidden"><h1 className="text-xl font-bold">سجل المسافات وIPR المحفوظ</h1><p>نسخة داخل الملف، غير منزوعة الهوية. لا تشمل تعديلات المسودة. إذا تغير السجل فأعد فتح الطباعة من النسخة الحالية.</p><OrthoStudyPrintButton/></div>
  <PrintHeader settings={settings} title="سجل المسافات وIPR المحفوظ"/>
  <p>المريض #{patientId} · حالة التقويم #{orthoCaseId} · الحالة السريرية #{clinicalCaseId} · رأس السجل #{headId}</p>
  <p>المخطط تقدير يراجعه الطبيب، والمنفذ واقعة موثقة مستقلة لا تُضاف تلقائياً إلى المكاسب. المجهول ليس صفراً. المجموع لا يثبت عدم وجود IPR سابق ولا يحدد سعة آمنة متبقية أو توصية علاجية.</p>
  <section><h2 className="font-bold">مجموع الأحداث الحالية بعد التصحيحات</h2>{report.totals.length?report.totals.map((line,i)=><p key={i} dir="auto"><FactLine text={line}/></p>):<p>لا توجد أحداث IPR موثقة في هذا السجل؛ لا يعني ذلك عدم إجراء علاج سابق.</p>}</section>
  {report.entries.map(entry=><section key={entry.id} className="space-y-2 border-t pt-4"><h2 className="font-bold">{entry.title} #{entry.id}</h2>{entry.lines.map((line,i)=><p key={i} dir="auto" className="whitespace-pre-wrap"><FactLine text={line}/></p>)}<p dir="ltr" className="break-all text-xs">SHA256: {entry.hash}</p></section>)}
 </main>;
}
