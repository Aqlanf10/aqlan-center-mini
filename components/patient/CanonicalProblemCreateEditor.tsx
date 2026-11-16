"use client";
import { useEffect, useId, useRef, useState } from "react";
import type { CanonicalPatientCases } from "@/lib/canonical-case-projection";
import { SPECIALTIES, SPECIALTY_LABEL, type ServiceSpecialty } from "@/lib/appointment-services";

type Draft = { label: string; site: string; specialty: ServiceSpecialty | ""; caseId: number | null };
const blank = (): Draft => ({ label: "", site: "", specialty: "", caseId: null });
const button = "min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800 disabled:opacity-50";
const field = "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white p-2";

/** No clinical text is persisted as pending intent; recovery never resends. */
export function CanonicalProblemCreateEditor({ patientId, ownerKey, feed, refresh }: {
  patientId: string; ownerKey: string; feed: CanonicalPatientCases | null; refresh: () => void;
}) {
  const storageKey = `aqlan.problem-create.pending:${encodeURIComponent(ownerKey)}:${patientId}`, formId = useId();
  const [initial] = useState(() => { try { return { uncertain: sessionStorage.getItem(storageKey) !== null, warning: false }; } catch { return { uncertain: false, warning: true }; } });
  const [uncertain,setUncertain] = useState(initial.uncertain), [storageWarning,setStorageWarning] = useState(initial.warning);
  const [open,setOpen] = useState(false), [draft,setDraft] = useState<Draft>(blank), [busy,setBusy] = useState(false), [message,setMessage] = useState<string|null>(null);
  const [unverifiedFeed,setUnverifiedFeed] = useState<CanonicalPatientCases|null>(null);
  const active = useRef(false), sending = useRef(false), uncertainRef = useRef(initial.uncertain), controller = useRef<AbortController|null>(null);
  useEffect(() => { active.current=true; return () => { active.current=false; controller.current?.abort(); }; },[storageKey]);
  useEffect(() => { const leave=(event:BeforeUnloadEvent)=>{ if(sending.current||uncertainRef.current){event.preventDefault();event.returnValue="";} };window.addEventListener("beforeunload",leave);return()=>window.removeEventListener("beforeunload",leave); },[]);
  const erase=()=>{try{sessionStorage.removeItem(storageKey);}catch{setStorageWarning(true);}};
  async function save() {
    if(!active.current||sending.current||uncertainRef.current||!feed)return;
    if(!draft.label.trim()||draft.label.length>200||draft.site.length>60){setMessage("اكتب المشكلة ضمن 200 حرف والموضع ضمن 60 حرفًا؛ لن نختصر النص.");return;}
    if(draft.caseId!==null&&!feed.cases.some(c=>c.kind==="specialty"&&c.id===draft.caseId)){setMessage("الحالة المختارة لم تعد متاحة. حدّث القائمة قبل الحفظ.");return;}
    const request=new AbortController();controller.current=request;sending.current=true;setBusy(true);setMessage(null);setUnverifiedFeed(feed);
    try{sessionStorage.setItem(storageKey,"pending");}catch{setStorageWarning(true);}
    const timeout=setTimeout(()=>request.abort(),10000);
    const unknown=()=>{uncertainRef.current=true;setUncertain(true);setDraft(blank());setOpen(false);setMessage("لم تتأكد نتيجة إنشاء المشكلة. لن نعيد الطلب تلقائيًا؛ راجع القائمة الحالية.");refresh();};
    try{
      const response=await fetch(`/api/patients/${patientId}/problems`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({label:draft.label.trim(),site:draft.site.trim()||null,specialty:draft.specialty||null,caseId:draft.caseId}),signal:request.signal});
      const result=await response.json().catch(()=>null);if(!active.current)return;
      if(!response.ok){
        if(response.status<500&&result&&(response.status===401||/^(STAFF_|problem_create_|invalid_problem_create$)/.test(String(result.code)))){erase();setOpen(false);setDraft(blank());setMessage(typeof result.message==="string"?result.message:"لم تُحفظ المشكلة. راجع القائمة الحالية.");refresh();}
        else unknown();return;
      }
      if(!result||Object.keys(result).sort().join(",")!=="ok,problemId"||result.ok!==true||!Number.isSafeInteger(result.problemId)||result.problemId<1||result.problemId>2147483647){unknown();return;}
      erase();setOpen(false);setDraft(blank());setMessage("حُفظت المشكلة السريرية وسُجّل الأثر.");refresh();
    }catch{if(active.current)unknown();}finally{clearTimeout(timeout);sending.current=false;if(active.current)setBusy(false);}
  }
  const cases=feed?.cases.filter(c=>c.kind==="specialty"&&c.id!==null)??[],verified=feed!==null&&feed!==unverifiedFeed;
  return <div data-testid="canonical-problem-create-editor" className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm">
    {storageWarning?<p role="status" className="text-xs text-amber-800">تعذّر حفظ متابعة الطلب في هذا التبويب. تجنب إغلاق الصفحة قبل التأكد؛ الاستعادة بعد إعادة التحميل غير مضمونة.</p>:null}
    {message?<p role="status">{message}</p>:null}
    {uncertain?<div className="space-y-2 rounded-lg bg-amber-50 p-3">
      <p>طلب إنشاء مشكلة سابق يحتاج مراجعة. لا يوجد إرسال تلقائي عند التحديث أو إعادة الاتصال.</p>
      <button type="button" className={button} disabled={busy} onClick={()=>{setUnverifiedFeed(feed);refresh();}}>التحقق من قائمة المشاكل الحالية</button>
      {verified?<><p className="text-xs">راجع قائمة المشاكل أدناه قبل طلب جديد. تشابه النص لا يثبت نتيجة طلب بعينه.</p><button type="button" className={button} onClick={()=>{if(!active.current||sending.current||!feed)return;erase();uncertainRef.current=false;setUncertain(false);setUnverifiedFeed(null);setDraft(blank());setOpen(true);setMessage(null);}}>راجعت القائمة، بدء طلب جديد</button></>:null}
    </div>:!open?<button type="button" className={button} disabled={busy||!feed} onClick={()=>{setOpen(true);setDraft(blank());setMessage(null);}}>تسجيل مشكلة سريرية</button>:feed?<form className="space-y-3" onSubmit={e=>{e.preventDefault();void save();}}>
      <p className="text-xs text-slate-600">توثيق مشكلة لا يغيّر الطبيب المسؤول أو حالة العلاج أو الحسابات.</p>
      <div><label htmlFor={`${formId}-label`} className="block text-xs font-bold">المشكلة السريرية</label><textarea id={`${formId}-label`} className={field} maxLength={200} disabled={busy} value={draft.label} onChange={e=>setDraft({...draft,label:e.target.value})}/></div>
      <div><label htmlFor={`${formId}-site`} className="block text-xs font-bold">موضع المشكلة</label><input id={`${formId}-site`} className={field} maxLength={60} disabled={busy} value={draft.site} onChange={e=>setDraft({...draft,site:e.target.value})}/></div>
      <div><label htmlFor={`${formId}-specialty`} className="block text-xs font-bold">تخصص المشكلة</label><select id={`${formId}-specialty`} className={field} disabled={busy} value={draft.specialty} onChange={e=>setDraft({...draft,specialty:e.target.value as Draft["specialty"]})}><option value="">غير محدد</option>{SPECIALTIES.map(key=><option key={key} value={key}>{SPECIALTY_LABEL[key]}</option>)}</select></div>
      <div><label htmlFor={`${formId}-case`} className="block text-xs font-bold">الحالة المرتبطة بالمشكلة</label><select id={`${formId}-case`} className={field} disabled={busy} value={draft.caseId??""} onChange={e=>setDraft({...draft,caseId:e.target.value?Number(e.target.value):null})}><option value="">بلا ربط بحالة</option>{cases.map(c=><option key={c.id} value={c.id!}>{c.title}</option>)}</select></div>
      <div className="flex flex-wrap gap-2"><button type="submit" className={button} disabled={busy}>{busy?"جارٍ الحفظ…":"حفظ المشكلة السريرية"}</button><button type="button" className={button} disabled={busy} onClick={()=>{setOpen(false);setDraft(blank());setMessage(null);}}>إلغاء تسجيل المشكلة</button></div>
    </form>:<p role="status">تحقق من القراءة الحالية قبل تسجيل المشكلة.</p>}
  </div>;
}
