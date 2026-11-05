"use client";
import { useEffect, useRef, useState } from 'react';
import { useSession } from './SessionProvider';
import type { RadiologyCenter } from '@/lib/radiology-centers';
import { RADIOLOGY_UUID, parseRadiologyRequest } from '@/lib/radiology-request';
type HistoryRow={id:string;doctorName:string;centerName:string;createdAtLabel:string};
type Pending={__expectedActor:string;__expectedUserId:number;commandKey:string;patientId:number;visitId:number|null;centerId:string;examination:string;region:string;notes:string};
export function RadiologyRequests(props:{patientId:number;visitId?:number}) {
 const session=useSession();
 return <RadiologyEntry key={JSON.stringify([props.patientId,props.visitId,session?.username,session?.role,session?.permissions])} expectedActor={session?.username??null} storageScope={JSON.stringify([session?.username,props.patientId,props.visitId??null])} {...props}/>;
}
/** Keep unrelated patient tabs inert: durable recovery storage is inspected only
 * after explicitly entering radiology. This keyed entry resets with patient/principal. */
function RadiologyEntry(props:{patientId:number;visitId?:number;storageScope:string;expectedActor:string|null}) {
 const [active,setActive]=useState(false);
 return active?<RadiologyPanel {...props}/>:<section className="my-4 rounded-xl border p-4" aria-label="طلبات الأشعة"><h2 className="font-bold">طلبات الأشعة</h2><p>افتح السجل لإصدار طلب أو مراجعة طلب سابق وطباعته.</p><button type="button" onClick={()=>setActive(true)} className="mt-3 rounded border p-3">فتح طلبات الأشعة</button></section>;
}
function RadiologyPanel({patientId,visitId,storageScope,expectedActor}:{patientId:number;visitId?:number;storageScope:string;expectedActor:string|null}) {
 const alive=useRef(true), latch=useRef(false), pending=useRef<Pending|null>(null);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[canIssue,setCanIssue]=useState(false);
 const [rows,setRows]=useState<HistoryRow[]>([]),[cursor,setCursor]=useState<string|null>(null),[centers,setCenters]=useState<RadiologyCenter[]>([]);
 const [opened,setOpened]=useState(false),[unknown,setUnknown]=useState(false),[saved,setSaved]=useState<string|null>(null),[frozen,setFrozen]=useState(false),[recoveryKey,setRecoveryKey]=useState<string|null>(null),[storageReady,setStorageReady]=useState(false);
 const storageKey=`radiology-request:v1:${storageScope}`;
 useEffect(()=>{try{const key=window.sessionStorage.getItem(storageKey);if(key!==null){if(!RADIOLOGY_UUID.test(key))throw new Error();setRecoveryKey(key);setUnknown(true);setFrozen(true);setOpened(true);setMessage('يوجد طلب سابق؛ تحقق من نتيجته قبل إصدار طلب آخر.');}setStorageReady(true);}catch{setMessage('تعذرت قراءة مفتاح الإصدار؛ الإصدار متوقف لحماية السجل.');}},[storageKey]);
 const [expectedUserId,setExpectedUserId]=useState<number|null>(null);
 const [centerId,setCenterId]=useState(''),[examination,setExamination]=useState(''),[region,setRegion]=useState(''),[notes,setNotes]=useState(''),[doctorName,setDoctorName]=useState('');
 useEffect(()=>{if(!unknown)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[unknown]);
 const query=()=>{const q=new URLSearchParams();if(visitId)q.set('visitId',String(visitId));return q;};
 const run=async(work:()=>Promise<void>)=>{if(latch.current)return;latch.current=true;setBusy(true);setMessage('');try{await work();}catch(e){if(alive.current)setMessage(e instanceof Error?e.message:'تعذرت العملية.');}finally{latch.current=false;if(alive.current)setBusy(false);}};
 const json=async(response:Response)=>{const body=await response.json();if(!response.ok){if([401,403,404].includes(response.status)&&alive.current){setRows([]);setCenters([]);setDoctorName('');setCanIssue(false);setSaved(null);}throw new Error(body.message||'تعذرت العملية.');}return body;};
 const load=(more=false)=>run(async()=>{const q=query();if(more&&cursor)q.set('before',cursor);const b=await json(await fetch(`/api/patients/${patientId}/radiology-requests?${q}`,{cache:'no-store'}));if(!alive.current)return;if(!Array.isArray(b.requests)||typeof b.canIssue!=='boolean'||!(b.nextCursor===null||RADIOLOGY_UUID.test(b.nextCursor)))throw new Error('استجابة غير صالحة.');setRows(old=>more?[...old,...b.requests]:b.requests);setCursor(b.nextCursor);setCanIssue(b.canIssue);});
 const open=()=>run(async()=>{const q=query();q.set('mode','options');const b=await json(await fetch(`/api/patients/${patientId}/radiology-requests?${q}`,{cache:'no-store'}));if(!alive.current)return;if(!Array.isArray(b.centers))throw new Error('قائمة المراكز غير صالحة.');if(!b.actor||b.actor.username!==expectedActor||!Number.isSafeInteger(b.actor.userId)||b.actor.userId<=0||b.actor.userId>2147483647)throw new Error('تغيّر حساب الطبيب؛ افتح الملف من جديد.');setExpectedUserId(b.actor.userId);setCenters(b.centers);setDoctorName(typeof b.doctor?.name==='string'?b.doctor.name:'');setOpened(true);});
 const issue=()=>run(async()=>{
  if(!expectedActor||!expectedUserId)throw new Error('تحقق من حساب الطبيب قبل إصدار الطلب.');
  if(!storageReady||recoveryKey)throw new Error('تحقق من الطلب السابق أولًا.');
  if(!pending.current){const candidate={commandKey:crypto.randomUUID(),patientId,visitId:visitId??null,centerId,examination,region,notes};parseRadiologyRequest(candidate);window.sessionStorage.setItem(storageKey,candidate.commandKey);if(window.sessionStorage.getItem(storageKey)!==candidate.commandKey)throw new Error('تعذر تثبيت مفتاح الطلب؛ لم يتم الإرسال.');pending.current={...candidate,__expectedActor:expectedActor,__expectedUserId:expectedUserId};setFrozen(true);}
  // Freeze both payload and key before sending; an ambiguous result never mints a second command.
  setUnknown(true);
  const body=await json(await fetch('/api/radiology-requests',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending.current)}));
  if(!alive.current)return;if(body.id!==pending.current.commandKey||!RADIOLOGY_UUID.test(body.id))throw new Error('نتيجة غير مؤكدة؛ تحقق من الطلب.');setSaved(body.id);setUnknown(false);setMessage(body.replayed?'الطلب محفوظ سابقًا؛ لم يصدر طلب جديد.':'حُفظ طلب الأشعة.');
 });
 const recover=()=>run(async()=>{const key=pending.current?.commandKey??recoveryKey;if(!key)return;const q=query();q.set('patientId',String(patientId));const b=await json(await fetch(`/api/radiology-requests/commands/${key}?${q}`,{cache:'no-store'}));if(!alive.current)return;if(b.state==='completed'&&b.id===key){setSaved(b.id);setUnknown(false);setMessage('تم العثور على الطلب المحفوظ.');}else{setMessage('النتيجة غير مؤكدة؛ احتفظ بهذه الشاشة وأعد التحقق أو أعد نفس الطلب.');}});
 return <section className="my-3 rounded-xl border bg-white p-4" dir="rtl" aria-label="طلبات الأشعة">
  <div className="flex flex-wrap items-center gap-3"><h3 className="font-bold">طلبات الأشعة</h3><button type="button" disabled={busy} onClick={()=>void load()} className="rounded-lg border p-3">عرض / تحديث السجل</button>{canIssue&&!opened&&<button type="button" disabled={busy} onClick={()=>void open()} className="rounded-lg border p-3">طلب أشعة جديد</button>}</div>
  {message&&<p role="status" className="my-3">{message}</p>}
  {opened&&<div className="my-4 grid gap-3">
   <p className="font-bold">الطبيب المُصدر: {doctorName||'يُتحقق من ارتباط الحساب قبل الإصدار'}</p>
   <p className="text-sm">يُحفظ الطلب نهائيًا باسم طبيب الحساب الحالي؛ راجع البيانات قبل الإصدار.</p>
   <label>مركز الأشعة<select value={centerId} disabled={busy||frozen} onChange={e=>setCenterId(e.target.value)} className="block w-full rounded border p-3"><option value="">اختر المركز</option>{centers.map(c=><option key={c.id} value={c.id}>{c.name} — {c.address}</option>)}</select></label>
   {!centers.length&&<p>لا توجد مراكز مفعّلة. تُضاف من الإعدادات المركزية ← مراكز الأشعة.</p>}
   <label>نوع الأشعة المطلوبة<input value={examination} maxLength={200} disabled={busy||frozen} onChange={e=>setExamination(e.target.value)} className="block w-full rounded border p-3"/></label>
   <label>المنطقة / الأسنان المطلوبة<input value={region} maxLength={200} disabled={busy||frozen} onChange={e=>setRegion(e.target.value)} className="block w-full rounded border p-3"/></label>
   <label>تعليمات للطبيب / مركز الأشعة<textarea value={notes} maxLength={2000} disabled={busy||frozen} onChange={e=>setNotes(e.target.value)} className="block w-full rounded border p-3"/></label>
   {!saved&&<div className="flex flex-wrap gap-3"><button disabled={busy||!storageReady||!expectedActor||!expectedUserId||Boolean(recoveryKey)||!canIssue||!centerId||!examination.trim()||!region.trim()} type="button" onClick={()=>void issue()} className="rounded-lg border p-3">{unknown?'إعادة نفس الطلب بأمان':'إصدار وحفظ الطلب'}</button>{unknown&&<button disabled={busy} type="button" onClick={()=>void recover()} className="rounded-lg border p-3">التحقق من نتيجة الإصدار</button>}</div>}
   {saved&&<button type="button" disabled={busy||!canIssue} onClick={()=>{try{window.sessionStorage.removeItem(storageKey);}catch{setMessage('تعذر إغلاق مرجع الطلب المحفوظ.');return;}setRecoveryKey(null);pending.current=null;setFrozen(false);setSaved(null);setOpened(false);setExamination('');setRegion('');setNotes('');setCenterId('');setExpectedUserId(null);void load();}} className="rounded border p-3">إغلاق الطلب المحفوظ وتحديث السجل</button>}
   {saved&&<a className="underline" target="_blank" rel="noopener noreferrer" href={`/print/radiology-request/${saved}?patientId=${patientId}`}>طباعة الطلب المحفوظ — ربع ورقة A6</a>}
   {unknown&&canIssue&&<button type="button" disabled={busy||!storageReady} className="rounded border p-3" onClick={()=>{if(!window.confirm('نتيجة الطلب السابق غير مؤكدة وقد يكون قد حُفظ. راجع سجل الأشعة أولًا. هل تقصد بدء طلب مستقل جديد رغم احتمال وجود الطلب السابق؟'))return;try{window.sessionStorage.removeItem(storageKey);}catch{setMessage('تعذر إزالة المرجع المحلي؛ لم يبدأ طلب جديد.');return;}pending.current=null;setRecoveryKey(null);setUnknown(false);setFrozen(false);setOpened(false);setExpectedUserId(null);setCenterId('');setExamination('');setRegion('');setNotes('');setMessage('أُغلق المرجع المحلي بقرارك. الطلب السابق إن حُفظ يبقى في السجل؛ لم يصدر طلب جديد تلقائيًا.');}}>بدء طلب مستقل بعد مراجعة السجل</button>}
  {unknown&&<p role="alert">لا تغلق الصفحة حتى تتأكد من النتيجة. لا يتم إنشاء مفتاح بديل تلقائيًا.</p>}
  </div>}
  <ul className="grid gap-2">{rows.map(row=><li key={row.id} className="flex flex-wrap gap-3 border-t py-3"><span>{row.createdAtLabel} — {row.doctorName} — {row.centerName}</span><a target="_blank" rel="noopener noreferrer" className="underline" href={`/print/radiology-request/${row.id}?patientId=${patientId}`}>طباعة A6</a></li>)}</ul>
  {cursor&&<button disabled={busy} type="button" onClick={()=>void load(true)} className="rounded border p-3">طلبات أقدم</button>}
 </section>;
}
