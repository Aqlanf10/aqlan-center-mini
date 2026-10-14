"use client";
import type {DurableMoneyCommand} from "@/lib/durable-money-command";
import {useMoneyAttempt} from "./useMoneyAttempt";
import {MoneyAttemptNotice} from "./MoneyAttemptNotice";
export function MoneyCommandRecovery({command,onDone}:{command:DurableMoneyCommand;onDone:(message:string,paymentId:number|null)=>void}){
  const money=useMoneyAttempt(command.owner,true,command.owner,{patientId:command.patientId,receipt:command.receipt??undefined});
  const retry=async()=>{const result=await money.run();if(result?.kind==="confirmed"){
    money.consume(result.attempt);onDone(command.attempt.request.operation==="payment"?"تأكد حفظ سند القبض السابق بالمبلغ والهدف الأصليين.":"تأكد تصحيح السند السابق بالمفتاح الأصلي.",result.acknowledgment.paymentId);
  }};
  return <section aria-label="استعادة العملية المالية" data-testid="money-command-recovery" className="my-4 rounded-2xl border border-amber-300 bg-white p-4">
    <h3 className="mb-2 font-extrabold">استعادة العملية المالية السابقة</h3>
    <MoneyAttemptNotice attempt={money.attempt} onRetry={()=>void retry()}/>
    {money.error?<p role="alert" className="text-sm text-rose-800">{money.error}</p>:null}
  </section>;
}
