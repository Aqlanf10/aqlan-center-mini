"use client";

import {useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import {formatMoney,parseAmount,toInputAmount} from "@/lib/money";
import {clinicDateString} from "@/lib/schedule";
import {CLINIC_ZONE_FALLBACK} from "@/lib/clinicZone";
import {newIdempotencyKey} from "@/lib/idempotency-key";
import {readInvoiceCommandResponse} from "@/lib/invoice-command-transport";
import {durableHistoricalCorrection,readHistoricalCorrectionReceipt,readHistoricalDocuments,type HistoricalCorrectionCommand,type HistoricalDocumentView} from "@/lib/historical-correction-view";
import type {FinancialRecoveryControl} from "@/lib/financial-command-journal";
import {DebtRepaymentEditor,readDebtRepaymentDraft,type DebtRepaymentDraft} from "./DebtRepaymentEditor";
import {useSession} from "./SessionProvider";

const input="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm";
const button="min-h-11 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50";
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
export function HistoricalCorrection({original,recovery,onRecoveryChange,financialRecovery,onDone,onCancel}:{
  original:HistoricalDocumentView;recovery:HistoricalCorrectionCommand|null;onRecoveryChange:(value:HistoricalCorrectionCommand|null)=>void;
  financialRecovery:FinancialRecoveryControl;onDone:(message:string)=>void;onCancel:()=>void;
}){
  const session=useSession(),[view,setView]=useState(original);
  const [prices,setPrices]=useState<string[]>([]),[discount,setDiscount]=useState("0"),[discountReason,setDiscountReason]=useState("");
  const [paid,setPaid]=useState(""),[date,setDate]=useState(""),[note,setNote]=useState(""),[reason,setReason]=useState("");
  const [terms,setTerms]=useState<DebtRepaymentDraft>({mode:"full",rows:[]});
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const lifetime=useRef({active:false}),pending=useRef(false),draftRevision=useRef(financialRecovery.revision);
  useLayoutEffect(()=>{const owner=lifetime.current;owner.active=true;return()=>{owner.active=false;};},[]);
  useEffect(()=>{setPrices(view.lines.map(line=>toInputAmount(line.unitPriceMinor,view.currency)));setDiscount(toInputAmount(view.discountMinor,view.currency));
    setDiscountReason(view.discountReason??"");setPaid(toInputAmount(view.previouslyPaidMinor,view.currency));setDate(view.historicalAsOf);setNote(view.note??"");
    const saved=view.repayment?.terms;
    setTerms({mode:saved?.mode??"full",rows:(saved?.installments??[]).map((row,index)=>({key:String(index),dueDate:row.dueDate,kind:row.kind,amount:toInputAmount(row.amountMinor,view.currency)}))});
  },[view]);
  const preview=useMemo(()=>{
    const amounts=prices.map(price=>parseAmount(price,view.currency)),deduction=parseAmount(discount,view.currency),prepaid=parseAmount(paid,view.currency);
    if(amounts.length!==view.lines.length||amounts.some(price=>price===null||price<=0)||deduction===null||prepaid===null)return null;
    const total=amounts.reduce<number>((sum,price)=>sum+(price??0),0),agreed=total-deduction,remaining=agreed-prepaid;
    const principal=view.openingPrincipalMinor-view.remainingMinor+remaining;
    if(!Number.isSafeInteger(total)||agreed<=0||remaining<0||!Number.isSafeInteger(principal)||principal<0)return null;
    const accountDue=view.accountDueMinor+remaining-view.remainingMinor;
    return {agreed,remaining,openingRemaining:Math.max(0,principal-view.openingCollectedMinor),credit:Math.max(0,-accountDue)};
  },[prices,discount,paid,view]);
  const checked=preview?readDebtRepaymentDraft(terms,view.currency,preview.openingRemaining):null;
  const allowed=financialRecovery.ready&&session?.role==="admin",locked=busy||!!recovery||!allowed;
  const send=async(command:HistoricalCorrectionCommand)=>{
    if(!allowed||pending.current||!lifetime.current.active||command.actor!==session.username||command.patientId!==view.patientId||command.documentId!==view.id)return;
    pending.current=true;setBusy(true);setError(null);onRecoveryChange({...command,outcome:"pending",message:"جارٍ حفظ تصحيح الاتفاق…"});
    try {
      const durable=durableHistoricalCorrection(command);
      if(!await financialRecovery.reserve(durable,draftRevision.current)||!lifetime.current.active)return;
      const {response,payload}=await readInvoiceCommandResponse(signal=>fetch(`/api/patients/${command.patientId}/historical-documents/${command.documentId}/correct`,
        {method:"POST",headers:{"Content-Type":"application/json"},body:command.body,signal}));
      if(!lifetime.current.active)return;
      const receipt=response.ok&&!response.redirected?readHistoricalCorrectionReceipt(payload,command):null;
      if(receipt){await financialRecovery.acknowledge(durable);if(!lifetime.current.active)return;onRecoveryChange(null);onDone(`حُفظ تصحيح الاتفاق #${receipt.id} في النسخة ${receipt.version}. بقيت السندات والخطط والحالات الأصلية محفوظة.`);}
      else {
        const refused=!response.redirected&&[400,404,409].includes(response.status)&&record(payload)&&["invalid","missing","stale","conflict"].includes(String(payload.code))&&typeof payload.message==="string";
        onRecoveryChange({...command,outcome:refused?"refused":"uncertain",message:refused?String((payload as Record<string,unknown>).message):"لم يكتمل تأكيد التصحيح. احتُفظ بالطلب والمفتاح لإعادة الطلب نفسه."});
      }
    }catch{if(lifetime.current.active)onRecoveryChange({...command,outcome:"uncertain",message:"انقطع الرد. أعد نفس طلب تصحيح الاتفاق للتحقق قبل أي عملية جديدة."});}
    finally{pending.current=false;if(lifetime.current.active)setBusy(false);}
  };
  const clearRefused=async()=>{
    if(!recovery||recovery.outcome!=="refused"||pending.current||!allowed)return;
    setBusy(true);try {
      await financialRecovery.acknowledge(durableHistoricalCorrection(recovery));
      const response=await fetch(`/api/patients/${view.patientId}/historical-documents`,{cache:"no-store"});
      const documents=response.ok?readHistoricalDocuments(await response.json(),view.patientId):null;
      const next=documents?.find(document=>document.id===view.id);
      if(!lifetime.current.active)return;onRecoveryChange(null);
      if(next?.correctionAvailable){setView(next);setReason("");}else onDone("حدّث الحساب لمراجعة حالة الاتفاق بعد الطلب المرفوض.");
    }catch{if(lifetime.current.active)setError("تعذّر إعادة قراءة الاتفاق. أعد المحاولة.");}
    finally{if(lifetime.current.active)setBusy(false);}
  };
  const submit=()=>{
    if(!allowed||locked||!preview||!checked?.ok||reason.trim().length<3||!date||(parseAmount(discount,view.currency)??0)>0&&discountReason.trim().length<3)return;
    const key=newIdempotencyKey();draftRevision.current=financialRecovery.revision;
    const body={idempotencyKey:key,expectedVersion:view.version,expectedSourceHash:view.sourceHash,prices,discount,discountReason:discountReason.trim()||null,
      previouslyPaidAmount:paid,historicalAsOf:date,note:note.trim()||null,reason:reason.trim(),repaymentTerms:checked.value,repaymentRemainingMinor:preview.openingRemaining,repaymentVersion:view.scheduleVersion};
    void send({key,actor:session.username,patientId:view.patientId,documentId:view.id,body:JSON.stringify(body),original:view,outcome:"pending",message:""});
  };
  return <section aria-label="تصحيح الاتفاق التاريخي" data-testid="historical-correction-editor" dir="rtl" className="my-4 min-w-0 space-y-4 rounded-2xl border border-violet-300 bg-white p-4">
    <div className="flex flex-wrap justify-between gap-2"><h3 className="font-extrabold">تصحيح الاتفاق التاريخي #{view.id} · النسخة {view.version}</h3>
      <button type="button" className={button} disabled={busy||!!recovery} onClick={onCancel}>إغلاق التصحيح التاريخي</button></div>
    <p className="text-sm leading-7 text-slate-600">تُحفظ النسخة السابقة وسبب التصحيح. المدفوع قبل النظام معلومة تاريخية؛ لا يُنشئ التصحيح فاتورة أو سند قبض أو ردّ نقدي.</p>
    {error?<p role="alert" className="text-sm text-rose-800">{error}</p>:null}
    {recovery?<div role="status" data-testid="historical-correction-recovery" className="space-y-3 rounded-xl bg-amber-50 p-3">
      <p>{busy?"جارٍ حفظ التصحيح…":recovery.message}</p><button type="button" className={button} disabled={busy||!allowed} onClick={()=>void send(recovery)}>إعادة نفس طلب تصحيح الاتفاق</button>
      {recovery.outcome==="refused"?<button type="button" className={button} disabled={busy||!allowed} onClick={()=>void clearRefused()}>مراجعة الاتفاق بعد الرفض</button>:null}
    </div>:null}
    <fieldset disabled={locked} className="space-y-3">
      {view.lines.map((line,index)=><label key={line.agreementId} className="block rounded-xl border p-3 text-sm"><strong>{line.description}{line.toothCode?` · سن ${line.toothCode}`:""}</strong>
        <span className="block text-xs text-slate-500">خطة #{line.planId} · بند #{line.planItemId}{line.caseId?` · حالة #${line.caseId}`:""}</span>
        <input aria-label={`سعر تصحيح الاتفاق ${index+1}`} className={input} inputMode="decimal" dir="ltr" value={prices[index]??""} onChange={event=>setPrices(current=>current.map((price,i)=>i===index?event.target.value:price))}/></label>)}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-bold">الخصم<input aria-label="خصم تصحيح الاتفاق" className={input} inputMode="decimal" value={discount} onChange={event=>setDiscount(event.target.value)}/></label>
        <label className="text-xs font-bold">سبب الخصم<input aria-label="سبب خصم الاتفاق" className={input} maxLength={300} value={discountReason} onChange={event=>setDiscountReason(event.target.value)}/></label>
        <label className="text-xs font-bold">المدفوع قبل النظام<input aria-label="المدفوع السابق المصحح" className={input} inputMode="decimal" value={paid} onChange={event=>setPaid(event.target.value)}/></label>
        <label className="text-xs font-bold">تاريخ المعلومات التاريخية<input aria-label="تاريخ الاتفاق المصحح" className={input} type="date" max={clinicDateString(new Date(),CLINIC_ZONE_FALLBACK)} value={date} onChange={event=>setDate(event.target.value)}/></label>
      </div>
      <label className="block text-xs font-bold">ملاحظة الاتفاق<textarea aria-label="ملاحظة الاتفاق المصححة" className={input} maxLength={300} value={note} onChange={event=>setNote(event.target.value)}/></label>
      <label className="block text-xs font-bold">سبب التصحيح<textarea aria-label="سبب تصحيح الاتفاق" className={input} maxLength={300} value={reason} onChange={event=>setReason(event.target.value)}/></label>
    </fieldset>
    {preview?<><div aria-live="polite" className="grid gap-2 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
      <p>المتفق عليه سابقًا: {formatMoney(view.agreedMinor,view.currency)}</p><p>المتفق عليه بعد التصحيح: <strong>{formatMoney(preview.agreed,view.currency)}</strong></p>
      <p>المتبقي التاريخي المصحح: {formatMoney(preview.remaining,view.currency)}</p><p>المتبقي الفعلي لكامل الرصيد السابق: <strong>{formatMoney(preview.openingRemaining,view.currency)}</strong></p>
      {preview.credit>0?<p className="font-bold text-sky-900">رصيد لصالح المريض: {formatMoney(preview.credit,view.currency)}. لم يُصرف ردّ نقدي.</p>:null}
    </div><DebtRepaymentEditor compact value={terms} onChange={setTerms} currency={view.currency} remainingMinor={preview.openingRemaining} today={clinicDateString(new Date(),CLINIC_ZONE_FALLBACK)} disabled={locked}/></>:<p role="alert" className="text-sm text-rose-800">راجع الأسعار والخصم والمدفوع السابق؛ يجب ألا يتجاوز المدفوع القديم الاتفاق المصحح.</p>}
    <button type="button" className={button+" bg-navy-800 text-white"} disabled={locked||!preview||!checked?.ok||reason.trim().length<3||!date||(parseAmount(discount,view.currency)??0)>0&&discountReason.trim().length<3} onClick={submit}>تأكيد تصحيح الاتفاق</button>
  </section>;
}
