"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CURRENCY_LABEL, formatMoney, parseAmount, toInputAmount, type Currency } from "@/lib/money";
import { invoiceCurrencyReadiness } from "@/lib/invoice-currency-readiness";
import { clinicDateString } from "@/lib/schedule";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { newIdempotencyKey } from "@/lib/idempotency-key";
import { readInvoiceCommandResponse } from "@/lib/invoice-command-transport";
import { durableInvoiceRevision, readInvoiceRevisionReceipt, readInvoiceRevisionView, revisionRecord,
  type InvoiceRevisionCommand, type InvoiceRevisionView } from "@/lib/invoice-revision-view";
import type { FinancialRecoveryControl } from "@/lib/financial-command-journal";
import { DebtRepaymentEditor, readDebtRepaymentDraft, type DebtRepaymentDraft } from "./DebtRepaymentEditor";
import {lineLinkage,validateLineSite,caseSiteScope} from "@/lib/invoice-clinical-linkage";
import { useSession } from "./SessionProvider";

type Draft={keep:boolean;quantity:string;price:string;serviceId:string;doctorId:string;tooth:string;surfaces:string};
// Match the exact server refusal, never a generic conflict or an unknown outcome.
const settlementConflict="توجد تسويات أخرى على الحساب؛ راجع تخصيص السندات قبل جدولة تحصيل إضافي.";
const settlementConflictExplanation="رُفض هذا الطلب قبل حفظ التصحيح: المتبقي المخصص لهذه الفاتورة بعد التصحيح أكبر من المستحق على حساب المريض ككل بالعملة نفسها. تسويات الحساب ليست بالضرورة مخصصة لهذه الفاتورة. راجع تخصيص السندات؛ لا تُنقل الإيصالات القديمة تلقائيًا. هذا الرفض يخص هذا الطلب ولا يحسم نتيجة أي طلب سابق.";
const button="min-h-11 rounded-xl border px-4 py-2 text-sm font-bold disabled:opacity-50";
const input="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm";
export function InvoiceCorrection({patientId,invoiceId,recovery,onRecoveryChange,financialRecovery,onDone,onCancel}:{
  patientId:number;invoiceId:number;recovery:InvoiceRevisionCommand|null;onRecoveryChange:(command:InvoiceRevisionCommand|null)=>void;
  financialRecovery:FinancialRecoveryControl;onDone:(message:string)=>void;onCancel:()=>void;
}){
  const session=useSession();
  const [currency,setCurrency]=useState<Currency>("YER");
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
      setView(next);setCurrency(next.invoice.baseCurrency);setError(null);setDiscount(toInputAmount(next.invoice.discountMinor,next.invoice.baseCurrency));
      setDrafts(Object.fromEntries(next.invoice.items.map(item=>[item.id,{keep:true,quantity:String(item.quantity),price:toInputAmount(item.unitPriceMinor,next.invoice.baseCurrency),serviceId:String(item.serviceId??""),doctorId:String(item.doctorId??""),tooth:String(item.toothCode??""),surfaces:item.surfaces??""}])));
      // Existing terms can include already settled rows. Require deliberate redistribution when their sum differs.
      setTerms({mode:next.repaymentTerms.mode,rows:next.repaymentTerms.installments.map((row,index)=>({key:String(index),dueDate:row.dueDate,kind:row.kind,amount:toInputAmount(row.amountMinor,next.invoice.baseCurrency)}))});
    }catch(problem){if(lifetime.current.active&&generation===lifetime.current.generation){setView(null);setError(problem instanceof Error?problem.message:"تعذّر قراءة الفاتورة.");}}
  },[invoiceId,patientId]);
  useEffect(()=>{if(!initialRecovery.current)void load();},[load]); // Restored original intent does not depend on a fresh mutable snapshot.
  const changingCurrency=!!view&&currency!==view.invoice.baseCurrency;
  const settledMinor=changingCurrency?view?.currencyCorrection?.settledMinor??0:view?.settledMinor??0;
  const preview=useMemo(()=>{
    if(!view)return null;const lines=[];let total=0;
    for(const item of view.invoice.items){const draft=drafts[item.id];if(!draft?.keep)continue;
      const quantity=Number(draft.quantity),unitPriceMinor=parseAmount(draft.price,currency);
      if(!Number.isSafeInteger(quantity)||quantity<1||unitPriceMinor===null)return null;
      const totalMinor=quantity*unitPriceMinor;total+=totalMinor;if(!Number.isSafeInteger(total))return null;
      const serviceId=draft.serviceId?Number(draft.serviceId):null,doctorId=draft.doctorId?Number(draft.doctorId):null;
      const service=view.identityCatalog?.services.find(row=>row.id===serviceId);
      const category=service?.category??view.work.find(row=>row.id===item.planItemId)?.category??null;
      const toothCode=draft.tooth?Number(draft.tooth):null,surfaces=draft.surfaces||null;
      const changed=serviceId!==item.serviceId||doctorId!==item.doctorId||toothCode!==(item.toothCode??null)||surfaces!==(item.surfaces??null);
      const caseSite=view.work.find(row=>row.id===item.planItemId)?.case_site;
      const scope=caseSiteScope(caseSite);
      const site=changed?validateLineSite({category,toothCode,surfaces,...(scope?{scope}:{})}):null;
      if(site&&!site.ok)return null;
      lines.push({...item,quantity,unitPriceMinor,totalMinor,serviceId,doctorId,description:serviceId!==item.serviceId?service?.name??item.description:item.description,
        toothCode:site?.ok?site.site.toothCode:item.toothCode,surfaces:site?.ok?site.site.surfaces:item.surfaces});}
    const discountMinor=parseAmount(discount,currency);if(!lines.length||discountMinor===null||discountMinor>total)return null;
    const after=total-discountMinor,remaining=Math.max(0,after-settledMinor);
    return {lines,total,discountMinor,after,remaining,credit:Math.max(0,settledMinor-after),before:view.invoice.totalMinor-view.invoice.discountMinor};
  },[view,drafts,discount,currency,settledMinor]);
  const allowed=financialRecovery.ready&&session?.role==="admin";
  const currencyOptions=invoiceCurrencyReadiness({sourceCurrency:view?.invoice.baseCurrency,
    preview:recovery?"recovery":view?"ready":error?"unavailable":"loading",correction:view?.currencyCorrection});
  const checked=preview?readDebtRepaymentDraft(terms,currency,preview.remaining):null;
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
        onRecoveryChange({...command,outcome:refused?"refused":"uncertain",message:refused?(response.status===409&&payload.code==="conflict"&&payload.message===settlementConflict?settlementConflictExplanation:String(payload.message)):"لم يكتمل تأكيد النتيجة. احتُفظ بالمبالغ والمفتاح لإعادة الطلب نفسه."});}
    }catch{if(lifetime.current.active)onRecoveryChange({...command,outcome:"uncertain",message:"انقطع الرد. أعد نفس طلب التصحيح للتحقق قبل إجراء أي تعديل آخر."});}
    finally{pending.current=false;if(lifetime.current.active)setBusy(false);}
  };
  const submit=()=>{
    if(!view||!preview||!checked?.ok||recovery||!allowed||pending.current||!currencyOptions.some(option=>option.currency===currency&&option.selectable)||reason.trim().length<3||preview.discountMinor>0&&discountReason.trim().length<3)return;
    const key=newIdempotencyKey();draftRevision.current=financialRecovery.revision;
    const body={...(changingCurrency?{currency}:{}),idempotencyKey:key,expectedSourceHash:view.sourceHash,reason:reason.trim(),lines:preview.lines.map(item=>({itemId:item.id,quantity:item.quantity,unitPrice:toInputAmount(item.unitPriceMinor,currency),serviceId:item.serviceId,doctorId:item.doctorId,toothCode:item.toothCode??null,surfaces:item.surfaces??null})),
      discount:toInputAmount(preview.discountMinor,currency),discountReason:discountReason.trim()||null,repaymentTerms:checked.value,expectedRemainingMinor:preview.remaining};
    void send({key,actor:session.username,patientId,invoiceId,body:JSON.stringify(body),expected:{...(changingCurrency?{currency}:{}),original:view.invoice,lines:preview.lines,discountMinor:preview.discountMinor,settledMinor,accountDueMinor:changingCurrency?view.currencyCorrection!.accountDueMinor:view.accountDueMinor,terms:checked.value},outcome:"pending",message:""});
  };
  const clearRefused=async()=>{if(!recovery||recovery.outcome!=="refused"||busy)return;try{await financialRecovery.acknowledge(durableInvoiceRevision(recovery));if(lifetime.current.active){onRecoveryChange(null);setReason("");await load();}}catch{setError("تعذّر إغلاق الطلب المرفوض بأمان؛ أعد المحاولة.");}};
  const changeCurrency=(next:Currency)=>{
    if(!view||busy||pending.current||recovery||!allowed||!currencyOptions.some(option=>option.currency===next&&option.selectable))return;
    if(next!==view.invoice.baseCurrency&&view.invoice.items.some(item=>{
      const draft=drafts[item.id];
      return !draft?.keep||Number(draft.quantity)!==item.quantity
        ||draft.serviceId!==String(item.serviceId??"")||draft.doctorId!==String(item.doctorId??"")
        ||draft.tooth!==String(item.toothCode??"")||draft.surfaces!==(item.surfaces??"");
    })){
      setError("لتصحيح العملة، أعد البنود المحذوفة والكمية وهوية العلاج إلى قيمها الأصلية أولًا. بقيت تعديلاتك محفوظة دون تغيير.");
      return;
    }
    setError(null);setCurrency(next);setTerms({mode:"full",rows:[]});
  };
  const locked=busy||!!recovery||!allowed;
  const invoice=view?.invoice??recovery?.expected.original;
  return <section aria-label="تصحيح الفاتورة" data-testid="invoice-correction-editor" dir="rtl" className="my-4 min-w-0 space-y-4 rounded-2xl border border-amber-300 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-extrabold">تصحيح الفاتورة {invoice?.invoiceNumber}</h3>
      <button className={button} type="button" disabled={busy||!!recovery} onClick={onCancel}>إغلاق التصحيح</button></div>
    <p className="text-sm leading-7 text-slate-600">راجع المبلغ والأقساط قبل التأكيد. تُحفظ الفاتورة الأصلية وسبب التصحيح، وتبقى إيصالات القبض السابقة مرتبطة بها وتُحتسب للمصححة.</p>
    {error?<p role="alert" className="text-sm text-rose-800">{error}</p>:null}
    <div aria-label="إتاحة تصحيح العملات" aria-live="polite" className="min-w-0 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
      <p className="font-bold">خيارات العملات في النسخة الحالية</p>
      {session?.role!=="admin"?<p>تأكيد التصحيح يحتاج جلسة مدير سارية.</p>:!financialRecovery.ready?<p>الحفظ الآمن للطلب غير جاهز؛ انتظر اكتماله أو استعادة الطلب السابق قبل بدء تصحيح جديد.</p>:null}
      {recovery?<p>يوجد طلب تصحيح محفوظ؛ احسم نتيجته بإعادة نفس الطلب قبل اختيار عملة أو مبلغ جديد.</p>:null}
      <ul className="space-y-2">{currencyOptions.map(option=><li key={option.currency} data-currency={option.currency} data-readiness={option.status} className="min-w-0 break-words leading-7">
        <strong>{CURRENCY_LABEL[option.currency]} ({option.currency}): </strong>{option.message}
      </li>)}</ul>
      <p>تغيير العملة ليس تحويلًا بسعر صرف: يبقى الرقم المكتوب ويُقرأ بالعملة المختارة. راجع السعر والخصم والأقساط قبل التأكيد؛ لا تُنشأ حركة نقدية جديدة.</p>
    </div>
    {!view&&!recovery?<button className={button} type="button" onClick={()=>void load()}>إعادة قراءة الفاتورة</button>:null}
    {recovery?<div role="status" data-testid="invoice-revision-recovery" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3">
      <p>{busy?"جارٍ حفظ التصحيح…":recovery.message}</p>
      <button type="button" className={button} disabled={busy||!allowed} onClick={()=>void send(recovery)}>إعادة نفس طلب التصحيح</button>
      {recovery.outcome==="refused"?<button type="button" className={button} disabled={busy} onClick={()=>void clearRefused()}>مراجعة التصحيح بعد الرفض</button>:null}
    </div>:null}
    {view?<><fieldset disabled={locked} className="space-y-3">
      <label className="block text-sm font-bold">عملة الفاتورة المصححة<select aria-label="عملة الفاتورة المصححة" className={input} value={currency} onChange={event=>changeCurrency(event.target.value as Currency)}>
        {currencyOptions.map(option=><option key={option.currency} value={option.currency} disabled={!option.selectable}>{CURRENCY_LABEL[option.currency]} ({option.currency}){option.selectable?"":" — غير متاح"}</option>)}
      </select></label>
      {view.currencyCorrection?<p className="text-sm leading-7">{view.currencyCorrection.message}</p>:null}
      {changingCurrency?<p role="status" className="text-sm leading-7">تسوية مثبتة {formatMoney(settledMinor,currency)}. لا تُنشأ حركة نقدية، وتبقى أرقام السندات ومبالغها وأسعار صرفها الأصلية محفوظة.</p>:null}
      {view.invoice.items.map((item,index)=>{const draft=drafts[item.id];const work=view.work.find(row=>row.id===item.planItemId),clinical=work?.clinical_locked;
        const priceMinor=draft?parseAmount(draft.price,currency):null;
        const unchangedServicePriceEdit=!!draft?.keep&&!changingCurrency&&priceMinor!==null&&priceMinor!==item.unitPriceMinor&&draft.serviceId===String(item.serviceId??"");
        const canAmend=!locked&&!changingCurrency&&view.identityAmendmentAvailable===true&&!clinical&&!!view.identityCatalog;
        const oldCategory=work?.category??view.identityCatalog?.services.find(row=>row.id===item.serviceId)?.category??null;
        const choices=view.identityCatalog?.services.filter(row=>work?row.category===oldCategory:lineLinkage({serviceId:row.id,category:row.category}).kind==="financial")??[];
        const change=(patch:Partial<Draft>)=>setDrafts(current=>({...current,[item.id]:{...current[item.id],...patch}}));
        return <div key={item.id} className="grid min-w-0 gap-3 rounded-xl border p-3 sm:grid-cols-3">
        <div className="text-sm"><strong>{item.description}</strong>{item.toothCode?<span> · سن {item.toothCode}</span>:null}
          <label className="mt-2 flex min-h-11 items-center gap-2"><input type="checkbox" checked={draft?.keep??false} disabled={locked||clinical||changingCurrency} onChange={event=>setDrafts(current=>({...current,[item.id]:{...current[item.id],keep:event.target.checked}}))}/>إبقاء البند</label>
          {clinical?<p className="text-xs leading-6 text-amber-900">له عمل أو مسودة سريرية؛ تبقى هويته وكميته محفوظتين.</p>:null}</div>
        <label className="min-w-0 text-xs font-bold">الكمية<input aria-label={`كمية التصحيح ${index+1}`} className={input} inputMode="numeric" disabled={locked||clinical||changingCurrency} value={draft?.quantity??""} onChange={event=>setDrafts(current=>({...current,[item.id]:{...current[item.id],quantity:event.target.value}}))}/></label>
        <label className="min-w-0 text-xs font-bold">السعر ({currency})<input aria-label={`سعر التصحيح ${index+1}`} className={input} inputMode="decimal" dir="ltr" value={draft?.price??""} onChange={event=>setDrafts(current=>({...current,[item.id]:{...current[item.id],price:event.target.value}}))}/></label>
        {unchangedServicePriceEdit?<p role="status" data-testid="invoice-unchanged-service-warning" className="text-sm leading-7 text-amber-900 sm:col-span-3">الخدمة ستبقى «{item.description}». تغيير السعر أو كتابة سبب التصحيح لا يغيّر نوع الخدمة، مثل تحويلها إلى زركون. إذا كان المقصود خدمة أخرى، راجع اختيار الخدمة وشروط إتاحة تصحيح هويتها.</p>:null}
        <details className="min-w-0 text-xs sm:col-span-3"><summary className="min-h-11 cursor-pointer py-3 font-bold">تصحيح الخدمة والطبيب والموضع</summary>
          <p className="mb-2 leading-6">تُقبل قبل بدء العمل فقط. التحصيل أو المسودة السريرية أو العمولة المعتمدة يحفظ الهوية الأصلية؛ التصحيح المالي يبقى متاحًا.</p>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <label>الخدمة<select aria-label={`خدمة التصحيح ${index+1}`} className={input} value={draft?.serviceId??""} disabled={!canAmend} onChange={event=>change({serviceId:event.target.value})}>
              {!choices.some(row=>String(row.id)===draft?.serviceId)?<option value={draft?.serviceId??""}>{item.description}</option>:null}
              {choices.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}
            </select></label>
            <label>الطبيب المعالج<select aria-label={`طبيب التصحيح ${index+1}`} className={input} value={draft?.doctorId??""} disabled={!canAmend} onChange={event=>change({doctorId:event.target.value})}>
              <option value="">دون طبيب</option>{view.identityCatalog?.doctors.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}
            </select></label>
            {item.toothCode?<><label>السن<input aria-label={`سن التصحيح ${index+1}`} className={input} inputMode="numeric" value={draft?.tooth??""} disabled={!canAmend} onChange={event=>change({tooth:event.target.value})}/></label>
              <label>الأسطح (MODBL)<input aria-label={`أسطح التصحيح ${index+1}`} className={input} value={draft?.surfaces??""} disabled={!canAmend} onChange={event=>change({surfaces:event.target.value})}/></label></>:null}
          </div>
        </details>
      </div>;})}
      <div className="grid gap-3 sm:grid-cols-2"><label className="text-xs font-bold">الخصم<input aria-label="خصم التصحيح" className={input} value={discount} onChange={event=>setDiscount(event.target.value)} inputMode="decimal"/></label>
        <label className="text-xs font-bold">سبب الخصم<input aria-label="سبب خصم التصحيح" className={input} value={discountReason} maxLength={300} onChange={event=>setDiscountReason(event.target.value)}/></label></div>
      <label className="block text-xs font-bold">سبب التصحيح المطلوب<textarea aria-label="سبب التصحيح" className={input} value={reason} maxLength={300} onChange={event=>setReason(event.target.value)}/></label>
    </fieldset>
    {preview?<><div aria-live="polite" className="grid gap-2 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2"><p>قبل التصحيح: {formatMoney(preview.before,view.invoice.baseCurrency)}</p><p>بعد التصحيح: <strong>{formatMoney(preview.after,currency)}</strong></p>
      <p>المحصّل المثبت: {formatMoney(settledMinor,currency)}</p><p>المتبقي للتحصيل: <strong>{formatMoney(preview.remaining,currency)}</strong></p>
      {preview.credit>0?<p className="font-bold text-sky-900">رصيد لصالح المريض {formatMoney(preview.credit,currency)}. صرفه يحتاج إجراء ردّ مستقل.</p>:null}</div>
      <DebtRepaymentEditor value={terms} onChange={setTerms} currency={currency} remainingMinor={preview.remaining} today={clinicDateString(new Date(),CLINIC_ZONE_FALLBACK)} disabled={locked}/></>:null}
    <button type="button" className={button+" bg-navy-800 text-white"} disabled={locked||!currencyOptions.some(option=>option.currency===currency&&option.selectable)||!preview||!checked?.ok||reason.trim().length<3||preview.discountMinor>0&&discountReason.trim().length<3} onClick={submit}>تأكيد تصحيح الفاتورة</button>
    </>:null}
  </section>;
}
