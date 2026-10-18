"use client";
import { useRef, useState } from "react";
import { formatMoney, parseAmount, type Currency } from "@/lib/money";
import type { approvedAgreementPosition } from "@/lib/approved-agreements";

type Position=Awaited<ReturnType<typeof approvedAgreementPosition>>;
export function ApprovedAgreementPanel({planId,totalMinor,currency,position,canApprove,isAdmin,onChanged}:{
  planId:number;totalMinor:number;currency:Currency;position:Position;canApprove:boolean;isAdmin:boolean;onChanged:()=>Promise<void>;
}){
  const [expanded,setExpanded]=useState(false),[kind,setKind]=useState("new"),[invoiceId,setInvoiceId]=useState("");
  const [historical,setHistorical]=useState(""),[reason,setReason]=useState(""),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);
  const [uncertain,setUncertain]=useState(false);
  const attempt=useRef<{body:string;key:string}|null>(null);
  async function submit(){
    if(busy)return;
    if(!attempt.current){
      const source=kind==="invoice"?{kind,invoiceId:Number(invoiceId)}:kind==="opening"?{kind,historicalPaidMinor:parseAmount(historical,currency)}:{kind};
      attempt.current={body:JSON.stringify({expectedTotalMinor:totalMinor,currency,source,reason}),key:crypto.randomUUID()};
    }
    setBusy(true);setMessage(null);
    try{
      const response=await fetch(`/api/plans/${planId}/financial-approval`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":attempt.current.key},body:attempt.current.body});
      const result=await response.json();
      if(!response.ok){
        if(response.status<500&&!uncertain)attempt.current=null;else setUncertain(true);
        setMessage(result.message??"تعذّر تأكيد الاعتماد. حدّث الخطة للتحقق.");return;
      }
      await onChanged();attempt.current=null;setUncertain(false);setExpanded(false);
    }catch{setUncertain(true);setMessage("تعذّر تأكيد النتيجة. أعد الطلب نفسه أو حدّث الخطة للتحقق؛ لا تُدخل أصلًا بديلًا.");}
    finally{setBusy(false);}
  }
  if(position)return <section data-testid="approved-agreement" className="mb-3 rounded-xl border border-emerald-200 p-3 text-sm">
    <p className="font-bold">التزام مالي معتمد · {formatMoney(position.totalMinor,currency)}</p>
    <dl className="my-2 grid grid-cols-2 gap-2"><div><dt>كامل المتبقي</dt><dd className="font-bold">{formatMoney(position.remainingMinor,currency)}</dd></div><div><dt>المستحق حتى اليوم</dt><dd className="font-bold">{formatMoney(position.dueNowMinor,currency)}</dd></div></dl>
    <p className="text-xs">المصدر: {position.invoiceId?`فاتورة #${position.invoiceId}`:`رصيد افتتاحي ${currency}`} · التحصيل يخفض هذا المصدر.</p>
    {!position.available?<p role="alert">تغيّر المصدر؛ يلزم مراجعة مالية قبل التحصيل.</p>:null}
    <a className="mt-2 inline-block underline" href={`/print/plan/${planId}`} target="_blank" rel="noreferrer">طباعة الاتفاق ورصيده</a>
  </section>;
  if(!canApprove)return null;
  return <section className="mb-3 rounded-xl border border-slate-200 p-3 text-sm">
    <button type="button" className="font-bold underline" onClick={()=>setExpanded(!expanded)}>اعتماد أصل الاتفاق المالي</button>
    {expanded?<div className="mt-3 space-y-3">
      <p>اعتماد كامل {formatMoney(totalMinor,currency)} كالتزام مستقل عن مواعيد الأقساط. راجع المصدر؛ الموافقة العلاجية وحدها لا تثبت هذا الأصل.</p>
      <fieldset disabled={busy||uncertain} className="space-y-2">
        <label className="block">مصدر الأصل<select className="input mt-1 w-full" value={kind} onChange={e=>setKind(e.target.value)}><option value="new">اتفاق جديد — إصدار فاتورة بكامل الأصل</option>{isAdmin?<><option value="invoice">مطابقة فاتورة كاملة قائمة — دون أصل جديد</option><option value="opening">مطابقة رصيد افتتاحي — دون أصل جديد</option></>:null}</select></label>
        {kind==="invoice"?<label className="block">رقم الفاتورة المطابقة<input className="input w-full" inputMode="numeric" value={invoiceId} onChange={e=>setInvoiceId(e.target.value)}/></label>:null}
        {kind==="opening"?<label className="block">مدفوع تاريخي قبل الافتتاحي ({currency})<input className="input w-full" inputMode="decimal" value={historical} onChange={e=>setHistorical(e.target.value)}/><span className="text-xs">يجب أن يساوي الافتتاحي كامل الاتفاق ناقص هذا المدفوع. لا يُسجّل سند قبض تاريخي.</span></label>:null}
        <label className="block">سبب الاعتماد أو دليل المطابقة<textarea className="input w-full" maxLength={300} value={reason} onChange={e=>setReason(e.target.value)}/></label>
      </fieldset>
      {message?<p role="alert">{message}</p>:null}
      <button type="button" className="btn-primary" disabled={busy||!uncertain&&reason.trim().length<3} onClick={()=>void submit()}>{busy?"جارٍ الاعتماد…":uncertain?"إعادة الطلب نفسه":"تأكيد المبلغ والمصدر واعتماد الالتزام"}</button>
      <button type="button" className="ms-3 underline" disabled={busy} onClick={()=>void onChanged()}>تحديث الخطة</button>
    </div>:null}
  </section>;
}
