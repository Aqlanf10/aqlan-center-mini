"use client";
import { useEffect, useState } from "react";
import { LAB_IMPRESSION_LABEL, LAB_PRIORITY_LABEL, STUMP_SHADES_ND } from "@/lib/lab";
import { LAB_PRESCRIPTION_SHADES } from "@/lib/lab-prescription-input";
import type { LabWorkDraft, LabWorkRetirement } from "@/lib/lab-work-intent-contract";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { LabPrescriptionEditor } from "./LabPrescriptionEditor";
import { LabPrescriptionModal } from "./LabPrescriptionModal";
import { LabDentalChart } from "./LabDentalChart";

/** Missing migration, permission or network evidence never enables new writes. */
export function useLabWorkCapability(principal: string, eligible: boolean): boolean {
 const [owner,setOwner]=useState({principal,eligible});
 if(owner.principal!==principal||owner.eligible!==eligible)setOwner({principal,eligible});
 const [result,setResult]=useState<{owner:object;supported:boolean}|null>(null);
 useEffect(()=>{
  if(!eligible)return;
  const controller=new AbortController();
  void fetch("/api/lab/work-intents/capability",{cache:"no-store",signal:controller.signal})
   .then(async response=>{const body:unknown=await response.json();if(!controller.signal.aborted)setResult({owner,supported:response.ok&&!!body&&typeof body==="object"&&(body as {supported?:unknown}).supported===true});})
   .catch(()=>{if(!controller.signal.aborted)setResult({owner,supported:false});});
  return ()=>controller.abort();
 },[owner,eligible]);
 return eligible&&result?.owner===owner&&result.supported;
}

export function appendLabRetirement(current: LabWorkRetirement[], work: LabWorkDraft): LabWorkRetirement[] {
 if(work.expectedRevision===0)return current;
 const existing=current.find(item=>item.intentId===work.intentId);
 if(existing && existing.expectedRevision!==work.expectedRevision)throw new Error("تغيّر إصدار مجموعة المختبر؛ حدّث بياناتها قبل الإلغاء.");
 if(existing)return current.map(item=>item!==existing?item:{...item,memberIds:Array.from(new Set([...item.memberIds,work.memberId]))});
 return [...current,{intentId:work.intentId,expectedRevision:work.expectedRevision,memberIds:[work.memberId]}];
}

/** Called only by an explicit clinician action, never while loading or replaying old commands. */
export function newLabWorkDraft(groupKind: "single"|"bridge"): LabWorkDraft {
 return {intentId:crypto.randomUUID(),memberId:crypto.randomUUID(),expectedRevision:0,groupKind,prescription:{
  partyId:null,shade:"",stumpShade:"",toothNumbers:"",dueDate:clinicDateString(new Date(),CLINIC_ZONE_FALLBACK),impressionType:"physical",priority:"normal",
 }};
}

export function LabWorkDraftFields({value,workLabel,sourceTooth,disabled,onChange,onRetire,bridgeChoices=[]}:{
 value:LabWorkDraft;workLabel:string;sourceTooth:number|null;disabled:boolean;
 onChange:(next:LabWorkDraft)=>void;onRetire?:()=>void;
 bridgeChoices?:Array<{label:string;value:LabWorkDraft}>;
}){
 const [labs,setLabs]=useState<Array<{id:number;name:string}>|null>(null);
 const [error,setError]=useState("");
 useEffect(()=>{const controller=new AbortController();
  void fetch("/api/laboratories",{cache:"no-store",signal:controller.signal}).then(async response=>{
   const body=await response.json();if(!response.ok||!Array.isArray(body.laboratories))throw Error();
   if(!controller.signal.aborted)setLabs(body.laboratories.filter((lab:{isActive?:boolean})=>lab.isActive===true));
  }).catch(()=>{if(!controller.signal.aborted)setError("تعذّر تحميل المختبرات؛ يمكن حفظ مسوّدة ناقصة دون إرسال.");});
  return()=>controller.abort();
 },[]);
 const patch=(next:Partial<LabWorkDraft["prescription"]>)=>onChange({...value,prescription:{...value.prescription,...next}});
 const field="min-h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 py-2 text-xs";
 return <fieldset disabled={disabled} className="mt-3 min-w-0 rounded-xl border border-sky-200 bg-sky-50/40 p-3" data-lab-intent={value.intentId} data-lab-member={value.memberId}>
  <legend className="px-2 text-xs font-bold">مواصفات المختبر — {workLabel}</legend>
  <p className="mb-3 text-xs text-slate-600">سن المصدر: {sourceTooth??"غير محدد"}. تُحفظ المواصفات مع العمل نفسه؛ الناقص يبقى مسوّدة ولا يُسجّل إرسالًا. عند حفظ الفاتورة أو توقيع الزيارة يُنشأ الطلب المرتبط بحالة «لم يُرسل بعد» حتى مع اكتمال المواصفات. تسجيل الإرسال خطوة مستقلة؛ لا تُرسل رسالة للمختبر تلقائيًا.</p>
  {value.groupKind==="bridge"&&bridgeChoices.length>0&&value.expectedRevision===0&&<label className="mb-3 block text-xs">ضم هذا العضو إلى جسر محدد صراحةً
   <select className={field} value="" onChange={event=>{const target=bridgeChoices.find(choice=>choice.value.intentId===event.target.value);if(target)onChange({...target.value,memberId:value.memberId});}}>
    <option value="">يبقى طلبًا مستقلًا ما لم تختَر جسرًا</option>{bridgeChoices.map(choice=><option key={choice.value.intentId} value={choice.value.intentId}>{choice.label}</option>)}
   </select>
  </label>}
  <div className="grid min-w-0 gap-3 sm:grid-cols-2">
   <label className="min-w-0 text-xs">المختبر<select className={field} value={value.prescription.partyId??""} onChange={event=>patch({partyId:event.target.value?Number(event.target.value):null})}><option value="">{labs?"لم يُحدد بعد":"جارٍ تحميل المختبرات…"}</option>{labs?.map(lab=><option key={lab.id} value={lab.id}>{lab.name}</option>)}</select></label>
   <label className="text-xs">لون السن<select className={field} value={value.prescription.shade} onChange={event=>patch({shade:event.target.value})}><option value="">لم يُحدد بعد</option>{LAB_PRESCRIPTION_SHADES.map(shade=><option key={shade}>{shade}</option>)}</select></label>
   <label className="text-xs">لون الجذع (اختياري)<select className={field} value={value.prescription.stumpShade} onChange={event=>patch({stumpShade:event.target.value})}><option value="">غير محدد</option>{[...LAB_PRESCRIPTION_SHADES,...STUMP_SHADES_ND].map(shade=><option key={shade}>{shade}</option>)}</select></label>
   <label className="text-xs">التسليم المطلوب<input className={field} type="date" dir="ltr" value={value.prescription.dueDate} onChange={event=>patch({dueDate:event.target.value})}/></label>
   <label className="text-xs">نوع الطبعة<select className={field} value={value.prescription.impressionType} onChange={event=>patch({impressionType:event.target.value as typeof value.prescription.impressionType})}>{Object.entries(LAB_IMPRESSION_LABEL).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
   <label className="text-xs">الأولوية<select className={field} value={value.prescription.priority} onChange={event=>patch({priority:event.target.value as typeof value.prescription.priority})}>{Object.entries(LAB_PRIORITY_LABEL).map(([key,meta])=><option key={key} value={key}>{meta.label}</option>)}</select></label>
  </div>
  <p className="my-2 text-xs text-amber-800">حدّد أدوار الأسنان صراحةً؛ لا نختار تاجًا أو دعامة أو لونًا تلقائيًا.</p>
  <LabDentalChart value={value.prescription.toothNumbers} onChange={toothNumbers=>patch({toothNumbers})}/>
  {error&&<p role="status" className="my-2 text-xs text-amber-800">{error}</p>}
  {onRetire&&<button type="button" className="mt-2 min-h-11 rounded-lg border border-red-200 px-3 text-xs text-red-700" onClick={onRetire}>إلغاء عضوية هذا العمل في مسوّدة المختبر</button>}
 </fieldset>;
}

/** An exact source alias is required. Never search by matching service/amount/tooth. */
export function LabWorkOrderLink({orderId,patientId,disabled,onChanged}:{orderId:number;patientId:number;disabled:boolean;onChanged:()=>void}) {
 const [order,setOrder]=useState<import("@/lib/lab").LabOrder|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");
 const [lifetime]=useState(()=>({active:true}));
 useEffect(()=>{lifetime.active=true;return()=>{lifetime.active=false;};},[lifetime]);
 async function open(){
  if(busy||disabled)return;setBusy(true);setError("");
  try{const response=await fetch(`/api/lab?patientId=${patientId}`,{cache:"no-store"});const body=await response.json();
   if(!response.ok||!Array.isArray(body.orders))throw Error("تعذّر التحقق من الإرسالية المرتبطة.");
   const found=body.orders.find((row:import("@/lib/lab").LabOrder)=>row.id===orderId&&row.patientId===patientId);
   if(!found)throw Error("لم تُثبت الإرسالية لهذا المريض؛ حدّث بيانات العمل.");
   if(lifetime.active)setOrder(found);
  }catch(reason){if(lifetime.active)setError(reason instanceof Error?reason.message:"تعذّر التحميل.");}
  finally{if(lifetime.active)setBusy(false);}
 }
 return <div className="mt-3 rounded-lg border border-sky-200 p-3 text-xs">
  <p>هذا العمل مرتبط بالإرسالية RX-{orderId}. تُراجع المواصفات الحالية في نفس الطلب دون إنشاء طلب آخر.</p>
  <button type="button" disabled={disabled||busy} className="mt-2 min-h-11 rounded-lg border px-3 font-bold" onClick={()=>void open()}>فتح الإرسالية المرتبطة</button>
  {error&&<p role="alert" className="mt-2 text-red-700">{error}</p>}
  {order&&order.status==="needed"&&<LabPrescriptionEditor order={order} onClose={()=>setOrder(null)} onSaved={()=>{setOrder(null);onChanged();}}/>}
  {order&&order.status!=="needed"&&<LabPrescriptionModal order={order} onClose={()=>setOrder(null)}/>}
 </div>;
}
