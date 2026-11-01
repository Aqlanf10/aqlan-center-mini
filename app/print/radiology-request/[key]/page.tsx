import { notFound } from 'next/navigation';
import { readSessionPayload } from '@/lib/session';
import { readRadiologyRequest } from '@/lib/radiology-request-service';
import { RADIOLOGY_UUID } from '@/lib/radiology-request';
import { RadiologyPrintButton } from '@/components/RadiologyPrintButton';
import { Logo } from '@/components/Icon';
import './radiology.css';
export const dynamic='force-dynamic';
export default async function RadiologyPrint({params,searchParams}:{params:Promise<{key:string}>;searchParams:Promise<{patientId?:string}>}) {
 const session=await readSessionPayload(); if(!session?.credentialVersion)notFound();
 const {key}=await params,query=await searchParams,patientId=Number(query.patientId);
 if(!RADIOLOGY_UUID.test(key)||!Number.isSafeInteger(patientId)||patientId<=0||patientId>2147483647)notFound();
 const record=await readRadiologyRequest(session,key,patientId).catch(()=>null);if(!record)notFound();
 const s=record.snapshot;
 const date=new Intl.DateTimeFormat('ar-YE',{timeZone:s.timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(record.createdAt));
 // Table header repeats identity on continuations. Body cells may break naturally;
 // no fixed content height, overflow clipping or forced one-page shrinking.
 return <><RadiologyPrintButton requestId={record.id} patientId={patientId}/><article className="sheet radiology-a6" dir="rtl"><table className="radiology-document"><thead><tr><td>
  <div className="radiology-repeat-identity"><b>طلب أشعة — ملف {record.patientId}</b><p>المريض: {Array.from(s.patientName).slice(0,45).join('')}{Array.from(s.patientName).length>45?'…':''}</p><p>الطبيب: {Array.from(s.doctorName).slice(0,45).join('')}{Array.from(s.doctorName).length>45?'…':''} — #{s.doctorId}</p><p className="radiology-reference" dir="ltr">{record.id}</p></div>
 </td></tr></thead><tbody>
  <tr><td><header className="radiology-brand"><Logo className="radiology-logo"/><strong>{s.clinicName}</strong><span>{s.clinicAddress}</span><span dir="ltr">{s.clinicPhone}</span></header><h1>طلب أشعة</h1><p><b>المريض:</b> {s.patientName}</p><p><b>الطبيب:</b> {s.doctorName}</p><p><b>تاريخ الإصدار:</b> {date}</p></td></tr>
  <tr><td><h2>إلى مركز الأشعة</h2><p>{s.centerName}</p><p>{s.centerAddress}</p></td></tr>
  <tr><td><h2>الأشعة المطلوبة</h2><p>{s.examination}</p></td></tr>
  <tr><td><h2>المنطقة / الأسنان</h2><p>{s.region}</p></td></tr>
  {s.notes&&<tr><td><h2>تعليمات</h2><p>{s.notes}</p></td></tr>}
 </tbody></table></article></>;
}
