"use client";

import {useCallback,useEffect,useRef,useState} from "react";
import {newIdempotencyKey} from "@/lib/idempotency-key";
import {formatMoney} from "@/lib/money";
import {maintenanceRecord,readInvoiceArchiveView} from "@/lib/invoice-maintenance-view";
import type {InvoiceArchiveView} from "@/lib/invoice-archive";
import {InvoiceMaintenanceRecovery,maintenanceButton,maintenanceInput,useInvoiceMaintenance,type InvoiceMaintenanceProps} from "./useInvoiceMaintenance";

export function InvoiceArchive(props:InvoiceMaintenanceProps) {
  const {patientId,invoiceId,recovery,onCancel}=props;
  const command=useInvoiceMaintenance(props);
  const [view,setView]=useState<InvoiceArchiveView|null>(null),[reason,setReason]=useState("");
  const [loadError,setLoadError]=useState<string|null>(null),[loading,setLoading]=useState(false);
  const generation=useRef({value:0});
  const load=useCallback(async()=>{
    const owner=++generation.current.value;setLoading(true);
    try {
      const response=await fetch(`/api/invoices/${invoiceId}/archive`,{cache:"no-store"}),body:unknown=await response.json();
      if(generation.current.value!==owner)return;
      const next=response.ok?readInvoiceArchiveView(body,patientId,invoiceId):null;
      if(!next)throw new Error(maintenanceRecord(body)&&typeof body.message==="string"?body.message:"تعذّر قراءة حالة الأرشفة.");
      setView(next);setLoadError(null);
    }catch(error){if(generation.current.value===owner){setView(null);setLoadError(error instanceof Error?error.message:"تعذّر قراءة حالة الأرشفة.");}}
    finally{if(generation.current.value===owner)setLoading(false);}
  },[patientId,invoiceId]);
  useEffect(()=>{const owner=generation.current;void load();return()=>{owner.value++;};},[load,command.retired]);
  const locked=command.busy||!!recovery||!command.allowed||!!command.result;
  const action=view?.archived?"restore":"archive";
  const available=view?.readiness==="ready"&&(view.archived?view.eligibility.code!=="period_locked":view.eligibility.canArchive);
  const save=()=>{
    if(!view||!available||locked||reason.trim().length<3||loading)return;
    const key=newIdempotencyKey();
    const body={action,reason:reason.trim(),idempotencyKey:key,expectedVersion:view.version};
    void command.send({operation:"archive",key,actor:command.actor,patientId,invoiceId,body:JSON.stringify(body),
      expected:{kind:"archive",currency:view.currency,invoiceNumber:view.invoiceNumber,action,expectedVersion:view.version,reason:body.reason},outcome:"pending",message:""});
  };
  return <section dir="rtl" aria-label="أرشفة الفاتورة واسترجاعها" className="my-4 min-w-0 space-y-4 rounded-2xl border border-slate-300 bg-white p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-extrabold">أرشفة الفاتورة {view?.invoiceNumber??recovery?.expected.invoiceNumber}</h3>
      <button type="button" className={maintenanceButton} disabled={command.busy||!!recovery} onClick={onCancel}>إغلاق</button></div>
    <p className="text-sm leading-7">الأرشفة تنظيم إداري قابل للاسترجاع. تبقى الفاتورة وسنداتها في الحساب والكشف، ولا تسقط دينًا ولا تلغي علاجًا.</p>
    {loadError||command.error?<p role="alert">{loadError??command.error}</p>:null}
    {loading?<p role="status">جارٍ قراءة حالة الفاتورة…</p>:null}
    {view?<div className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm">{view.readiness==="ready"?<p>الحالة الإدارية: <strong>{view.archived?"مؤرشفة":"ضمن السجل الجاري"}</strong> · النسخة {view.version}</p>:<p role="status">حالة الأرشفة غير متاحة إلى أن تُعتمد الهجرة المقترحة؛ لا يمكن تأكيد وجود أرشفة أو غيابها.</p>}
      {view.eligibility.remainingMinor!==null?<p>متبقي الفاتورة: {formatMoney(view.eligibility.remainingMinor,view.currency)}</p>:null}
      {view.eligibility.message?<p role="status">{view.eligibility.message}</p>:null}
      {view.latest?<p>آخر إجراء: {view.latest.action==="archive"?"أرشفة":"استرجاع"} · {view.latest.actor} · {view.latest.at}<br/>السبب: {view.latest.reason}</p>:null}
    </div>:null}
    <InvoiceMaintenanceRecovery recovery={recovery} busy={command.busy} allowed={command.allowed} onRetry={()=>{if(recovery)void command.send(recovery);}}/>
    {command.result?<div role="status" className="space-y-2 rounded-xl bg-emerald-50 p-3"><p>تم التحقق. الحالة الحالية للفاتورة {command.result.invoiceNumber}: {command.result.archived?"مؤرشفة":"مسترجعة إلى السجل الجاري"}، النسخة {command.result.version}.</p>
      <a className="font-bold underline" href={`/print/invoice/${invoiceId}`} target="_blank" rel="noopener">طباعة الفاتورة الأصلية</a></div>
      :view?<><label className="block text-sm font-bold">سبب {action==="archive"?"الأرشفة":"الاسترجاع"}<textarea aria-label="سبب إجراء الأرشفة" className={maintenanceInput+" py-2"} disabled={locked||!available} maxLength={300} value={reason} onChange={event=>setReason(event.target.value)}/></label>
        <button type="button" className={maintenanceButton} disabled={locked||!available||loading||reason.trim().length<3} onClick={save}>{action==="archive"?"تأكيد الأرشفة":"استرجاع الفاتورة"}</button></>:null}
    {!recovery&&!command.result?<button type="button" className={maintenanceButton} disabled={loading||command.busy} onClick={()=>void load()}>تحديث حالة الأرشفة</button>:null}
  </section>;
}

/** Documentary list only: never feeds balance, receipt or statement calculations. */
export function InvoiceArchiveList({patientId,refreshKey,canManage,onOpen}:{patientId:number;refreshKey:unknown;canManage:boolean;onOpen:(invoiceId:number)=>void}) {
  const [state,setState]=useState<{ready:boolean;rows:InvoiceArchiveView[];error:string|null}>({ready:false,rows:[],error:null});
  useEffect(()=>{
    let active=true;
    void fetch(`/api/invoices/archive?patientId=${patientId}`,{cache:"no-store"}).then(async response=>{
      const body:unknown=await response.json();if(!active)return;
      if(!response.ok||!maintenanceRecord(body)||!Array.isArray(body.invoices)||!["ready","migration_pending"].includes(String(body.readiness)))throw new Error("تعذّر تحميل الأرشيف.");
      const rows=body.invoices.map(row=>readInvoiceArchiveView(row,patientId));
      if(rows.some(row=>row===null))throw new Error("تعذّر التحقق من بيانات الأرشيف.");
      setState({ready:body.readiness==="ready",rows:(rows as InvoiceArchiveView[]).filter(row=>row.archived),error:null});
    }).catch(error=>{if(active)setState({ready:false,rows:[],error:error instanceof Error?error.message:"تعذّر تحميل الأرشيف."});});
    return()=>{active=false;};
  },[patientId,refreshKey]);
  return <details className="my-4 rounded-2xl border border-slate-200 bg-white p-4" aria-label="أرشيف الفواتير">
    <summary className="min-h-11 cursor-pointer py-2 font-bold">أرشيف الفواتير{state.ready?` (${state.rows.length})`:""}</summary>
    <p className="mb-3 text-sm leading-7">الفواتير المؤرشفة تبقى ضمن إجمالي الحساب وكشف المريض وقائمة الفواتير الكاملة أعلاه.</p>
    {state.error?<p role="alert">{state.error}</p>:!state.ready?<p role="status">الأرشفة بانتظار اعتماد الهجرة المقترحة أو اكتمال قراءة حالتها.</p>:!state.rows.length?<p>لا فواتير مؤرشفة.</p>:<ul className="space-y-3">{state.rows.map(row=><li key={row.invoiceId} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-slate-50 p-3">
      <div><strong>{row.invoiceNumber}</strong><p className="text-sm">{row.latest?.reason} · {row.latest?.actor}</p></div><div className="flex flex-wrap gap-2">
        <a className={maintenanceButton} href={`/print/invoice/${row.invoiceId}`} target="_blank" rel="noopener">طباعة</a>
        {canManage?<button type="button" className={maintenanceButton} onClick={()=>onOpen(row.invoiceId)}>عرض الأرشفة والاسترجاع</button>:null}</div>
    </li>)}</ul>}
  </details>;
}
