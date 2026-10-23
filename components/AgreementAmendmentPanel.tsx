"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import {formatMoney,parseAmount,toInputAmount,type Currency} from "@/lib/money";
import {quoteAgreementAmendment} from "@/lib/agreement-amendment-quote";
type View={
 planId:number;patientId:number;currency:Currency;itemId:number;caseId:number|null;quantity:number;
 oldServiceId:number;oldUnitMinor:number;previousAgreementMinor:number;
 recordedPaymentsMinor:number;recordedRefundsMinor:number;sourceHash:string;
 services:{id:number;name:string;category:string|null}[];
};
const storageKey=(planId:number)=>`aqlan:agreement-amendment:pending:${planId}`;
type Pending={key:string;body:string};
const isPending=(value:unknown):value is Pending=>!!value&&typeof value==="object"
 && "key" in value&&typeof value.key==="string"&&"body" in value&&typeof value.body==="string";
export function AgreementAmendmentPanel({planId,onChanged}:{planId:number;onChanged:()=>Promise<void>}){
 const [opened,setOpened]=useState(false),[view,setView]=useState<View|null>(null);
 const [serviceId,setServiceId]=useState(""),[unitPrice,setUnitPrice]=useState("");
 const [reason,setReason]=useState(""),[message,setMessage]=useState<string|null>(null),[busy,setBusy]=useState(false);
 const [pending,setPending]=useState<Pending|null>(null),[refused,setRefused]=useState(false),
  [previewVersion,setPreviewVersion]=useState(0),active=useRef(false),submitting=useRef(false);
 useEffect(()=>{active.current=true;
  try{const raw=sessionStorage.getItem(storageKey(planId));if(raw){const parsed:unknown=JSON.parse(raw);if(isPending(parsed))setPending(parsed);}}catch{/* Keep uncertain, never invent success. */}
  return()=>{active.current=false;};
 },[planId]);
 useEffect(()=>{if(!opened)return;let cancelled=false;
   void (async()=>{try{
    const response=await fetch(`/api/plans/${planId}/agreement-amendment`,{cache:"no-store"});
    const value:unknown=await response.json();
    if(cancelled)return;
    if(!response.ok||!value||typeof value!=="object"||!("planId" in value)
      ||value.planId!==planId||!("sourceHash" in value)||typeof value.sourceHash!=="string")
      throw Error("تعذّرت معاينة مصدر الاتفاق الآمن.");
    setView(value as View);setMessage(null);
   }catch{if(!cancelled)setMessage("البيانات أو الهجرة المالية غير جاهزة؛ لا يمكن حفظ التعديل.");}})();
   return()=>{cancelled=true;};
 },[planId,opened,previewVersion]);
 const proposal=useMemo(()=>{
  if(!view||!serviceId||!reason.trim())return null;
  const price=parseAmount(unitPrice,view.currency);
  if(price===null)return null;
  try{return quoteAgreementAmendment({...view,previousServiceId:view.oldServiceId,selectedServiceId:Number(serviceId),
   previousUnitPriceMinor:view.oldUnitMinor,selectedUnitPriceMinor:price,reason});}catch{return null;}
 },[view,serviceId,unitPrice,reason]);
  /** A 409 is NOT a no-save certificate. The status endpoint serializes with
   * the writer and only a committed rejection tombstone can free the key.
   * 'unresolved' and 403 retain the exact body, including after a lost reply.
   */
 const verifyAttempt=async(command:Pending)=>{
   try{
     const response=await fetch(`/api/plans/${planId}/agreement-amendment`,{
       method:"PUT",headers:{"Content-Type":"application/json"},body:command.body,
       cache:"no-store",redirect:"manual"});
     const data:unknown=await response.json();
     if(response.redirected||!response.ok||!data||typeof data!=="object"){
       setMessage("تعذّر تأكيد حالة المحاولة لدى الخادم؛ ما زال المفتاح والطلب محفوظين.");
       return;
     }
     const status=data as Record<string,unknown>;
     if(status.state==="rejected_stale" && status.requestKey===command.key){
       setRefused(true);
       setMessage("ثبت من سجل الخادم أن هذه المحاولة رُفضت دون إنشاء فاتورة. حدّث المعاينة ثم صحّح الطلب.");
     }else if(status.state==="committed"&&status.receipt&&typeof status.receipt==="object"){
       const receipt=status.receipt as Record<string,unknown>;
       const body=JSON.parse(command.body) as Record<string,unknown>;
       if(receipt.idempotencyKey!==command.key||receipt.planId!==planId||
         receipt.newServiceId!==body.newServiceId||!Number.isSafeInteger(receipt.deltaInvoiceId)){
         setMessage("إقرار الخادم لا يطابق الطلب؛ احتفظ بالمفتاح وراجع السجلات.");
         return;
       }
       await onChanged();
       if(!active.current)return;
       sessionStorage.removeItem(storageKey(planId));
       setPending(null);setRefused(false);setView(null);setOpened(false);
       setMessage("أكد الخادم أن التعديل محفوظ بالفعل. لم تُنشأ فاتورة فرق ثانية.");
     }else{
       setMessage("لا يوجد حتى الآن دليل نهائي لهذه المحاولة. أعد إرسال الطلب الأصلي نفسه؛ لا تنشئ مفتاحًا جديدًا.");
     }
   }catch{
     setMessage("انقطع اتصال فحص الحالة. يحتفظ المتصفح بالطلب ومفتاحه دون تغيير.");
   }
 };
 const send=async()=>{
  if(submitting.current||(!pending&&(!view||!proposal||proposal.deltaMinor<=0)))return;
  submitting.current=true;setBusy(true);setMessage(null);setRefused(false);
  try{
   let command=pending;
   if(!command){
    if(!view||!proposal)return;
    command={key:crypto.randomUUID(),body:JSON.stringify({idempotencyKey:"",expectedSourceHash:view.sourceHash,
     newServiceId:Number(serviceId),newUnitMinor:proposal.selectedUnitPriceMinor,reason:reason.trim()})};
    const obj=JSON.parse(command.body) as Record<string,unknown>;obj.idempotencyKey=command.key;
    command={...command,body:JSON.stringify(obj)};
    sessionStorage.setItem(storageKey(planId),JSON.stringify(command));setPending(command);
   }
   const request=JSON.parse(command.body) as Record<string,unknown>;
   const response=await fetch(`/api/plans/${planId}/agreement-amendment`,{
    method:"POST",headers:{"Content-Type":"application/json"},body:command.body,redirect:"manual"});
   const data:unknown=await response.json();
   if(!response.redirected&&[200,201].includes(response.status)&&!!data&&typeof data==="object"&&
     "planId" in data&&data.planId===planId&&"idempotencyKey" in data&&data.idempotencyKey===command.key&&
     "deltaInvoiceId" in data&&Number.isSafeInteger(data.deltaInvoiceId)&&
     "newServiceId" in data&&data.newServiceId===request.newServiceId){
     await onChanged();if(!active.current)return;
     sessionStorage.removeItem(storageKey(planId));setPending(null);
     setMessage("تم توثيق فرق الاتفاق. بقيت الفاتورة الأصلية والمدفوعات دون تعديل.");
     setView(null);setOpened(false);
   }else{
     const terminal=!response.redirected&&[400].includes(response.status)&&
       !!data&&typeof data==="object"&&"code" in data&&
       ["invalid","unauthorized","missing","stale","conflict"].includes(String(data.code));
     if(!response.redirected&&response.status===409&&
       !!data&&typeof data==="object"&&"code" in data&&data.code==="stale"){
       // Only the exact, committed server rejection releases this request key.
       await verifyAttempt(command);
     }else if(terminal){
       setRefused(true);
       setMessage("رفض نهائي مؤكد دون حفظ: "+("message" in data?String(data.message):"أعد مراجعة المصدر")+
         " يمكنك تحديث المعاينة وتصحيح الطلب بمفتاح جديد.");
     }else{
       setMessage("نتيجة غير مؤكدة: احتفظ بالطلب ومفتاحه وأعد المحاولة نفسها؛ لا تصنع طلبًا بديلًا.");
     }
   }
  }catch{if(active.current)setMessage("انقطع الرد ولم يتأكد الحفظ. الطلب ومفتاحه محفوظان لإعادة المحاولة نفسها.");}
  finally{submitting.current=false;if(active.current)setBusy(false);}
 };
 const refreshAfterRefusal=()=>{
  if(busy||submitting.current||!pending||!refused)return;
  try{sessionStorage.removeItem(storageKey(planId));}catch{
    setMessage("تعذر مسح المحاولة المرفوضة؛ لا تنشئ طلبًا جديدًا.");return;
  }
  setPending(null);setRefused(false);setView(null);setServiceId("");
  setUnitPrice("");setMessage("تم إلغاء المحاولة المرفوضة؛ راجع الاتفاق والخدمة والسعر من جديد.");
  setPreviewVersion(v=>v+1);
 };
 return <section dir="rtl" className="mt-3 space-y-3 rounded-xl border border-amber-300 p-3" data-testid="agreement-amendment">
  <button type="button" className="font-bold underline" onClick={()=>setOpened(!opened)}>ترقية خدمة الاتفاق بفرق مؤرخ</button>
  {opened?<div className="space-y-3">
   <p className="text-xs">التعديل للترقية الموجبة فقط. لن تُحرّر الفاتورة الأصلية أو السندات أو العمولة القديمة.</p>
   {view?<><dl className="grid grid-cols-2 gap-2">
    <div><dt>الاتفاق السابق</dt><dd>{formatMoney(view.previousAgreementMinor,view.currency)}</dd></div>
    <div><dt>المدفوع المثبت بالصافي</dt><dd>{formatMoney(view.recordedPaymentsMinor-view.recordedRefundsMinor,view.currency)}</dd></div>
    <div><dt>الخدمة السابقة</dt><dd>{view.services.find(s=>s.id===view.oldServiceId)?.name??`#${view.oldServiceId}`}</dd></div>
    <div><dt>العدد</dt><dd>{view.quantity}</dd></div>
   </dl>
   <fieldset disabled={busy||!!pending} className="space-y-2">
    <label className="block">الخدمة الجديدة — اختيار صريح<select className="input mt-1 w-full" value={serviceId} onChange={e=>setServiceId(e.target.value)}><option value="">اختر الخدمة</option>{view.services.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
    <label className="block">سعر الوحدة الجديد ({view.currency})<input className="input mt-1 w-full" inputMode="decimal" value={unitPrice} onChange={e=>setUnitPrice(e.target.value)} placeholder={toInputAmount(view.oldUnitMinor,view.currency)}/></label>
    <label className="block">سبب التعديل وموافقة المريض<textarea className="input mt-1 w-full" maxLength={300} value={reason} onChange={e=>setReason(e.target.value)}/></label>
   </fieldset>
   {proposal?<dl className="grid grid-cols-2 gap-2 rounded-lg border p-2 text-sm">
    <div><dt>الاتفاق الجديد</dt><dd>{formatMoney(proposal.revisedAgreementMinor,view.currency)}</dd></div>
    <div><dt>الفرق فقط</dt><dd>{formatMoney(proposal.deltaMinor,view.currency)}</dd></div>
    <div><dt>المتبقي الجديد</dt><dd>{formatMoney(proposal.remainingMinor,view.currency)}</dd></div>
    <div><dt>أثر الخطة</dt><dd>إضافة فرق مالي مؤرخ دون تغيير الأعمال الموقعة</dd></div>
   </dl>:null}
   </>:null}
   {pending?<p role="status">هناك طلب سابق محفوظ بمفتاح {pending.key.slice(0,8)}… {refused?"رفضه الخادم نهائيًا ولم يحفظ.":"لا تغيّر الطلب حتى تتأكد نتيجته."}</p>:null}
   {pending&&!refused?<button type="button" className="rounded-lg border px-3 py-2 font-bold" disabled={busy}
     onClick={()=>void verifyAttempt(pending)}>تحقق من حالة طلب التعديل المحفوظ</button>:null}
   {pending&&refused?<button type="button" className="rounded-lg border px-3 py-2 font-bold" disabled={busy}
     onClick={refreshAfterRefusal}>تحديث المعاينة وتصحيح الطلب المرفوض</button>:null}
   {message?<p role="alert">{message}</p>:null}
   <button type="button" className="btn-primary" disabled={busy||refused||(!pending&&(!proposal||proposal.deltaMinor<=0))}
    onClick={()=>void send()}>{busy?"جارٍ التحقق…":pending?"إعادة الطلب المحفوظ نفسه":"حفظ فرق التعديل المؤرخ"}</button>
  </div>:null}
 </section>;
}
