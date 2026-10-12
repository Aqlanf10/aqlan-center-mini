"use client";

import {useEffect,useState} from "react";
import {formatMoney,isCurrency} from "@/lib/money";
import type {HistoricalDocumentReceipt} from "@/lib/legacy-treatment-document";

type DocumentView=HistoricalDocumentReceipt&{openingRemainingMinor:number;accountDueMinor:number;scheduleVersion:number;sourceHash:string;history:{version:number;reason:string;created_by:string}[]};
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const minor=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const id=(value:unknown):value is number=>minor(value)&&value>0;
function readDocuments(value:unknown,patientId:number):DocumentView[]|null {
  if(!record(value)||!Array.isArray(value.documents))return null;
  for(const document of value.documents){
    if(!record(document)||!id(document.id)||!id(document.version)||!id(document.revisionId)||document.patientId!==patientId||!isCurrency(document.currency)
      ||![document.totalMinor,document.discountMinor,document.agreedMinor,document.previouslyPaidMinor,document.remainingMinor,document.openingRemainingMinor,document.scheduleVersion].every(minor)
      ||typeof document.accountDueMinor!=="number"||!Number.isSafeInteger(document.accountDueMinor)||typeof document.sourceHash!=="string"||!/^[a-f0-9]{64}$/.test(document.sourceHash)
      ||Number(document.agreedMinor)!==Number(document.totalMinor)-Number(document.discountMinor)||Number(document.remainingMinor)!==Number(document.agreedMinor)-Number(document.previouslyPaidMinor)
      ||typeof document.historicalAsOf!=="string"||typeof document.createdBy!=="string"||typeof document.reason!=="string"||!Array.isArray(document.lines)||!document.lines.length
      ||!document.lines.every(line=>record(line)&&id(line.agreementId)&&id(line.planItemId)&&id(line.planId)&&id(line.serviceId)&&(line.caseId===null||id(line.caseId))
        &&typeof line.description==="string"&&minor(line.unitPriceMinor)&&minor(line.discountMinor)&&minor(line.netMinor)&&line.netMinor===line.unitPriceMinor-line.discountMinor&&record(line.site))
      ||document.lines.reduce((sum,line)=>sum+Number(line.unitPriceMinor),0)!==document.totalMinor||document.lines.reduce((sum,line)=>sum+Number(line.discountMinor),0)!==document.discountMinor
      ||!Array.isArray(document.history)||document.history.length!==document.version||!document.history.every((row,index)=>record(row)&&row.version===index+1&&typeof row.reason==="string"&&typeof row.created_by==="string"))return null;
  }
  return value.documents as DocumentView[];
}

export function HistoricalDocuments({patientId,refreshKey}:{patientId:number;refreshKey:unknown}){
  const [state,setState]=useState<{patientId:number;documents:DocumentView[];error:string|null}|null>(null);
  useEffect(()=>{const controller=new AbortController();
    void fetch(`/api/patients/${patientId}/historical-documents`,{cache:"no-store",signal:controller.signal}).then(async response=>{
      const value=await response.json().catch(()=>null);if(controller.signal.aborted)return;
      const documents=response.ok?readDocuments(value,patientId):null;
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
      <details className="mt-3 text-xs"><summary className="min-h-11 cursor-pointer py-3 font-bold">سجل النسخ والتصحيح</summary>
        <ol className="space-y-2">{document.history.map(version=><li key={version.version}>النسخة {version.version} · {version.reason} · {version.created_by}</li>)}</ol>
      </details>
    </article>)}
  </section>;
}
