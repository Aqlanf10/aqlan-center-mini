"use client";

import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useSyncExternalStore} from "react";
import {acknowledgeFinancialCommand,readFinancialJournal,reserveFinancialCommand,FinancialRecoveryError,type FinancialCommand} from "@/lib/financial-command-journal";
import {durableMoneyCommand,restoreMoneyCommand,readDurableMoneyAcknowledgment,type DurableMoneyCommand,type MoneyReceiptContext} from "@/lib/durable-money-command";
import {MONEY_UNCERTAIN,RECONCILABLE_OPERATIONS,moneyHeaders,moneyRecoveryFailure,retireMoneyAttempt,similarReview,type MoneyAttempt,type MoneyRequest} from "@/lib/money-attempt";
import type {SimilarCollectionReview} from "@/lib/similar-collection";
import {newIdempotencyKey} from "@/lib/idempotency-key";
import {readInvoiceCommandResponse} from "@/lib/invoice-command-transport";
import {useSession} from "./SessionProvider";

export const MONEY_JOURNAL_EVENT="aqlan-money-journal-updated";
export interface MoneyDurableContext {patientId:number;receipt?:MoneyReceiptContext}
type State={ready:boolean;revision:number;command:DurableMoneyCommand|null;other:FinancialCommand|null;error:string|null};
const empty:State={ready:false,revision:0,command:null,other:null,error:null};
const states=new Map<string,State>(),listeners=new Set<()=>void>();
const subscribe=(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};};
const publish=(scope:string,state:State)=>{states.set(scope,state);listeners.forEach(listener=>listener());};
const announce=()=>window.dispatchEvent(new Event(MONEY_JOURNAL_EVENT));
function adopt(scope:string,command:FinancialCommand|null,revision:number,patientId:number,actor:string){
  const old=states.get(scope);
  // A read started before reservation must not erase the synchronous write lock.
  // A second tab's acknowledgement also cannot substitute for our own receipt validation.
  if(!command&&old?.command){publish(scope,{...old,ready:true,revision,error:null});return;}
  const money=command&&(command.kind==="collection"||command.kind==="receipt-correction")?restoreMoneyCommand(command,patientId,actor):null;
  const same=money&&old?.command&&durableMoneyCommand(money).original===durableMoneyCommand(old.command).original;
  publish(scope,{ready:true,revision,command:same?old.command:money,other:command&&!money?command:null,error:null});
}
export function useDurableMoneyAttempt(owner:string,context:MoneyDurableContext|null,visible:boolean,viewKey=owner){
  const enabled=context!==null;
  const session=useSession(),actor=session?.username??"",patientId=context?.patientId??0,scope=JSON.stringify([actor,patientId]);
  const snapshot=useCallback(()=>states.get(scope)??empty,[scope]);
  const state=useSyncExternalStore(subscribe,snapshot,()=>empty);
  const lifetime=useRef<object|null>(null),token=useMemo(()=>({scope,visible,owner,session,viewKey}),[scope,visible,owner,session,viewKey]);
  useLayoutEffect(()=>{lifetime.current=visible?token:null;return()=>{lifetime.current=null;};},[token,visible]);
  useEffect(()=>{
    if(!enabled||!actor||!visible)return;let active=true;
    const read=async()=>{try{const saved=await readFinancialJournal({actor,patientId});if(active)adopt(scope,saved.command,saved.revision,patientId,actor);}catch{if(active)publish(scope,{...empty,error:new FinancialRecoveryError("unavailable").message});}};
    void read();window.addEventListener(MONEY_JOURNAL_EVENT,read);
    return()=>{active=false;window.removeEventListener(MONEY_JOURNAL_EVENT,read);};
  },[scope,actor,patientId,visible,enabled]);
  const own=state.command?.owner===owner?state.command:null;
  useEffect(()=>{if(!enabled||!own)return;const block=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};window.addEventListener("beforeunload",block);return()=>window.removeEventListener("beforeunload",block);},[enabled,own]);
  const blocked=state.other||state.command&&!own;
  const run=async(request?:MoneyRequest,review?:SimilarCollectionReview)=>{
    if(!context||!actor||lifetime.current!==token)return null;
    const current=states.get(scope)??empty;
    if(!current.ready||current.error||current.other||current.command&&current.command.owner!==owner)return {kind:"blocked" as const,message:current.error??"يوجد طلب مالي سابق لهذا المريض. استعده من الحساب قبل تسجيل عملية جديدة."};
    const previous=current.command;
    if(previous?.attempt.phase==="sending")return {kind:"busy" as const};
    if(previous&&request&&(request.url!==previous.attempt.request.url||request.body!==previous.attempt.request.body||request.operation!==previous.attempt.request.operation))return {kind:"blocked" as const,message:MONEY_UNCERTAIN};
    if(previous?.attempt.phase==="confirmed"&&previous.attempt.acknowledgment)return {kind:"confirmed" as const,attempt:previous.attempt,acknowledgment:previous.attempt.acknowledgment};
    if(!previous&&!request)return {kind:"busy" as const};
    const command:DurableMoneyCommand=previous?{...previous,attempt:{request:previous.attempt.request,key:previous.attempt.key,phase:"sending"}}:{actor,patientId,owner,receipt:context.receipt??null,attempt:{request:request!,key:newIdempotencyKey("money"),phase:"sending"}};
    publish(scope,{...current,command});
    const durable=durableMoneyCommand(command);
    let reserved=false;
    let failure=MONEY_UNCERTAIN;
    try {
      const saved=await reserveFinancialCommand({actor,patientId},current.revision,durable);
      if(saved.command?.key!==durable.key||saved.command.original!==durable.original){adopt(scope,saved.command,saved.revision,patientId,actor);return {kind:"blocked" as const,message:"تغيّر الطلب المالي في شاشة أخرى. راجع الطلب المحفوظ في الحساب."};}
      reserved=true;
      announce();
      // An unmounted or replaced principal may persist recovery, but cannot start a fresh write.
      if(lifetime.current!==token){publish(scope,{...current,command:{...command,attempt:{...command.attempt,phase:"uncertain"}}});return null;}
      const {response,payload}=await readInvoiceCommandResponse(signal=>fetch(command.attempt.request.url,{method:"POST",headers:moneyHeaders(command.attempt.key,review),body:command.attempt.request.body,signal}));
      const acknowledgment=response.ok&&!response.redirected?readDurableMoneyAcknowledgment(payload,command):null;
      if(acknowledgment){const completed=await acknowledgeFinancialCommand({actor,patientId},durable);
        const confirmed={...command.attempt,phase:"confirmed" as const,acknowledgment};publish(scope,{...current,revision:completed.revision,command:{...command,attempt:confirmed}});announce();
        return lifetime.current===token?{kind:"confirmed" as const,attempt:confirmed,acknowledgment}:null;}
      // Advisory review: nothing was written for this send. Keep the same key/body for confirmation.
      const similar=response.redirected?null:similarReview(previous?.attempt??null,response.status,payload);
      if(similar){publish(scope,{...current,command:{...command,attempt:{...command.attempt,phase:"review",similar}}});
        return lifetime.current===token?{kind:"similar" as const,receipts:similar.receipts}:null;}
      const message=payload&&typeof payload==="object"&&"message" in payload?payload.message:null;
      if(!response.redirected)failure=moneyRecoveryFailure(response.status,message);
      if(!previous&&!response.redirected&&[400,404,422].includes(response.status)&&typeof message==="string"&&message.trim()){
        const retired=await acknowledgeFinancialCommand({actor,patientId},durable);publish(scope,{...current,revision:retired.revision,command:null});announce();return lifetime.current===token?{kind:"refused" as const,message}:null;}
      // An ordinary 409 refusal of a first send is retired only on server proof (0068) that the key
      // never committed and never can; otherwise it stays uncertain below.
      // Issue the extra mutation, and alter the journal, only while the sending principal's view is current.
      if(!previous&&!response.redirected&&response.status===409&&RECONCILABLE_OPERATIONS.has(command.attempt.request.operation)&&typeof message==="string"&&message.trim()
        &&lifetime.current===token&&await retireMoneyAttempt(fetch,command.attempt.request,command.attempt.key,command.actor)==="retired"&&lifetime.current===token){
        const retired=await acknowledgeFinancialCommand({actor,patientId},durable);publish(scope,{...current,revision:retired.revision,command:null});announce();return lifetime.current===token?{kind:"refused" as const,message}:null;}
    }catch{
      if(!reserved){
        try{const saved=await readFinancialJournal({actor,patientId});adopt(scope,saved.command,saved.revision,patientId,actor);
          if(!saved.command)publish(scope,{ready:true,revision:saved.revision,command:null,other:null,error:null});
        }catch{publish(scope,{...empty,error:new FinancialRecoveryError("unavailable").message});}
        return {kind:"blocked" as const,message:"لم يبدأ الإرسال؛ تعذّر تثبيت الطلب المحفوظ. راجع حالة الحساب قبل المحاولة."};
      }
      // Once reserved, any ambiguous failure retains the original intent.
    }
    publish(scope,{...current,command:{...command,attempt:{...command.attempt,phase:"uncertain"}}});
    return lifetime.current===token?{kind:"uncertain" as const,message:failure}:null;
  };
  /** Operator cancelled a similar-receipt review: retire only when no send of this key can still land. */
  const dismiss=async():Promise<"retired"|"kept"|null>=>{
    const current=states.get(scope);const command=current?.command;
    if(!current||!command||command.owner!==owner||command.attempt.phase!=="review")return null;
    if(command.attempt.similar?.proven){
      try{const retired=await acknowledgeFinancialCommand({actor,patientId},durableMoneyCommand(command));publish(scope,{...current,revision:retired.revision,command:null});announce();return "retired";}
      catch{/* journal unavailable: keep the command, never drop it silently */}
    }
    publish(scope,{...current,command:{...command,attempt:{request:command.attempt.request,key:command.attempt.key,phase:"uncertain"}}});
    return "kept";
  };
  /** Prove an uncertain collection's outcome: retire only on server proof, replay if it committed. */
  const reconcile=async()=>{
    const current=states.get(scope);const command=current?.command;
    if(!context||!actor||lifetime.current!==token||!current||!command||command.owner!==owner||command.attempt.phase!=="uncertain"
      ||!RECONCILABLE_OPERATIONS.has(command.attempt.request.operation))return null;
    publish(scope,{...current,command:{...command,attempt:{...command.attempt,phase:"sending"}}});
    const state=await retireMoneyAttempt(fetch,command.attempt.request,command.attempt.key,command.actor);
    publish(scope,{...current,command});
    // A replaced or closed principal keeps the saved attempt; its owner proves it again later.
    if(lifetime.current!==token)return null;
    if(state==="retired"){
      try{const retired=await acknowledgeFinancialCommand({actor,patientId},durableMoneyCommand(command));publish(scope,{...current,revision:retired.revision,command:null});announce();}
      catch{return {kind:"uncertain" as const,message:"ثبت أن المحاولة لم تُحفظ، لكن تعذّر تحديث الطلب المحفوظ في هذا الجهاز؛ أعد المحاولة."};}
      return lifetime.current===token?{kind:"retired" as const}:null;
    }
    if(state==="committed")return run();
    return {kind:"uncertain" as const,message:MONEY_UNCERTAIN};
  };
  const consume=(attempt:MoneyAttempt)=>{const current=states.get(scope);if(current?.command?.attempt===attempt&&attempt.phase==="confirmed"){publish(scope,{...current,command:null});announce();}};
  return {attempt:own?.attempt??null,run,reconcile,consume,dismiss,ready:state.ready&&!blocked&&!state.error,error:state.error??(blocked?"يوجد طلب مالي سابق لهذا المريض. استعده من الحساب قبل تسجيل عملية جديدة.":null)};
}
