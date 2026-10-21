"use client";
import {useEffect,useRef,useState} from "react";
import {formatMoney,type Currency} from "@/lib/money";
import type {SimilarCollectionReceipt,SimilarCollectionReview} from "@/lib/similar-collection";

type Preview={receipts:SimilarCollectionReceipt[];windowHours:number};
type Pending={preview:Preview;confirm:()=>Promise<void>};
function validPreview(value:unknown):value is Preview{
  if(!value||typeof value!=="object")return false;
  const v=value as Preview;
  return v.windowHours===24&&Array.isArray(v.receipts)&&v.receipts.length<=32&&v.receipts.every(r=>
    !!r&&Number.isSafeInteger(r.id)&&r.id>0&&typeof r.receiptNumber==="string"
    &&Number.isSafeInteger(r.amountMinor)&&r.amountMinor>0&&typeof r.currency==="string"
    &&typeof r.createdAt==="string"&&Number.isFinite(Date.parse(r.createdAt))
    &&typeof r.method==="string"&&typeof r.createdBy==="string"
    &&(r.invoiceId===null||Number.isSafeInteger(r.invoiceId))
    &&(r.planId===null||Number.isSafeInteger(r.planId))
    &&(r.openingCurrency===null||typeof r.openingCurrency==="string"));
}
/** Resolves a preview before invoking the exact captured post. Network uncertainty
 * in the read refuses to silently proceed; a stale server-side snapshot is 409. */
export function useSimilarCollectionWarning(){
  const [pending,setPending]=useState<Pending|null>(null);
  const generation=useRef(0);
  useEffect(()=>()=>{generation.current++;},[]);
  const cancel=()=>{generation.current++;setPending(null);};
  const check=async(args:{patientId:number;amountMinor:number;currency:Currency;onProceed:(review:SimilarCollectionReview)=>Promise<void>})=>{
    const token=++generation.current;
    const response=await fetch(`/api/payments/similar?patientId=${args.patientId}&amountMinor=${args.amountMinor}&currency=${args.currency}`,{cache:"no-store"});
    const payload:unknown=await response.json().catch(()=>null);
    if(token!==generation.current)return;
    if(!response.ok||!validPreview(payload))throw new Error("تعذّر فحص السندات السابقة. لم تُسجّل دفعة؛ حاول مرة أخرى.");
    const observedReceiptIds=payload.receipts.map(row=>row.id);
    if(observedReceiptIds.length===0){
      await args.onProceed({observedReceiptIds,confirmed:false});return;
    }
    setPending({preview:payload,confirm:()=>args.onProceed({observedReceiptIds,confirmed:true})});
  };
  const confirm=async()=>{const current=pending;if(!current)return;setPending(null);await current.confirm();};
  return {pending,check,confirm,cancel};
}
export function SimilarCollectionWarning({pending,onConfirm,onCancel}:{pending:Pending|null;onConfirm:()=>void;onCancel:()=>void}){
  if(!pending)return null;
  return <div role="dialog" aria-modal="true" aria-label="تنبيه سند قبض مشابه" dir="rtl"
    className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/60 p-4">
    <section className="w-full max-w-lg max-h-[90dvh] overflow-auto rounded-2xl bg-white p-5 shadow-2xl space-y-3">
      <h3 className="text-lg font-extrabold text-amber-900">⚠️ تنبيه: يوجد سند قبض مشابه</h3>
      <p className="text-sm text-slate-700">سبق تسجيل تحصيل بنفس المبلغ والعملة لهذا المريض خلال آخر 24 ساعة. تأكد من أن المبلغ لم يُحصّل سابقًا.</p>
      <div className="space-y-2">
        {pending.preview.receipts.slice(0,6).map(r=><div key={r.id} className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="font-extrabold">السند {r.receiptNumber} · {formatMoney(r.amountMinor,r.currency)}</p>
          <p>الوقت: {new Date(r.createdAt).toLocaleString("ar-YE",{timeZone:"Asia/Aden"})}</p>
          <p>الطريقة: {r.method==="transfer"?"تحويل":"نقدًا"}{r.invoiceId?` · الفاتورة #${r.invoiceId}`:r.planId?` · الخطة #${r.planId}`:""}</p>
          <p>الموظف: {r.createdBy}</p>
          <a href={`/print/receipt/${r.id}`} target="_blank" rel="noopener noreferrer" className="font-bold text-blue-800 underline">مراجعة السند</a>
        </div>)}
      </div>
      {pending.preview.receipts.length>6?<p className="text-xs text-amber-900">توجد سندات مشابهة أخرى في آخر 24 ساعة؛ راجع كشف الحساب.</p>:null}
      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className="flex-1 rounded-xl border border-slate-300 p-3 font-bold">إلغاء</button>
        <button type="button" onClick={onConfirm} className="flex-1 rounded-xl bg-amber-600 p-3 font-bold text-white">تسجيل الدفعة رغم التشابه</button>
      </div>
    </section>
  </div>;
}
