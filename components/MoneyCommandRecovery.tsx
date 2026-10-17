"use client";
import {useState} from "react";
import type {DurableMoneyCommand} from "@/lib/durable-money-command";
import {useMoneyAttempt} from "./useMoneyAttempt";
import {MoneyAttemptNotice} from "./MoneyAttemptNotice";
export function MoneyCommandRecovery({command,onDone}:{command:DurableMoneyCommand;onDone:(message:string,paymentId:number|null)=>void}){
  const money=useMoneyAttempt(command.owner,true,command.owner,{patientId:command.patientId,receipt:command.receipt??undefined});
  const [feedback,setFeedback]=useState<string|null>(null);
  const retry=async()=>{setFeedback(null);const result=await money.run();if(result?.kind==="confirmed"){
    money.consume(result.attempt);onDone(command.attempt.request.operation==="payment"?"تأكد حفظ سند القبض السابق بالمبلغ والهدف الأصليين.":"تأكد تصحيح السند السابق بالمفتاح الأصلي.",result.acknowledgment.paymentId);
  }else if(!result){setFeedback("لم تبدأ الاستعادة أو تغيّرت الجلسة. افتح الحساب بالجلسة الأصلية؛ لم يُحذف الطلب المحفوظ.");}
  else if(result.kind==="busy"){setFeedback("توجد محاولة قيد الانتظار أو لم يكتمل تحميل الطلب المحفوظ. انتظر ظهور نتيجتها.");}
  else {setFeedback(result.message);}};
  return <section aria-label="استعادة العملية المالية" data-testid="money-command-recovery" className="my-4 rounded-2xl border border-amber-300 bg-white p-4">
    <h3 className="mb-2 font-extrabold">استعادة العملية المالية السابقة</h3>
    <p className="mb-2 text-sm">تصحيح الفاتورة وتسجيل عمليات جديدة متوقفان حتى تأكيد نتيجة الطلب السابق. إعادة التحقق ترسل الطلب المالي المحفوظ نفسه بمفتاحه الأصلي، وقد تنفّذه إذا لم يُنفّذ سابقًا. لا تستخدمها لتنفيذ مبلغ أو هدف غير صحيح؛ راجع المسؤول المالي عند الشك.</p>
    <MoneyAttemptNotice attempt={money.attempt} onRetry={()=>void retry()}/>
    {feedback?<p role="alert" className="whitespace-pre-line text-sm text-rose-800">{feedback}</p>:null}
    {money.error?<p role="alert" className="text-sm text-rose-800">{money.error}</p>:null}
  </section>;
}
