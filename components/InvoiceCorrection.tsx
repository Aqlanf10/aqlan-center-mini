"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatMoney, parseAmount, toInputAmount } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { readInvoiceCommandResponse } from "@/lib/invoice-command-transport";
import { durableInvoiceRevision, readInvoiceRevisionReceipt, readInvoiceRevisionView, revisionRecord,
  type InvoiceRevisionCommand, type InvoiceRevisionView } from "@/lib/invoice-revision-view";
import type { FinancialRecoveryControl } from "@/lib/financial-command-journal";
import { DebtRepaymentEditor, readDebtRepaymentDraft, type DebtRepaymentDraft } from "./DebtRepaymentEditor";
import { useSession } from "./SessionProvider";

type Draft={keep:boolean;quantity:string;price:string};
const button="min-h-11 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50";
const input="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm";
export function InvoiceCorrection({patientId,invoiceId,recovery,onRecoveryChange,financialRecovery,onDone,onCancel}:{
  patientId:number;invoiceId:number;recovery:InvoiceRevisionCommand|null;onRecoveryChange:(command:InvoiceRevisionCommand|null)=>void;
  financialRecovery:FinancialRecoveryControl;onDone:(message:string)=>void;onCancel:()=>void;
}){
  const session=useSession();
  const [view,setView]=useState<InvoiceRevisionView|null>(null);
  const [drafts,setDrafts]=useState<Record<number,Draft>>({});
  const [discount,setDiscount]=useState("0"),[discountReason,setDiscountReason]=useState("");
  const [reason,setReason]=useState("");
  const [terms,setTerms]=useState<DebtRepaymentDraft>({mode:"full",rows:[]});
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const lifetime=useRef({active:false,generation:0});const pending=useRef(false),draftRevision=useRef(financialRecovery.revision);
  const initialRecovery=useRef(recovery);
  useLayoutEffect(()=>{const owner=lifetime.current;owner.active=true;return()=>{owner.active=false;owner.generation++;};},[]);
  const load=useCallback(async()=>{
    const generation=++lifetime.current.generation;
    try {
      const response=await fetch(`/api/invoices/${invoiceId}/correct`,{cache:"no-store"});
      const payload:unknown=await response.json();if(!lifetime.current.active||generation!==lifetime.current.generation)return;
      const next=response.ok?readInvoiceRevisionView(payload,patientId,invoiceId):null;
      if(!next||next.invoice.status==="cancelled")throw new Error(revisionRecord(payload)&&typeof payload.message==="string"?payload.message:"تعذّر قراءة الفاتورة الحالية. حدّث الحساب.");
      setView(next);setError(null);setDiscount(toInputAmount(next.invoice.discountMinor,next.invoice.baseCurrency));
      setDrafts(Object.fromEntries(next.invoice.items.map(item=>[item.id,{keep:true,quantity:String(item.quantity),price:toInputAmount(item.unitPriceMinor,next.invoice.baseCurrency)}])));
      // Existing terms can include already settled rows. Require deliberate redistribution when their sum differs.
      setTerms({mode:next.repaymentTerms.mode,rows:next.repaymentTerms.installments.map((row,index)=>({key:String(index),dueDate:row.dueDate,kind:row.kind,amount:toInputAmount(row.amountMinor,next.invoice.baseCurrency)}))});
    }catch(problem){if(lifetime.current.active&&generation===lifetime.current.generation){setView(null);setError(problem instanceof Error?problem.message:"تعذّر قراءة الفاتورة.");}}
  },[invoiceId,patientId]);
  useEffect(()=>{if(!initialRecovery.current)void load();},[load]); // Restored original intent does not depend on a fresh mutable snapshot.
  const preview=useMemo(()=>{
    if(!view)return null;const lines=[];let total=0;
    for(const item of view.invoice.items){const draft=drafts[item.id];if(!draft?.keep)continue;
      const quantity=Number(draft.quantity),unitPriceMinor=parseAmount(draft.price,view.invoice.baseCurrency);
      if(!Number.isSafeInteger(quantity)||quantity<1||unitPriceMinor===null)return null;
      const totalMinor=quantity*unitPriceMinor;total+=totalMinor;if(!Number.isSafeInteger(total))return null;
      lines.push({...item,quantity,unitPriceMinor,totalMinor});}
    const discountMinor=parseAmount(discount,view.invoice.baseCurrency);if(!lines.length||discountMinor===null||discountMinor>total)return null;
    const after=total-discountMinor,remaining=Math.max(0,after-view.settledMinor);
    return {lines,total,discountMinor,after,remaining,credit:Math.max(0,view.settledMinor-after),before:view.invoice.totalMinor-view.invoice.discountMinor};
  },[view,drafts,discount]);
  const allowed=financialRecovery.ready&&session?.role==="admin";
  const checked=preview?readDebtRepaymentDraft(terms,view!.invoice.baseCurrency,preview.remaining):null;
  const send=async(command:InvoiceRevisionCommand)=>{
    if(!allowed||pending.current||!lifetime.current.active||command.actor!==session.username||command.patientId!==patientId||command.invoiceId!==invoiceId)return;
    pending.current=true;setBusy(true);setError(null);onRecoveryChange({...command,outcome:"pending",message:"جارٍ حفظ التصحيح…"});
    try {
      const durable=durableInvoiceRevision(command);
      if(!await financialRecovery.reserve(durable,draftRevision.current)||!lifetime.current.active)return;
      const {response,payload}=await readInvoiceCommandResponse(signal=>fetch(`/api/invoices/${invoiceId}/correct`,{method:"POST",headers:{"Content-Type":"application/json"},body:command.body,signal}));
      if(!lifetime.current.active)return;
      const verified=[200,201].includes(response.status)&&!response.redirected?readInvoiceRevisionReceipt(payload,command):null;
      if(verified){await financialRecovery.acknowledge(durable);if(!lifetime.current.active)return;onRecoveryChange(null);
        onDone(`حُفظ التصحيح في ${verified.corrected.invoiceNumber}. بقيت إيصالات الأصل محفوظة.${verified.creditMinor>0?` رصيد لصالح المريض ${formatMoney(verified.creditMinor,verified.corrected.baseCurrency)}؛ لم يُصرف ردّ نقدي.`:""}`);
      }else{const refused=!response.redirected&&[400,409,404].includes(response.status)&&revisionRecord(payload)&&["invalid","stale","conflict","missing"].includes(String(payload.code))&&typeof payload.message==="string";
        onRecoveryChange({...command,outcome:refused?"refused":"uncertain",message:refused?String((payload as Record<string,unknown>).message):"لم يكتمل تأكيد النتيجة. احتُفظ بالمبالغ والمفتاح لإعادة الطلب نفسه."});}
    }catch{if(lifetime.current.active)onRecoveryChange({...command,outcome:"uncertain",message:"انقطع الرد. أعد نفس طلب التصحيح للتحقق قبل إجراء أي تعديل آخر."});}
    finally{pending.current=false;if(lifetime.current.active)setBusy(false);}
  };
  const submit=()=>{
    if(!view||!preview||!checked?.ok||recovery||!allowed||pending.current||reason.trim().length<3||preview.discountMinor>0&&discountReason.trim().length<3)return;
    const key=newIdempotencyKey();draftRevision.current=financialRecovery.revision;
    const body={idempotencyKey:key,expectedSourceHash:view.sourceHash,reason:reason.trim(),lines:preview.lines.map(item=>({itemId:item.id,quantity:item.quantity,unitPrice:toInputAmount(item.unitPriceMinor,view.invoice.baseCurrency)})),
      discount:toInputAmount(preview.discountMinor,view.invoice.baseCurrency),discountReason:discountReason.trim()||null,repaymentTerms:checked.value,expectedRemainingMinor:preview.remaining};
    void send({key,actor:session.username,patientId,invoiceId,body:JSON.stringify(body),expected:{original:view.invoice,lines:preview.lines,discountMinor:preview.discountMinor,settledMinor:view.settledMinor,accountDueMinor:view.accountDueMinor,terms:checked.value},outcome:"pending",message:""});
  };
  const clearRefused=async()=>{if(!recovery||recovery.outcome!=="refused"||busy)return;try{await financialRecovery.acknowledge(durableInvoiceRevision(recovery));if(lifetime.current.active){onRecoveryChange(null);setReason("");await load();}}catch{setError("تعذّر إغلاق الطلب المرفوض بأمان؛ أعد المحاولة.");}};
  const locked=busy||!!recovery||!allowed;
  const invoice=view?.invoice??recovery?.expected.original;
  return <section aria-label="تصحيح الفاتورة" data-testid="invoice-correction-editor" dir="rtl" className="my-4 min-w-0 space-y-4 rounded-2xl border border-amber-300 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-extrabold">تصحيح الفاتورة {invoice?.invoiceNumber}</h3>
      <button className={button} type="button" disabled={busy||!!recovery} onClick={onCancel}>إغلاق التصحيح</button></div>
    <p className="text-sm leading-7 text-slate-600">راجع المبلغ والأقساط قبل التأكيد. تُحفظ الفاتورة الأصلية وسبب التصحيح، وتبقى إيصالات القبض السابقة مرتبطة بها وتُحتسب للمصححة.</p>
    {error?<p role="alert" className="text-sm text-rose-800">{error}</p>:null}
    {!view&&!recovery?<button className={button} type="button" onClick={()=>void load()}>إعادة قراءة الفاتورة</button>:null}
    {recovery?<div role="status" data-testid="invoice-revision-recovery" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
      <p>{busy?"جارٍ حفظ التصحيح…":recovery.message}</p>
      <button type="button" className={button} disabled={busy||!allowed} onClick={()=>void send(recovery)}>إعادة نفس طلب التصحيح</button>
      {recovery.outcome==="refused"?<button type="button" className={button} disabled={busy} onClick={()=>void clearRefused()}>مراجعة التصحيح بعد الرفض</button>:null}
    </div>:null}
    {view?<><fieldset disabled={locked} className="space-y-3">
      {view.invoice.items.map((item,index)=>{const draft=drafts[item.id];const clinical=view.work.find(row=>row.id===item.planItemId)?.clinical_locked;return <div key={item.id} className="grid min-w-0 gap-3 rounded-xl border p-3 sm:grid-cols-3">
        <div className="text-sm"><strong>{item.description}</strong>{item.toothCode?<span> · سن {item.toothCode}</span>:null}
          <label className="mt-2 flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft?.keep??false} disabled={locked||clinical} onChange={event=>setDrafts(current=>({...current,[item.id]:{...current[item.id],keep:event.target.checked}}))}/>إبقاء البند</label>
          {clinical?<p className="text-xs leading-6 text-amber-900">له عمل أو مسودة سريرية؛ تبقى هويته وكميته محفوظتين.</p>:null}</div>
        <label className="min-w-0 text-xs font-bold">الكمية<input aria-label={`كمية التصحيح ${index+1}`} className={input} inputMode="numeric" disabled={locked||clinical} value={draft?.quantity??""} onChange={event=>setDrafts(current=>({...current,[item.id]:{...current[item.id],quantity:event.target.value}}))}/></label>
        <label className="min-w-0 text-xs font-bold">السعر ({view.invoice.baseCurrency})<input aria-label={`سعر التصحيح ${index+1}`} className={input} inputMode="decimal" dir="ltr" value={draft?.price??""} onChange={event=>setDrafts(current=>({...current,[item.id]:{...current[item.id],price:event.target.value}}))}/></label>
      </div>;})}
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">الخصم<input aria-label="خصم التصحيح" className={input} value={discount} onChange={event=>setDiscount(event.target.value)} inputMode="decimal"/></label>
        <label className="text-xs font-bold">سبب الخصم<input aria-label="سبب خصم التصحيح" className={input} value={discountReason} maxLength={300} onChange={event=>setDiscountReason(event.target.value)}/></label></div>
      <label className="block text-xs font-bold">سبب التصحيح المطلوب<textarea aria-label="سبب التصحيح" className={input} value={reason} maxLength={300} onChange={event=>setReason(event.target.value)}/></label>
    </fieldset>
    {preview?<><div aria-live="polite" className="grid gap-2 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2"><p>قبل التصحيح: {formatMoney(preview.before,view.invoice.baseCurrency)}</p><p>بعد التصحيح: <strong>{formatMoney(preview.after,view.invoice.baseCurrency)}</strong></p>
      <p>المحصّل المثبت: {formatMoney(view.settledMinor,view.invoice.baseCurrency)}</p><p>المتبقي للتحصيل: <strong>{formatMoney(preview.remaining,view.invoice.baseCurrency)}</strong></p>
      {preview.credit>0?<p className="font-bold text-sky-900">رصيد لصالح المريض {formatMoney(preview.credit,view.invoice.baseCurrency)}. صرفه يحتاج إجراء ردّ مستقل.</p>:null}</div>
      <DebtRepaymentEditor value={terms} onChange={setTerms} currency={view.invoice.baseCurrency} remainingMinor={preview.remaining} today={clinicDateString(new Date(),CLINIC_ZONE_FALLBACK)} disabled={locked}/></>:null}
    <button type="button" className={button+" bg-navy-800 text-white"} disabled={locked||!preview||!checked?.ok||reason.trim().length<3||preview.discountMinor>0&&discountReason.trim().length<3} onClick={submit}>تأكيد تصحيح الفاتورة</button>
    </>:null}
  </section>;
}
