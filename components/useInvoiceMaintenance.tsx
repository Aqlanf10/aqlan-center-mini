"use client";

import {useLayoutEffect,useMemo,useRef,useState} from "react";
import type {FinancialRecoveryControl} from "@/lib/financial-command-journal";
import {readInvoiceCommandResponse} from "@/lib/invoice-command-transport";
import {durableInvoiceMaintenance,maintenanceRecord,readInvoiceMaintenanceReceipt,readInvoiceMaintenanceRejection,
  type InvoiceMaintenanceCommand,type InvoiceMaintenanceSuccess} from "@/lib/invoice-maintenance-view";
import {useSession} from "./SessionProvider";

export interface InvoiceMaintenanceProps {
  patientId:number; invoiceId:number; recovery:InvoiceMaintenanceCommand|null;
  onRecoveryChange:(command:InvoiceMaintenanceCommand|null)=>void;
  financialRecovery:FinancialRecoveryControl; onChanged:()=>void; onCancel:()=>void;
}
export const maintenanceButton="min-h-11 rounded-xl border border-slate-300 px-4 py-2 text-sm font-bold disabled:opacity-50";
export const maintenanceInput="mt-1 min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 text-sm";

/** The existing actor/patient journal arbitrates every new action before POST. */
export function useInvoiceMaintenance(props:InvoiceMaintenanceProps) {
  const {patientId,invoiceId,financialRecovery,onRecoveryChange,onChanged}=props;
  const session=useSession();
  const token=useMemo(()=>({patientId,invoiceId,session}),[patientId,invoiceId,session]);
  const lifetime=useRef<object|null>(null),pending=useRef(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const [result,setResult]=useState<InvoiceMaintenanceSuccess|null>(null),[retired,setRetired]=useState(0);
  useLayoutEffect(()=>{lifetime.current=token;return()=>{lifetime.current=null;};},[token]);
  const allowed=financialRecovery.ready&&session?.role==="admin";
  const send=async(command:InvoiceMaintenanceCommand)=>{
    if(!allowed||pending.current||lifetime.current!==token||command.actor!==session.username||command.invoiceId!==invoiceId||command.patientId!==patientId)return;
    pending.current=true;setBusy(true);setError(null);
    onRecoveryChange({...command,outcome:"pending",message:"جارٍ التحقق من حفظ الطلب…"});
    const durable=durableInvoiceMaintenance(command);
    try {
      if(!await financialRecovery.reserve(durable,financialRecovery.revision)||lifetime.current!==token)return;
      const {response,payload}=await readInvoiceCommandResponse(signal=>fetch(`/api/invoices/${invoiceId}/${command.operation}`,{
        method:"POST",headers:{"Content-Type":"application/json"},body:command.body,signal,
      }));
      if(lifetime.current!==token)return;
      const verified=[200,201].includes(response.status)&&!response.redirected?readInvoiceMaintenanceReceipt(payload,command):null;
      const refused=response.status===409&&!response.redirected?readInvoiceMaintenanceRejection(payload,command):null;
      if(verified||refused){
        await financialRecovery.acknowledge(durable);if(lifetime.current!==token)return;
        onRecoveryChange(null);
        if(verified){setResult(verified);onChanged();}
        else {setError(refused);setRetired(value=>value+1);}
      }else {
        const message=maintenanceRecord(payload)&&typeof payload.message==="string"?payload.message:"لم يكتمل تأكيد النتيجة.";
        onRecoveryChange({...command,outcome:"uncertain",message:`${message} احتُفظ بالطلب؛ أعد الطلب نفسه قبل بدء عملية أخرى.`});
      }
    }catch{
      if(lifetime.current===token)onRecoveryChange({...command,outcome:"uncertain",message:"انقطع الرد أو تعذّر حفظ التأكيد. احتُفظ بالطلب والمفتاح للتحقق من النتيجة نفسها."});
    }finally{pending.current=false;if(lifetime.current===token)setBusy(false);}
  };
  return {allowed,actor:session?.username??"",busy,error,setError,result,retired,send};
}
export function InvoiceMaintenanceRecovery({recovery,busy,allowed,onRetry}:{recovery:InvoiceMaintenanceCommand|null;busy:boolean;allowed:boolean;onRetry:()=>void}) {
  return recovery?<div role="status" className="space-y-3 rounded-xl border border-amber-300 bg-amber-50 p-3" data-testid="invoice-maintenance-recovery">
    <p>{busy?"جارٍ حفظ الطلب…":recovery.message}</p>
    <button type="button" className={maintenanceButton} disabled={busy||!allowed} onClick={onRetry}>إعادة نفس الطلب للتحقق</button>
  </div>:null;
}
