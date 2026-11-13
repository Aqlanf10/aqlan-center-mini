"use client";
import { useEffect, useId, useRef, useState } from "react";
import { PHASE_LABEL, RETAINER_LABEL, CASE_STATUS_LABEL, type OrthoClinicalDetail, type OrthoPhase, type RetainerType } from "@/lib/ortho";
const button="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
const field="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2";
type Draft={version:string;kind:"phase"|"retainer"|"completed"|"discontinued";phase:OrthoPhase;retainer:RetainerType;date:string;note:string};
/** Native state only. Financial plan linking is deliberately absent. */
export function CanonicalOrthoLifecycleEditor({patientId,caseId,ownerKey,feed,refresh,onChanged}:{patientId:string;caseId:number;ownerKey:string;feed:OrthoClinicalDetail|null;refresh:()=>void;onChanged:()=>void}) {
 const storageKey=`aqlan.ortho-lifecycle.pending:${encodeURIComponent(ownerKey)}:${patientId}:${caseId}`,formId=useId();
 const [initial]=useState(()=>{try{return {pending:sessionStorage.getItem(storageKey)!==null,warning:false};}catch{return {pending:false,warning:true};}});
 const [pending,setPending]=useState(initial.pending),[warning,setWarning]=useState(initial.warning),[busy,setBusy]=useState(false),[draft,setDraft]=useState<Draft|null>(null),[message,setMessage]=useState<string|null>(null),[unverified,setUnverified]=useState<OrthoClinicalDetail|null>(null);
 const active=useRef(false),sending=useRef(false),pendingRef=useRef(initial.pending),controller=useRef<AbortController|null>(null);
 useEffect(()=>{active.current=true;return()=>{active.current=false;controller.current?.abort();};},[storageKey]);
 useEffect(()=>{const leave=(e:BeforeUnloadEvent)=>{if(sending.current||pendingRef.current){e.preventDefault();e.returnValue="";}};window.addEventListener("beforeunload",leave);return()=>window.removeEventListener("beforeunload",leave);},[]);
 const erase=()=>{try{sessionStorage.removeItem(storageKey);}catch{setWarning(true);}};
 const editable=feed&&["active","retention"].includes(feed.case.status)&&typeof feed.editVersion==="string"&&/^[a-f0-9]{64}$/.test(feed.editVersion);
 const current=editable&&draft&&draft.version===feed.editVersion;
 const begin=()=>{if(!editable||!feed||sending.current||pendingRef.current)return;setDraft({version:feed.editVersion!,kind:"phase",phase:feed.case.phase,retainer:feed.case.retainer??"none",date:"",note:""});setMessage(null);};
 async function save(){
  if(!active.current||sending.current||pendingRef.current||!current||!draft||!feed)return;
  const body=draft.kind==="phase"?{expectedVersion:draft.version,phase:draft.phase}:draft.kind==="retainer"?{expectedVersion:draft.version,retainer:draft.retainer,retainerOn:draft.date||null}:{expectedVersion:draft.version,status:draft.kind,note:draft.note.trim()||null};
  const request=new AbortController();controller.current=request;sending.current=true;setBusy(true);setMessage(null);setUnverified(feed);
  try{sessionStorage.setItem(storageKey,"pending");}catch{setWarning(true);}
  const timeout=setTimeout(()=>request.abort(),10000);
  const unknown=()=>{pendingRef.current=true;setPending(true);setDraft(null);setMessage("لم تتأكد نتيجة تحديث حالة التقويم. لن نعيد الطلب تلقائيًا.");refresh();};
  try{
   const response=await fetch(`/api/ortho/${caseId}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:request.signal});
   const result=await response.json().catch(()=>null);if(!active.current)return;
   if(!response.ok){if(response.status<500&&result&&(response.status===401||/^(STAFF_|ortho_lifecycle_|invalid_ortho_lifecycle$)/.test(String(result.code)))){erase();setDraft(null);setMessage(typeof result.message==="string"?result.message:"لم تتغيّر الحالة. راجع السجل.");refresh();}else unknown();return;}
   // Staging rule: retainer metadata never infers a lifecycle transition, so phase and retainer saves keep the status.
   const expectedStatus=draft.kind==="phase"||draft.kind==="retainer"?feed.case.status:draft.kind;
   if(!result||Object.keys(result).sort().join(",")!=="caseId,ok,status"||result.ok!==true||result.caseId!==caseId||result.status!==expectedStatus){unknown();return;}
   erase();setDraft(null);onChanged();
  }catch{if(active.current)unknown();}finally{clearTimeout(timeout);sending.current=false;if(active.current)setBusy(false);}
 }
 if(!editable&&!pending&&!draft&&!message&&!busy)return null;
 return <div data-testid="canonical-ortho-lifecycle" className="space-y-3 rounded-xl border border-slate-200 bg-white p-3 text-sm">
  {warning?<p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في التبويب؛ الاستعادة بعد إعادة التحميل غير مضمونة. تحقق قبل إغلاق الصفحة.</p>:null}
  {message?<p role="status">{message}</p>:null}
  {pending?<div className="space-y-2 rounded-lg bg-amber-50 p-3"><p>تحديث حالة سابق يحتاج مراجعة. لا إعادة تلقائية عند التحديث أو إعادة الاتصال.</p><button type="button" className={button} disabled={busy} onClick={()=>{setUnverified(feed);refresh();}}>التحقق من حالة التقويم الحالية</button>
   {feed&&feed!==unverified?<><p className="text-xs">الحالة الحالية: {CASE_STATUS_LABEL[feed.case.status]}؛ المرحلة: {PHASE_LABEL[feed.case.phase]}؛ المثبت: {feed.case.retainer ? RETAINER_LABEL[feed.case.retainer] : "غير مسجل"}. القراءة ليست إيصالًا لطلب بعينه.</p><button type="button" className={button} onClick={()=>{if(sending.current||!feed)return;erase();pendingRef.current=false;setPending(false);setDraft(null);setMessage(null);}}>راجعت الحالة، إنهاء المتابعة</button></>:null}</div>
   :!draft?editable?<button type="button" className={button} disabled={busy} onClick={begin}>تحديث مرحلة أو مثبت أو إقفال الحالة</button>:null
   :!feed?<p role="status">جارٍ التحقق من حالة التقويم…</p>:!current?<div><p>تغيّرت الحالة. راجع بياناتها قبل طلب جديد.</p><button type="button" className={button} onClick={()=>setDraft(null)}>إغلاق التعديل السابق</button></div>
   :<form className="space-y-3" onSubmit={e=>{e.preventDefault();void save();}}>
    <p className="text-xs text-slate-600">الحالة المنتهية لا تُعاد فتحها. إكمال العلاج يحتاج تسجيل قرار المثبّت، بما فيه اختيار «لم يُسلَّم بعد» صراحةً؛ التوقف عن العلاج مستقل عن الإكمال.</p>
    <label className="block text-xs font-bold" htmlFor={`${formId}-kind`}>الإجراء</label><select id={`${formId}-kind`} className={field} disabled={busy} value={draft.kind} onChange={e=>setDraft({...draft,kind:e.target.value as Draft["kind"]})}><option value="phase">تغيير المرحلة</option><option value="retainer">تسجيل المثبت</option><option value="completed">إكمال العلاج وإقفال الحالة</option><option value="discontinued">التوقف عن العلاج وإقفال الحالة</option></select>
    {draft.kind==="phase"?<><label className="block text-xs font-bold" htmlFor={`${formId}-phase`}>المرحلة الجديدة</label><select id={`${formId}-phase`} className={field} disabled={busy} value={draft.phase} onChange={e=>setDraft({...draft,phase:e.target.value as OrthoPhase})}>{Object.entries(PHASE_LABEL).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></>:draft.kind==="retainer"?<>
     <label className="block text-xs font-bold" htmlFor={`${formId}-retainer`}>نوع المثبت</label><select id={`${formId}-retainer`} className={field} disabled={busy} value={draft.retainer} onChange={e=>setDraft({...draft,retainer:e.target.value as RetainerType,date:""})}>{Object.entries(RETAINER_LABEL).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>
     {draft.retainer!=="none"?<><label className="block text-xs font-bold" htmlFor={`${formId}-date`}>تاريخ التسليم (اختياري)</label><input id={`${formId}-date`} type="date" className={field} disabled={busy} value={draft.date} onChange={e=>setDraft({...draft,date:e.target.value})}/><p className="text-xs">تركه فارغًا يحفظ التاريخ المعروف لنوع المثبت نفسه، وإلا يسجل يوم العيادة الحالي.</p></>:null}
    </>:<><label className="block text-xs font-bold" htmlFor={`${formId}-note`}>ملاحظة الإقفال (اختيارية)</label><textarea id={`${formId}-note`} className={field} disabled={busy} maxLength={300} value={draft.note} onChange={e=>setDraft({...draft,note:e.target.value})}/><p className="text-xs text-amber-800">التأكيد يقفل الحالة باسمك. راجع اختيار الإكمال أو التوقف قبل الحفظ.</p></>}
    <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy}>{busy?"جارٍ الحفظ…":"تأكيد تحديث حالة التقويم"}</button><button type="button" className={button} disabled={busy} onClick={()=>setDraft(null)}>إلغاء التعديل</button></div>
   </form>}
 </div>;
}
