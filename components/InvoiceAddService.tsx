"use client";

import {useCallback,useEffect,useRef,useState} from "react";
import {newIdempotencyKey} from "@/lib/idempotency-key";
import {formatMoney,isCurrency,parseAmount,toInputAmount,type Currency} from "@/lib/money";
import {invoiceCatalogPrice,type InvoiceCatalogService} from "@/lib/invoice-catalog-price";
import {allowedScopes,INVOICE_LINKAGE_MESSAGE,SITE_SCOPE_LABEL,toothRequired,toothScope,type InvoiceLinkageRefusal} from "@/lib/invoice-clinical-linkage";
import {maintenanceRecord} from "@/lib/invoice-maintenance-view";
import {readInvoiceCommandResponse} from "@/lib/invoice-command-transport";
import {InvoiceMaintenanceRecovery,maintenanceButton,maintenanceInput,useInvoiceMaintenance,type InvoiceMaintenanceProps} from "./useInvoiceMaintenance";

type Service=InvoiceCatalogService&{id:number;name:string;category:string|null};
type Original={id:number;invoiceNumber:string;createdAt:string;patientId:number;currency:Currency;netMinor:number;settledMinor:number;remainingMinor:number};
type Context={original:Original;sourceHash:string;services:Service[];doctors:{id:number;name:string}[];planChoices:{id:number;compatible:boolean}[];sourceVisitIds:number[]};
type Clinical={kind:"clinical"|"financial";item:{mode:"existing"|"new";id:number|null}|null;case:{mode:string;id:number|null;title:string|null;options:{id:number;title:string}[]}|null;refusal:InvoiceLinkageRefusal|null;effectiveDoctorId:number|null;effectiveDoctorName:string|null;effectivePlanId:number|null};
type Preview={body:string;requestHash:string;currency:Currency;addedNetMinor:number;accountDueBeforeMinor:number;accountDueAfterMinor:number;clinical:Clinical[]};
type Draft={serviceId:string;doctorId:string;price:string;priceReason:string;discount:string;discountReason:string;reason:string;existingPlanId:string;caseId:string;toothCode:string;surfaces:string;scope:string};
const initial:Draft={serviceId:"",doctorId:"",price:"",priceReason:"",discount:"0",discountReason:"",reason:"",existingPlanId:"",caseId:"",toothCode:"",surfaces:"",scope:""};
const integer=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v);
const id=(v:unknown):v is number=>integer(v)&&v>0;
const hash=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const ids=(v:unknown):v is number[]=>Array.isArray(v)&&v.every(id);
function readContext(value:unknown,patientId:number,invoiceId:number):Context|null {
  if(!maintenanceRecord(value)||!maintenanceRecord(value.original)||value.original.patientId!==patientId||value.original.id!==invoiceId
    ||typeof value.original.invoiceNumber!=="string"||typeof value.original.createdAt!=="string"||!Number.isFinite(Date.parse(value.original.createdAt))
    ||!isCurrency(value.original.currency)||![value.original.netMinor,value.original.settledMinor,value.original.remainingMinor].every(integer)||!hash(value.sourceHash)
    ||!Array.isArray(value.services)||!value.services.every(s=>maintenanceRecord(s)&&id(s.id)&&typeof s.name==="string"&&(s.category===null||typeof s.category==="string")&&integer(s.priceMinor))
    ||!Array.isArray(value.doctors)||!value.doctors.every(d=>maintenanceRecord(d)&&id(d.id)&&typeof d.name==="string")
    ||!Array.isArray(value.planChoices)||!value.planChoices.every(p=>maintenanceRecord(p)&&id(p.id)&&typeof p.compatible==="boolean")||!ids(value.sourceVisitIds))return null;
  return value as unknown as Context;
}
function readPreview(value:unknown,body:string,context:Context):Preview|null {
  const source=JSON.parse(body) as Record<string,unknown>,price=parseAmount(String(source.price),context.original.currency),discount=parseAmount(String(source.discount),context.original.currency);
  if(price===null||discount===null||!maintenanceRecord(value)||!hash(value.requestHash)||value.sourceHash!==context.sourceHash||!isCurrency(value.currency)||value.currency!==context.original.currency
    ||!maintenanceRecord(value.original)||value.original.id!==context.original.id||value.original.patientId!==context.original.patientId||value.status!=="planned"
    ||!ids(value.sourceVisitIds)||JSON.stringify(value.sourceVisitIds)!==JSON.stringify(context.sourceVisitIds)
    ||!id(value.addedNetMinor)||value.addedNetMinor!==price-discount||!integer(value.accountDueBeforeMinor)||!integer(value.accountDueAfterMinor)
    ||value.accountDueAfterMinor!==value.accountDueBeforeMinor+value.addedNetMinor||!Array.isArray(value.clinical)||value.clinical.length!==1
    ||!value.clinical.every(row=>maintenanceRecord(row)&&["financial","clinical"].includes(String(row.kind))
      &&(row.effectiveDoctorId===null||id(row.effectiveDoctorId))&&(row.effectiveDoctorName===null||typeof row.effectiveDoctorName==="string")
      &&(row.effectivePlanId===null||id(row.effectivePlanId))
      &&(row.refusal===null||typeof row.refusal==="string"&&Object.hasOwn(INVOICE_LINKAGE_MESSAGE,row.refusal))
      &&(row.item===null||maintenanceRecord(row.item)&&["existing","new"].includes(String(row.item.mode))&&(row.item.id===null||id(row.item.id)))
      &&(row.case===null||maintenanceRecord(row.case)&&typeof row.case.mode==="string"&&Array.isArray(row.case.options)&&row.case.options.every(option=>maintenanceRecord(option)&&id(option.id)&&typeof option.title==="string"))))return null;
  return {body,requestHash:value.requestHash,currency:value.currency,addedNetMinor:value.addedNetMinor,accountDueBeforeMinor:value.accountDueBeforeMinor,
    accountDueAfterMinor:value.accountDueAfterMinor,clinical:value.clinical as Clinical[]};
}

export function InvoiceAddService(props:InvoiceMaintenanceProps) {
  const {patientId,invoiceId,recovery,onCancel}=props,command=useInvoiceMaintenance(props);
  const [context,setContext]=useState<Context|null>(null),[draft,setDraft]=useState<Draft>(initial),[preview,setPreview]=useState<Preview|null>(null);
  const [loading,setLoading]=useState(false),[previewing,setPreviewing]=useState(false),[error,setError]=useState<string|null>(null);
  const [caseOptions,setCaseOptions]=useState<{id:number;title:string}[]>([]);
  const generation=useRef({value:0}),draftGeneration=useRef(0),previewPending=useRef(false),firstRecovery=useRef(recovery);
  const load=useCallback(async()=>{
    const owner=++generation.current.value;setLoading(true);setPreview(null);
    try{
      const response=await fetch(`/api/invoices/${invoiceId}/add-service`,{cache:"no-store"}),body:unknown=await response.json();
      if(generation.current.value!==owner)return;
      const next=response.ok?readContext(body,patientId,invoiceId):null;
      if(!next)throw new Error(maintenanceRecord(body)&&typeof body.message==="string"?body.message:"تعذّر قراءة بيانات إضافة الخدمة.");
      setContext(next);setError(null);
    }catch(problem){if(generation.current.value===owner){setContext(null);setError(problem instanceof Error?problem.message:"تعذّر قراءة بيانات إضافة الخدمة.");}}
    finally{if(generation.current.value===owner)setLoading(false);}
  },[patientId,invoiceId]);
  useEffect(()=>{const owner=generation.current;if(!firstRecovery.current||command.retired>0)void load();return()=>{owner.value++;};},[load,command.retired]);
  const service=context?.services.find(row=>String(row.id)===draft.serviceId),mode=toothScope(service?.category??null);
  const locked=command.busy||!!recovery||!command.allowed||!!command.result;
  const edit=(patch:Partial<Draft>)=>{if(locked)return;draftGeneration.current++;setDraft(current=>({...current,...patch}));setPreview(null);setError(null);};
  const requestPreview=async()=>{
    if(!context||locked||!service||draft.reason.trim().length<3||previewPending.current)return;
    previewPending.current=true;setPreviewing(true);setError(null);setPreview(null);
    const generationAtStart=generation.current.value,draftAtStart=draftGeneration.current;
    const source={idempotencyKey:newIdempotencyKey(),expectedSourceHash:context.sourceHash,serviceId:service.id,doctorId:draft.doctorId?Number(draft.doctorId):null,
      price:draft.price.trim(),priceReason:draft.priceReason.trim()||null,discount:draft.discount.trim(),discountReason:draft.discountReason.trim()||null,
      currency:context.original.currency,reason:draft.reason.trim(),existingPlanId:draft.existingPlanId?Number(draft.existingPlanId):null,
      caseId:draft.caseId?Number(draft.caseId):null,toothCode:draft.toothCode?Number(draft.toothCode):null,surfaces:draft.surfaces.trim()||null,scope:draft.scope||null};
    const body=JSON.stringify(source);
    try{
      const {response,payload}=await readInvoiceCommandResponse(signal=>fetch(`/api/invoices/${invoiceId}/add-service`,{method:"PUT",headers:{"Content-Type":"application/json"},body,signal}));
      if(generation.current.value!==generationAtStart||draftGeneration.current!==draftAtStart)return;
      const next=response.ok&&!response.redirected?readPreview(payload,body,context):null;
      if(!next)throw new Error(maintenanceRecord(payload)&&typeof payload.message==="string"?payload.message:"تعذّر التحقق من معاينة الإضافة.");
      setPreview(next);setCaseOptions(next.clinical.flatMap(row=>row.case?.options??[]));
    }catch(problem){if(generation.current.value===generationAtStart&&draftGeneration.current===draftAtStart)setError(problem instanceof Error?problem.message:"تعذّرت المعاينة.");}
    finally{previewPending.current=false;if(generation.current.value===generationAtStart)setPreviewing(false);}
  };
  const save=()=>{
    if(!context||!preview||locked||preview.clinical.some(row=>row.refusal!==null))return;
    const key=(JSON.parse(preview.body) as {idempotencyKey:string}).idempotencyKey;
    void command.send({operation:"add-service",key,actor:command.actor,patientId,invoiceId,body:preview.body,
      expected:{kind:"add-service",currency:preview.currency,invoiceNumber:context.original.invoiceNumber,addedNetMinor:preview.addedNetMinor,
        requestHash:preview.requestHash,sourceVisitIds:context.sourceVisitIds},outcome:"pending",message:""});
  };
  return <section dir="rtl" aria-label="إضافة خدمة إلى فاتورة قائمة" className="my-4 min-w-0 space-y-4 rounded-2xl border border-sky-300 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-extrabold">إضافة خدمة إلى {context?.original.invoiceNumber??recovery?.expected.invoiceNumber}</h3>
      <button type="button" className={maintenanceButton} disabled={command.busy||!!recovery} onClick={onCancel}>إغلاق</button></div>
    <p className="text-sm leading-7">تصدر الخدمة في فاتورة إضافية بتاريخ اليوم ورقم جديد مرتبط بالأصل. تبقى بنود الأصل وسنداته وتوقيعاته محفوظة، وتبدأ الخدمة الجديدة بحالة «مخططة».</p>
    {error||command.error?<p role="alert">{error??command.error}</p>:null}
    {loading?<p role="status">جارٍ قراءة الفاتورة ودليل الخدمات…</p>:null}
    <InvoiceMaintenanceRecovery recovery={recovery} busy={command.busy} allowed={command.allowed} onRetry={()=>{if(recovery)void command.send(recovery);}}/>
    {command.result?<div role="status" className="space-y-3 rounded-xl bg-emerald-50 p-3" data-testid="invoice-add-service-success"><p>صدرت الفاتورة الإضافية <strong>{command.result.invoiceNumber}</strong> بتاريخ <time dateTime={command.result.createdAt}>{command.result.createdAt}</time>. لم يُغيّر تاريخ الأصل.</p>
      <div className="flex flex-wrap gap-4"><a className="font-bold underline" href={`/print/invoice/${command.result.invoiceId}`} target="_blank" rel="noopener">طباعة الفاتورة الإضافية</a><a className="font-bold underline" href={`/print/invoice/${invoiceId}`} target="_blank" rel="noopener">عرض أصل الفاتورة</a></div></div>:null}
    {context&&!command.result?<><div className="rounded-xl bg-slate-50 p-3 text-sm leading-7"><p>الأصل: {context.original.invoiceNumber} · {context.original.createdAt}</p><p>قيمة الأصل: {formatMoney(context.original.netMinor,context.original.currency)} · محصّل: {formatMoney(context.original.settledMinor,context.original.currency)} · متبقٍ: {formatMoney(context.original.remainingMinor,context.original.currency)}</p>
      <p>العملة: {context.original.currency} · مصدر الزيارة: {context.sourceVisitIds.length?context.sourceVisitIds.map(id=>`#${id}`).join("، "):"لا زيارة مرتبطة بالأصل"}. يُحفظ كمرجع دون تغيير رابط الزيارة.</p></div>
      <fieldset disabled={locked||loading} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-bold">الخدمة<select aria-label="الخدمة الإضافية" className={maintenanceInput} value={draft.serviceId} onChange={event=>{
          const selected=context.services.find(row=>String(row.id)===event.target.value),catalog=selected?invoiceCatalogPrice(selected,context.original.currency):null;
          setCaseOptions([]);edit({serviceId:event.target.value,price:catalog===null?"":toInputAmount(catalog,context.original.currency),priceReason:"",caseId:"",toothCode:"",surfaces:"",scope:""});
        }}><option value="">اختر الخدمة</option>{context.services.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        <label className="text-sm font-bold">الطبيب<select aria-label="طبيب الخدمة الإضافية" className={maintenanceInput} value={draft.doctorId} onChange={event=>edit({doctorId:event.target.value})}><option value="">الطبيب الحالي للبند إن كان قائمًا</option>{context.doctors.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
        {toothRequired(mode)||mode==="region"?<label className="text-sm font-bold">السن<input aria-label="سن الخدمة الإضافية" className={maintenanceInput} value={draft.toothCode} inputMode="numeric" onChange={event=>edit({toothCode:event.target.value,scope:""})}/></label>:null}
        {mode==="tooth_surfaces"?<label className="text-sm font-bold">الأسطح (MODBL)<input aria-label="أسطح الخدمة الإضافية" className={maintenanceInput} value={draft.surfaces} maxLength={20} onChange={event=>edit({surfaces:event.target.value})}/></label>:null}
        {allowedScopes(mode).length?<label className="text-sm font-bold">نطاق العلاج<select aria-label="نطاق الخدمة الإضافية" className={maintenanceInput} value={draft.scope} onChange={event=>edit({scope:event.target.value,toothCode:""})}><option value="">اختر النطاق</option>{allowedScopes(mode).map(scope=><option key={scope} value={scope}>{SITE_SCOPE_LABEL[scope]}</option>)}</select></label>:null}
        <label className="text-sm font-bold">السعر ({context.original.currency})<input aria-label="سعر الخدمة الإضافية" className={maintenanceInput} inputMode="decimal" value={draft.price} onChange={event=>edit({price:event.target.value})}/></label>
        <label className="text-sm font-bold">سبب السعر اليدوي أو المعدل<input aria-label="سبب سعر الخدمة الإضافية" className={maintenanceInput} value={draft.priceReason} maxLength={300} onChange={event=>edit({priceReason:event.target.value})}/></label>
        <label className="text-sm font-bold">الخصم ({context.original.currency})<input aria-label="خصم الخدمة الإضافية" className={maintenanceInput} inputMode="decimal" value={draft.discount} onChange={event=>edit({discount:event.target.value})}/></label>
        <label className="text-sm font-bold">سبب الخصم<input aria-label="سبب خصم الخدمة الإضافية" className={maintenanceInput} value={draft.discountReason} maxLength={300} onChange={event=>edit({discountReason:event.target.value})}/></label>
        <label className="text-sm font-bold">ربط الخطة<select aria-label="خطة الخدمة الإضافية" className={maintenanceInput} value={draft.existingPlanId} onChange={event=>edit({existingPlanId:event.target.value})}><option value="">وفق قواعد الربط الحالية</option>{context.planChoices.map(row=><option key={row.id} value={row.id} disabled={!row.compatible}>خطة #{row.id}{row.compatible?"":" — غير متوافقة مع الإضافة"}</option>)}</select></label>
        <label className="text-sm font-bold">الحالة السريرية المرتبطة<select aria-label="حالة الخدمة الإضافية" className={maintenanceInput} value={draft.caseId} onChange={event=>edit({caseId:event.target.value})}><option value="">حسب معاينة الربط</option>{caseOptions.map(row=><option key={row.id} value={row.id}>{row.title} (#{row.id})</option>)}</select></label>
        <p className="text-sm leading-7 sm:col-span-2">الكمية: ١ · حالة التنفيذ الجديدة: مخططة. العمل المنجز والفواتير السابقة لا يعاد إصدارها.</p>
        <label className="text-sm font-bold sm:col-span-2">سبب الإضافة<textarea aria-label="سبب إضافة الخدمة" className={maintenanceInput+" py-2"} value={draft.reason} maxLength={300} onChange={event=>edit({reason:event.target.value})}/></label>
      </fieldset>
      <button type="button" className={maintenanceButton} disabled={locked||previewing||!service||draft.reason.trim().length<3} onClick={()=>void requestPreview()}>{previewing?"جارٍ معاينة الأثر…":"معاينة أثر الإضافة"}</button>
      {preview?<div aria-live="polite" data-testid="invoice-add-service-preview" className="space-y-2 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm leading-7">
        <p>الخدمة: {service?.name} · الطبيب الفعلي: {preview.clinical[0].effectiveDoctorName??"دون تعيين"} · السن/النطاق: {draft.toothCode||draft.scope||"لا ينطبق"} · الأسطح: {draft.surfaces||"لا ينطبق"}</p>
        <p>السعر: {draft.price} {preview.currency} · الخصم: {draft.discount} {preview.currency} · صافي الفاتورة الإضافية: <strong>{formatMoney(preview.addedNetMinor,preview.currency)}</strong></p>
        <p>إجمالي المستحق في الحساب قبل الإضافة: {formatMoney(preview.accountDueBeforeMinor,preview.currency)} · بعد الإضافة: <strong>{formatMoney(preview.accountDueAfterMinor,preview.currency)}</strong></p>
        {preview.clinical.map((row,index)=><div key={index}><p>الخطة: {row.effectivePlanId!==null?`#${row.effectivePlanId}`:row.item?"خطة جديدة وفق قواعد الربط":"خدمة مالية دون خطة"} · بند العلاج: {row.item?.mode==="existing"?`قائم #${row.item.id}`:row.item?"جديد مخطط":"غير مطلوب"} · الحالة: {row.case?.title??(row.case?.mode==="new"?"حالة أولية تحتاج تقييمًا":row.case?.mode==="choose"?"اختر الحالة ثم أعد المعاينة":"غير مطلوبة")}</p>{row.refusal?<p role="alert">{INVOICE_LINKAGE_MESSAGE[row.refusal]}</p>:null}</div>)}
        <p>المستند النهائي فاتورة إضافية مستقلة؛ يظهر رقمها وتاريخها بعد التأكيد. لا حركة نقدية في هذه الخطوة.</p>
        <button type="button" className={maintenanceButton+" bg-navy-800 text-white"} disabled={locked||preview.clinical.some(row=>row.refusal!==null)} onClick={save}>تأكيد إصدار الفاتورة الإضافية</button>
      </div>:null}
    </>:null}
    {!recovery&&!command.result?<button type="button" className={maintenanceButton} disabled={loading||command.busy||previewing} onClick={()=>void load()}>تحديث بيانات الإضافة</button>:null}
  </section>;
}
