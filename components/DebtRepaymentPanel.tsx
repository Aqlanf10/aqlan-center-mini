"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatAmount, formatMoney, parseAmount, type Currency } from "@/lib/money";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { readInvoiceCommandResponse } from "@/lib/invoice-command-transport";
import { debtRecord, readDebtRepaymentWorkspace, type DebtRepaymentChoice, type DebtRepaymentView, type DebtRepaymentWorkspace, type DebtRepaymentTarget } from "@/lib/debt-repayment-view";
import { validateDebtRepaymentTerms, type DebtRepaymentTerms } from "@/lib/debt-installments";
import { DebtRepaymentEditor, readDebtRepaymentDraft, type DebtRepaymentDraft } from "./DebtRepaymentEditor";
import { useSession } from "./SessionProvider";

/** Retained by the patient/actor owner above this panel, including A -> B -> A. */
export interface DebtRepaymentCommand {
  url:string;body:string;key:string;target:DebtRepaymentTarget;actor:string;
  expected:{kind:"schedule";version:number;terms:DebtRepaymentTerms;status:"active"|"cancelled"}|{kind:"collection";amountMinor:number;currency:Currency;method:string};
  outcome:"pending"|"uncertain"|"refused";message:string;
}
const button="min-h-[44px] rounded-xl border border-slate-300 px-3 text-sm font-bold disabled:opacity-50";
const sameTarget=(left:Record<string,unknown>,right:DebtRepaymentTarget)=>left.patientId===right.patientId&&left.currency===right.currency&&left.invoiceId===right.invoiceId&&left.openingCurrency===right.openingCurrency;
function verifiedReceipt(value:unknown,command:DebtRepaymentCommand):number|null {
  if(!debtRecord(value))return null;
  const positive=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>0;
  if(command.expected.kind==="schedule"){
    const receipt=value.receipt;
    const expected=command.expected.terms;
    const normalized=debtRecord(receipt)?validateDebtRepaymentTerms(receipt.terms,expected.installments.reduce((sum,row)=>sum+row.amountMinor,0)):null;
    if(!positive(value.arrangementId)||!positive(value.revisionId)||value.version!==command.expected.version||!debtRecord(receipt)||!debtRecord(receipt.target)
      ||!sameTarget(receipt.target,command.target)||receipt.idempotencyKey!==command.key||receipt.createdBy!==command.actor||receipt.status!==command.expected.status
      ||!normalized?.ok||JSON.stringify(normalized.value)!==JSON.stringify(expected))return null;
    return 0;
  }
  const payment=value.payment;
  if(!debtRecord(payment)||!positive(payment.id)||typeof payment.receiptNumber!=="string"||!payment.receiptNumber.trim()
    ||payment.patientId!==command.target.patientId||payment.invoiceId!==command.target.invoiceId||payment.openingCurrency!==command.target.openingCurrency||payment.planId!==null
    ||payment.kind!=="payment"||payment.amountMinor!==command.expected.amountMinor||payment.currency!==command.expected.currency||payment.method!==command.expected.method
    ||payment.createdBy!==command.actor||typeof payment.exchangeRate!=="number"||!Number.isFinite(payment.exchangeRate)||payment.exchangeRate<=0
    ||!positive(payment.baseAmountMinor))return null;
  return payment.id;
}

export function DebtRepaymentPanel({patientId,refreshKey,recovery,onRecoveryChange,onHold,onChanged,enabled}:{
  patientId:number;refreshKey:unknown;recovery:DebtRepaymentCommand|null;onRecoveryChange:(command:DebtRepaymentCommand|null)=>void;
  onHold:(held:boolean)=>void;onChanged:()=>void;enabled:boolean;
}){
  const session=useSession();
  const [data,setData]=useState<DebtRepaymentWorkspace|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const [receiptId,setReceiptId]=useState<number|null>(null);
  const [editing,setEditing]=useState<DebtRepaymentChoice|null>(null);
  const [collecting,setCollecting]=useState<DebtRepaymentView|null>(null);
  const [draft,setDraft]=useState<DebtRepaymentDraft>({mode:"full",rows:[]});
  const [reason,setReason]=useState("");
  const [amount,setAmount]=useState("");
  const [tender,setTender]=useState<Currency>("YER");
  const [method,setMethod]=useState<"cash"|"transfer">("cash");
  const [note,setNote]=useState("");
  const [writing,setWriting]=useState(false);
  const pending=useRef(false);
  const lifetime=useRef({active:false,generation:0});
  useLayoutEffect(()=>{const owner=lifetime.current;owner.active=true;return()=>{owner.active=false;owner.generation++;};},[]);
  const held=writing||Boolean(recovery&&recovery.outcome!=="refused")||Boolean(editing||collecting);
  useLayoutEffect(()=>{onHold(held);},[held,onHold]);
  const load=useCallback(async()=>{
    if(!enabled||!lifetime.current.active)return;
    const generation=++lifetime.current.generation;
    try{
      const response=await fetch(`/api/patients/${patientId}/debt-repayments`,{cache:"no-store"});
      if(!lifetime.current.active||generation!==lifetime.current.generation)return;
      if(!response.ok){setData(null);throw new Error("تعذّر قراءة ترتيبات السداد أو انتهت الصلاحية.");}
      const payload=readDebtRepaymentWorkspace(await response.json(),patientId);
      if(!lifetime.current.active||generation!==lifetime.current.generation)return;
      if(!payload)throw new Error("بيانات ترتيب السداد غير مكتملة؛ حدّث الحساب.");
      setData(payload);setError(null);
    }catch(problem){if(lifetime.current.active&&generation===lifetime.current.generation){setData(null);setError(problem instanceof Error?problem.message:"تعذّر التحميل.");}}
  },[enabled,patientId]);
  useEffect(()=>{void load();},[load,refreshKey]);
  const allowed=enabled&&!!session&&["admin","reception"].includes(session.role);
  const send=async(command:DebtRepaymentCommand)=>{
    if(!allowed||pending.current||!lifetime.current.active||command.actor!==session.username||command.target.patientId!==patientId)return;
    pending.current=true;setWriting(true);onHold(true);setNotice(null);setReceiptId(null);
    onRecoveryChange({...command,outcome:"pending",message:"جارٍ حفظ الطلب…"});
    try{
      const {response,payload}=await readInvoiceCommandResponse(signal=>fetch(command.url,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":command.key},body:command.body,signal}),response=>{
        if(lifetime.current.active&&(response.status===401||response.status===403))setData(null);
      });
      if(!lifetime.current.active)return;
      const verified=(response.status===200||response.status===201)&&!response.redirected?verifiedReceipt(payload,command):null;
      if(verified!==null){
        onRecoveryChange(null);setEditing(null);setCollecting(null);setReason("");
        setNotice(command.expected.kind==="collection"?"ثُبّت التحصيل بسند قبض.":"حُفظ ترتيب سداد الدين القائم؛ لم تُنشأ فاتورة أو دفعة.");
        if(verified>0)setReceiptId(verified);
        onChanged();void load();
      }else{
        const refused=!response.redirected&&[400,409].includes(response.status)&&debtRecord(payload)&&typeof payload.message==="string"&&["invalid","stale","conflict","missing"].includes(String(payload.code));
        onRecoveryChange({...command,outcome:refused?"refused":"uncertain",message:refused?String((payload as Record<string,unknown>).message):"نتيجة الطلب غير مؤكدة. أعد الطلب نفسه للتحقق قبل أي تحصيل أو تعديل جديد."});
      }
    }catch{if(lifetime.current.active)onRecoveryChange({...command,outcome:"uncertain",message:"انقطع الاتصال أو لم يكتمل الرد. البيانات والمفتاح محفوظان لإعادة التحقق."});}
    finally{pending.current=false;if(lifetime.current.active)setWriting(false);}
  };
  const startEdit=(target:DebtRepaymentChoice)=>{
    if(!allowed||recovery||pending.current)return;
    const current=data?.arrangements.find(row=>row.id===target.arrangementId);
    setEditing(target);setCollecting(null);setReason("");
    setDraft(current?.terms.mode==="installments"?{mode:"installments",rows:(current.progress?.rows??[]).filter(row=>row.remainingMinor>0).map((row,index)=>({key:String(index),dueDate:row.dueDate,kind:row.kind,amount:formatAmount(row.remainingMinor,target.target.currency)}))}:{mode:"full",rows:[]});
  };
  const checked=editing?readDebtRepaymentDraft(draft,editing.target.currency,editing.remainingMinor):null;
  const saveSchedule=(cancel=false)=>{
    if(!editing||!allowed||recovery||pending.current||reason.trim().length<3||(!cancel&&!checked?.ok))return;
    const key=newIdempotencyKey();const terms:DebtRepaymentTerms=cancel?{mode:"full",installments:[]}:(checked as {ok:true;value:DebtRepaymentTerms}).value;
    const body={invoiceId:editing.target.invoiceId,openingCurrency:editing.target.openingCurrency,currency:editing.target.currency,terms,expectedVersion:editing.version,
      expectedRemainingMinor:editing.remainingMinor,expectedSourceHash:editing.sourceHash,reason:reason.trim(),idempotencyKey:key,cancel};
    void send({url:`/api/patients/${patientId}/debt-repayments`,body:JSON.stringify(body),key,target:editing.target,actor:session.username,
      expected:{kind:"schedule",version:editing.version+1,terms,status:cancel?"cancelled":"active"},outcome:"pending",message:""});
  };
  const collect=()=>{
    const minor=parseAmount(amount,tender);
    if(!collecting||!allowed||recovery||pending.current||minor===null||minor<=0||tender===collecting.target.currency&&minor>collecting.collectibleMinor)return;
    const key=newIdempotencyKey();
    void send({url:`/api/patients/${patientId}/debt-repayments/${collecting.id}/collect`,body:JSON.stringify({amount,currency:tender,method,note:note.trim()||null,expectedVersion:collecting.version}),key,target:collecting.target,actor:session.username,
      expected:{kind:"collection",amountMinor:minor,currency:tender,method},outcome:"pending",message:""});
  };
  const locked=writing||!!recovery;
  return <section aria-label="سداد الاتفاقات القائمة" data-testid="debt-repayment-panel" dir="rtl" className="my-4 min-w-0 space-y-3 rounded-2xl border border-slate-200 bg-white p-3 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-base font-extrabold">سداد الاتفاقات القائمة</h3>
      <button type="button" className={button} disabled={!allowed||writing||!!editing||!!collecting} onClick={()=>void load()}>تحديث ترتيب السداد</button></div>
    <p className="text-xs leading-6 text-slate-600">الأقساط توزّع دين الفاتورة أو الرصيد السابق. قيمة العلاج المخطط وغير المفوتر ليست دينًا جديدًا، والدفعة المقترحة ليست تحصيلًا.</p>
    {error?<p role="alert" className="text-sm text-rose-800">{error}</p>:null}
    {notice?<p role="status" className="text-sm font-bold text-emerald-800">{notice}</p>:null}
    {receiptId?<a className={button+" inline-flex items-center"} href={`/print/receipt/${receiptId}`} target="_blank" rel="noopener">طباعة سند التحصيل</a>:null}
    {recovery?<div role="status" data-testid="debt-command-recovery" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm">
      <p>{writing?"جارٍ حفظ الطلب…":recovery.message||"يوجد طلب محفوظ يحتاج إعادة التحقق."}</p>
      <button type="button" className={button} disabled={writing||!allowed} onClick={()=>void send(recovery)}>إعادة نفس طلب السداد</button>
      {recovery.outcome==="refused"?<button type="button" className={button} disabled={writing} onClick={()=>{onRecoveryChange(null);setEditing(null);setCollecting(null);void load();}}>مراجعة الحساب بعد الرفض</button>:null}
    </div>:null}
    {!enabled?<p role="status" className="text-xs text-slate-500">تُراجع ترتيبات السداد بعد إغلاق إدخال العلاج والتحقق من الحساب.</p>:null}
    {enabled&&data?.targets.length===0?<p className="text-sm text-slate-500">لا يوجد دين قائم يحتاج ترتيب سداد.</p>:null}
    {enabled&&data?.targets.map(target=>{
      const current=data.arrangements.find(row=>row.id===target.arrangementId);
      return <article key={`${target.target.invoiceId}:${target.target.openingCurrency}`} className="min-w-0 space-y-2 rounded-xl border border-slate-200 p-3">
        <h4 className="break-words text-sm font-bold">{target.label} · {target.target.currency}</h4>
        <div className="grid gap-1 text-xs sm:grid-cols-2"><p>قيمة مصدر الدين: {formatMoney(target.principalMinor,target.target.currency)}</p><p>صافي المحصّل عليه: {formatMoney(target.collectedMinor,target.target.currency)}</p>
          <p>متبقي المصدر: <strong>{formatMoney(target.remainingMinor,target.target.currency)}</strong></p><p>المستحق الفعلي للحساب: <strong>{formatMoney(target.accountDueMinor,target.target.currency)}</strong></p></div>
        {current?<><p className="text-xs font-bold">النسخة {current.version} · {current.status==="cancelled"?"ترتيب ملغى — الدين باقٍ حسب الحساب":current.terms.mode==="full"?"دفعة واحدة":"جدول أقساط"}</p>
          {current.progress&&current.status==="active"?<><p className="text-xs">المتأخر: {formatMoney(current.progress.overdueMinor,target.target.currency)} · المتبقي للتوزيع: {formatMoney(current.progress.unallocatedMinor,target.target.currency)}</p>
            <ol className="space-y-1 text-xs">{current.progress.rows.map((row,index)=><li key={index} className="flex flex-wrap gap-x-3 rounded-lg bg-slate-50 p-2"><span>{row.kind==="down_payment"?"دفعة مقدمة مقترحة":"قسط"} · {row.dueDate}</span><span>الموعد {formatMoney(row.amountMinor,target.target.currency)}</span><span>محصّل {formatMoney(row.settledMinor,target.target.currency)}</span><span>متبقٍ {formatMoney(row.remainingMinor,target.target.currency)}</span></li>)}</ol></>:null}
          {current.requiresReview?<p role="status" className="text-xs font-bold text-amber-900">تغيّر الدين أو تخصيص التحصيل؛ راجع التسويات وجدول المتبقي. حدّ التحصيل الحالي: {formatMoney(current.collectibleMinor,target.target.currency)}.</p>:null}
          <details className="text-xs"><summary className="min-h-[44px] cursor-pointer py-3 font-bold">سجل تعديلات السداد</summary><ol className="space-y-2">{current.history.map(row=><li key={row.version} className="break-words rounded-lg bg-slate-50 p-2">نسخة {row.version} · {row.status==="cancelled"?"إلغاء الترتيب":row.terms.mode==="full"?"دفعة واحدة":"أقساط"} · {row.reason} · {row.created_by} · {row.created_at}
            {row.terms.mode==="installments"?<ul>{row.terms.installments.map((term,index)=><li key={index}>{term.dueDate} · {formatMoney(term.amountMinor,target.target.currency)}</li>)}</ul>:null}</li>)}</ol></details>
        </>:null}
        {target.legacyActive?<p className="text-xs text-amber-900">لهذا الرصيد ترتيب سابق نشط. راجعه وألغِه صراحةً قبل إنشاء ترتيب جديد.</p>:null}
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!allowed||locked||!!editing||!!collecting} onClick={()=>startEdit(target)}>{current?"مراجعة أو تعديل السداد":"ترتيب سداد الدين"}</button>
          {current?.status==="active"?<button type="button" className={button} disabled={!allowed||locked||!!editing||!!collecting||current.collectibleMinor<=0||!current.available}
            onClick={()=>{setCollecting(current);setEditing(null);setTender(current.target.currency);setAmount(formatAmount(Math.min(current.progress?.next?.remainingMinor??current.collectibleMinor,current.collectibleMinor),current.target.currency));setMethod("cash");setNote("");}}>تحصيل دفعة فعلية</button>:null}</div>
      </article>;
    })}
    {editing?<div className="space-y-3 rounded-xl border border-sky-300 bg-sky-50 p-3" aria-label="تعديل ترتيب السداد">
      <p className="text-sm font-bold">{editing.label} — توزيع المتبقي الحالي فقط</p>
      <DebtRepaymentEditor value={draft} onChange={setDraft} currency={editing.target.currency} remainingMinor={editing.remainingMinor} today={clinicDateString(new Date(),CLINIC_ZONE_FALLBACK)} disabled={locked||!allowed}/>
      <label className="block text-sm font-bold">سبب التعديل أو الإلغاء<input aria-label="سبب تعديل السداد" maxLength={300} value={reason} disabled={locked} onChange={event=>setReason(event.target.value)} className="mt-1 min-h-[44px] w-full min-w-0 rounded-xl border px-3"/></label>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={!allowed||locked||!checked?.ok||reason.trim().length<3||editing.legacyActive||editing.remainingMinor>Math.max(0,editing.accountDueMinor)} onClick={()=>saveSchedule()}>حفظ توزيع المتبقي</button>
        {editing.version>0?<button type="button" className={button} disabled={!allowed||locked||reason.trim().length<3} onClick={()=>{if(window.confirm("إلغاء ترتيب المواعيد لا يلغي الدين أو أي سند. هل تريد إلغاء الترتيب؟"))saveSchedule(true);}}>إلغاء ترتيب المواعيد</button>:null}
        <button type="button" className={button} disabled={locked} onClick={()=>setEditing(null)}>إغلاق التعديل</button></div>
    </div>:null}
    {collecting?<fieldset disabled={locked||!allowed} className="min-w-0 space-y-3 rounded-xl border border-emerald-300 bg-emerald-50 p-3" aria-label="تحصيل قسط فعلي">
      <legend className="text-sm font-bold">تحصيل دفعة بسند قبض</legend><p className="text-xs">حدّ التحصيل: {formatMoney(collecting.collectibleMinor,collecting.target.currency)}. يُثبت سعر الصرف المعتمد في السند عند التحصيل.</p>
      <div className="grid min-w-0 gap-2 sm:grid-cols-3"><label className="min-w-0 text-xs font-bold">عملة التحصيل<select aria-label="عملة تحصيل القسط" value={tender} onChange={event=>{setTender(event.target.value as Currency);setAmount("");}} className="mt-1 min-h-[44px] w-full rounded-xl border px-2">{(collecting.target.currency==="YER"?["YER","SAR","USD"]:[collecting.target.currency]).map(currency=><option key={currency}>{currency}</option>)}</select></label>
        <label className="min-w-0 text-xs font-bold">المبلغ<input aria-label="مبلغ تحصيل القسط" value={amount} onChange={event=>setAmount(event.target.value)} inputMode="decimal" dir="ltr" className="mt-1 min-h-[44px] w-full min-w-0 rounded-xl border px-2"/></label>
        <label className="min-w-0 text-xs font-bold">الطريقة<select aria-label="طريقة تحصيل القسط" value={method} onChange={event=>setMethod(event.target.value as "cash"|"transfer")} className="mt-1 min-h-[44px] w-full rounded-xl border px-2"><option value="cash">نقدًا</option><option value="transfer">تحويل</option></select></label></div>
      <label className="block text-xs font-bold">ملاحظة<input aria-label="ملاحظة تحصيل القسط" value={note} onChange={event=>setNote(event.target.value)} maxLength={300} className="mt-1 min-h-[44px] w-full min-w-0 rounded-xl border px-2"/></label>
      <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={collect}>تأكيد التحصيل وإصدار السند</button><button type="button" className={button} onClick={()=>setCollecting(null)}>إغلاق التحصيل</button></div>
    </fieldset>:null}
  </section>;
}
