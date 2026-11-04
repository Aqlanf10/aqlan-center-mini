"use client";
import { useEffect, useRef, useState } from "react";
import { LabDentalChart } from "./LabDentalChart";
import { LAB_IMPRESSION_LABEL, LAB_PRIORITY_LABEL, LAB_TOOTH_ROLE_META, STUMP_SHADES_ND, toLabDispatchExternal, type LabOrder } from "@/lib/lab";
import { LAB_PRESCRIPTION_SHADES, labPrescriptionVersion, validateLabPrescription } from "@/lib/lab-prescription-input";

export function LabPrescriptionEditor({order,onClose,onSaved}:{order:LabOrder;onClose:()=>void;onSaved:()=>void}) {
 const external=toLabDispatchExternal(order);
 // Unknown auto tooth roles stay unknown; selecting a chart tool is an explicit clinical action.
 const [teeth,setTeeth]=useState(external.teeth.filter(t=>t.role).map(t=>`${t.code}(${LAB_TOOTH_ROLE_META[t.role!].englishLabel})`).join(", "));
 const [partyId,setPartyId]=useState(order.partyId?.toString()??"");
 const [shade,setShade]=useState(order.shade??"");
 const [stumpShade,setStumpShade]=useState(order.stumpShade??"");
 const [dueDate,setDueDate]=useState(order.dueDate);
 const [impressionType,setImpressionType]=useState(order.impressionType);
 const [priority,setPriority]=useState(order.priority);
 const [labs,setLabs]=useState<{id:number;name:string}[]|null>(null);
 const [error,setError]=useState("");
 const [busy,setBusy]=useState(false);
 const pending=useRef(false), active=useRef(true);
 const dialog=useRef<HTMLDivElement>(null);
 const previousFocus=useRef<HTMLElement | null>(typeof document === "undefined" ? null : document.activeElement as HTMLElement);
 useEffect(()=>{
  const previous=previousFocus.current;
  return ()=>{if(previous?.isConnected)previous.focus();};
 },[]);
 useEffect(()=>{
  active.current=true;
  const controller=new AbortController();
  void fetch("/api/laboratories",{cache:"no-store",signal:controller.signal}).then(async r=>{
   if(!r.ok)throw new Error("تعذّر تحميل المختبرات.");
   const data=await r.json();
   if(!Array.isArray(data.laboratories))throw new Error("تعذّر تحميل المختبرات.");
   if(active.current && !controller.signal.aborted)setLabs(data.laboratories.filter((lab:{isActive:boolean})=>lab.isActive));
  }).catch(()=>{if(active.current && !controller.signal.aborted)setError("تعذّر تحميل المختبرات؛ أغلق النموذج وأعد فتحه للمحاولة.");});
  return ()=>{active.current=false;controller.abort();};
 },[]);
 async function save(dispatch:boolean){
  if(pending.current)return;
  setError("");
  let prescription;
  try{prescription=validateLabPrescription({partyId:partyId ? Number(partyId) : null,shade,stumpShade,toothNumbers:teeth,dueDate,impressionType,priority},dispatch);}
  catch(e){setError(e instanceof Error?e.message:"راجع البيانات.");return;}
  if(dispatch&&!window.confirm("هل أُرسلت هذه الإرسالية فعليًا إلى المختبر المحدد؟ سيُسجل الإرسال فقط، ولن تُرسل رسالة أو تُنشأ تكلفة."))return;
  pending.current=true;setBusy(true);
  try{
   const r=await fetch(`/api/lab/${order.id}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"complete_prescription",prescription,expected:labPrescriptionVersion(order),dispatch})});
   const data=await r.json();
   if(!r.ok)throw new Error(data.message??"تعذّر حفظ الإرسالية.");
   if(active.current)onSaved();
  }catch(e){if(active.current)setError(e instanceof Error?e.message:"تعذّر الحفظ؛ حدّث القائمة للتحقق قبل إعادة المحاولة.");}
  finally{pending.current=false;if(active.current)setBusy(false);}
 }
 const field="w-full rounded-lg border border-slate-300 bg-white p-2 text-sm";
 return <div ref={dialog} onKeyDown={event=>{
  if(event.key === "Escape" && !busy){event.preventDefault();onClose();}
  if(event.key === "Tab"){
   const targets=dialog.current?.querySelectorAll<HTMLElement>("button:not(:disabled),select:not(:disabled),input:not(:disabled),[tabindex=\"0\"]");
   if(!targets?.length)return;
   const first=targets[0],last=targets[targets.length-1];
   if(event.shiftKey && document.activeElement===first){event.preventDefault();last.focus();}
   else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first.focus();}
  }
 }} className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/60 p-3" role="dialog" aria-modal="true" aria-labelledby="lab-prescription-editor-title">
  <div className="mx-auto my-5 max-w-4xl rounded-2xl bg-white p-5" dir="rtl">
   <h2 id="lab-prescription-editor-title" className="text-lg font-bold">استكمال الإرسالية RX-{order.id}</h2>
   <p className="my-2 text-sm text-slate-600">تعديل نفس الطلب قبل الإرسال؛ لا تنشأ إرسالية أخرى ولا تكلفة. لا يتغير إجراء الزيارة الأصلي.</p>
   {order.source === "auto" && <p className="my-2 text-sm font-bold">نوع العمل الأصلي: {order.workType} — سن الإجراء: {order.toothCode ?? "غير محدد"}. يبقى المصدر الموقّع دون تغيير.</p>}
   {external.teeth.some(t=>!t.role)&&<p className="my-2 rounded-lg bg-amber-50 p-3 text-sm">أسنان الإجراء: {external.teeth.map(t=>t.code).join("، ")} — حدّد دور كل سن ونطاق الجسر صراحةً؛ لا نفترض أنه تاج أو دعامة.</p>}
   <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
    <label>المختبر المسجل<select autoFocus className={field} value={partyId} onChange={e=>setPartyId(e.target.value)}><option value="">{labs?"اختر المختبر":"جارٍ تحميل المختبرات…"}</option>{labs?.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
    <label>لون السن<select className={field} value={shade} onChange={e=>setShade(e.target.value)}><option value="">اختر اللون</option>{LAB_PRESCRIPTION_SHADES.map(s=><option key={s}>{s}</option>)}</select></label>
    <label>لون الجذع (اختياري)<select className={field} value={stumpShade} onChange={e=>setStumpShade(e.target.value)}><option value="">غير محدد</option>{[...LAB_PRESCRIPTION_SHADES,...STUMP_SHADES_ND].map(s=><option key={s}>{s}</option>)}</select></label>
    <label>تاريخ التسليم المطلوب<input type="date" dir="ltr" className={field} value={dueDate} onChange={e=>setDueDate(e.target.value)}/></label>
    <label>نوع الطبعة<select className={field} value={impressionType} onChange={e=>setImpressionType(e.target.value as typeof impressionType)}>{Object.entries(LAB_IMPRESSION_LABEL).map(([key,text])=><option key={key} value={key}>{text}</option>)}</select></label>
    <label>الأولوية<select className={field} value={priority} onChange={e=>setPriority(e.target.value as typeof priority)}>{Object.entries(LAB_PRIORITY_LABEL).map(([key,meta])=><option key={key} value={key}>{meta.label}</option>)}</select></label>
    <div className="sm:col-span-2"><LabDentalChart value={teeth} onChange={setTeeth}/></div>
   </fieldset>
   {error&&<p role="alert" className="my-3 rounded-lg bg-red-50 p-3 text-red-700">{error}</p>}
   <div className="mt-4 flex flex-wrap gap-2">
    <button type="button" disabled={busy||!labs} onClick={()=>void save(false)} className="min-h-11 rounded-lg bg-navy-900 px-4 text-white disabled:opacity-40">حفظ المسوّدة دون إرسال</button>
    <button type="button" disabled={busy||!labs} onClick={()=>void save(true)} className="min-h-11 rounded-lg bg-sky-700 px-4 text-white disabled:opacity-40">حفظ وتسجيل الإرسال الفعلي</button>
    <button type="button" disabled={busy} onClick={onClose} className="min-h-11 rounded-lg border px-4">إغلاق</button>
   </div>
  </div>
 </div>;
}
