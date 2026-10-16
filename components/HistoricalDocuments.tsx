"use client";

import {useEffect,useState} from "react";
import {formatMoney} from "@/lib/money";
import {readHistoricalDocuments,type HistoricalDocumentView} from "@/lib/historical-correction-view";
import {useSession} from "./SessionProvider";
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);

export function HistoricalDocuments({patientId,refreshKey,enabled=false,onCorrect}:{patientId:number;refreshKey:unknown;enabled?:boolean;onCorrect?:(document:HistoricalDocumentView)=>void}){
  const session=useSession();
  const [state,setState]=useState<{patientId:number;documents:HistoricalDocumentView[];error:string|null}|null>(null);
  useEffect(()=>{const controller=new AbortController();
    void fetch(`/api/patients/${patientId}/historical-documents`,{cache:"no-store",signal:controller.signal}).then(async response=>{
      const value=await response.json().catch(()=>null);if(controller.signal.aborted)return;
      const documents=response.ok?readHistoricalDocuments(value,patientId):null;
      setState({patientId,documents:documents??[],error:documents?null:record(value)&&typeof value.message==="string"?value.message:"تعذّر قراءة الاتفاقات التاريخية."});
    }).catch(()=>{if(!controller.signal.aborted)setState({patientId,documents:[],error:"تعذّر قراءة الاتفاقات التاريخية."});});
    return()=>controller.abort();
  },[patientId,refreshKey]);
  if(!state||state.patientId!==patientId)return null;
  if(state.error)return <p role="alert" className="my-3 text-sm text-rose-800">{state.error}</p>;
  if(!state.documents.length)return null;
  return <section aria-label="الاتفاقات التاريخية متعددة البنود" data-testid="historical-documents" className="my-4 min-w-0 space-y-3">
    <h3 className="text-base font-extrabold">الاتفاقات التاريخية متعددة البنود</h3>
    {state.documents.map(document=><article key={document.id} className="min-w-0 rounded-2xl border border-violet-200 bg-white p-3 sm:p-4" data-testid={`historical-document-${document.id}`}>
      <h4 className="font-bold">اتفاق #{document.id} · النسخة الحالية {document.version} · {document.currency}</h4>
      <p className="mt-2 text-sm leading-7">المتفق عليه {formatMoney(document.agreedMinor,document.currency)} · المدفوع قبل النظام {formatMoney(document.previouslyPaidMinor,document.currency)} · المتبقي التاريخي {formatMoney(document.remainingMinor,document.currency)}</p>
      <p className="text-xs leading-7">كامل الرصيد السابق المتبقي الآن: {formatMoney(document.openingRemainingMinor,document.currency)} · المستحق الفعلي للحساب الآن: {formatMoney(document.accountDueMinor,document.currency)}</p>
      <p className="text-xs text-slate-500">يشمل رصيد العملة الاتفاقات الأخرى وتسوياتها. المدفوع القديم لا يمثّل سند قبض داخل النظام.</p>
      <ul className="mt-3 space-y-2 text-xs">{document.lines.map(line=><li key={line.agreementId} className="rounded-lg bg-slate-50 p-2 leading-6">
        {line.description} {line.toothCode?`· سن ${line.toothCode}`:line.site.scope?`· ${line.site.scope==="both"?"الفكان":line.site.scope==="upper"?"الفك العلوي":line.site.scope==="lower"?"الفك السفلي":line.site.scope}`:""}
        {` · ${formatMoney(line.unitPriceMinor,document.currency)} − خصم ${formatMoney(line.discountMinor,document.currency)} = ${formatMoney(line.netMinor,document.currency)}`}
        <span className="block text-slate-500">خطة #{line.planId} · بند #{line.planItemId}{line.caseId?` · حالة #${line.caseId}`:""}</span>
      </li>)}</ul>
      {session?.role==="admin"&&onCorrect?<div className="mt-3"><button type="button" disabled={!enabled||!document.correctionAvailable} onClick={()=>onCorrect(document)} className="min-h-11 rounded-xl border border-violet-300 px-4 text-sm font-bold disabled:opacity-50">تصحيح الاتفاق التاريخي</button>
        {!document.correctionAvailable?<p className="mt-2 text-xs text-amber-900">{document.correctionMessage}</p>:null}</div>:null}
      <details className="mt-3 text-xs"><summary className="min-h-11 cursor-pointer py-3 font-bold">سجل النسخ والتصحيح</summary>
        <ol className="space-y-2">{document.history.map(version=><li key={version.version}>النسخة {version.version} · {version.reason} · {version.created_by}</li>)}</ol>
      </details>
    </article>)}
  </section>;
}
