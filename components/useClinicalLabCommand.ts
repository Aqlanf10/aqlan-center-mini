"use client";
import {useEffect,useLayoutEffect,useRef,useState} from "react";
import {withClinicalVisitBrowserLock,type ClinicalVisitLockScope} from "@/lib/clinical-visit-browser-lock";
import {acknowledgeClinicalLabReference,clinicalLabBodyReference,readClinicalLabReference,reserveClinicalLabReference,type ClinicalLabJournal,type ClinicalLabReference,type ClinicalLabScope} from "@/lib/clinical-lab-operation-reference";
/** Only references survive reload. Clinical text stays in this mounted owner's memory. */
export function useClinicalLabCommand(parent:object,scope:ClinicalLabScope|null,enabled:boolean,lockScope?:ClinicalVisitLockScope,allowLegacyWithoutLocks=false){
 const key=scope?JSON.stringify(scope):"";
 const [owner,setOwner]=useState({parent,key});
 if(owner.parent!==parent||owner.key!==key)setOwner({parent,key});
 const [readAttempt,setReadAttempt]=useState(0);
 const [state,setState]=useState<{owner:object;key:string;journal:ClinicalLabJournal|null;error:string}>({owner,key,journal:null,error:""});
 const live=useRef<object|null>(owner),liveScope=useRef(key);
 useLayoutEffect(()=>{live.current=owner;liveScope.current=key;return()=>{if(live.current===owner&&liveScope.current===key)live.current=null;};},[owner,key]);
 const admission=useRef<{owner:object;journal:ClinicalLabJournal|null}|null>(null);
 const sealed=useRef<{owner:object;body:string;reference:ClinicalLabReference}|null>(null);
 useEffect(()=>{let active=true;if(!enabled||!scope)return;
  void readClinicalLabReference(scope).then(journal=>{if(active&&live.current===owner&&liveScope.current===key)setState({owner,key,journal,error:""});})
   .catch(()=>{if(active&&live.current===owner&&liveScope.current===key)setState({owner,key,journal:null,error:"تعذّر قراءة مرجع الحفظ؛ الحفظ الجديد متوقف لحماية الطلب السابق."});});
  return()=>{active=false;};
 // Scope serialization is complete; owner identity retires every prior callback.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[owner,key,enabled,readAttempt]);
 const journal=state.owner===owner&&state.key===key?state.journal:null;
 const pending=journal?.pending??null;
 const guard=()=>{if(live.current!==owner||liveScope.current!==key||!scope)throw Error("تغيّر نطاق الزيارة.");};
 const receiptMatches=(raw:unknown,reference:ClinicalLabReference)=>{if(!raw||typeof raw!=="object"||!scope)return false;const row=raw as Record<string,unknown>;return row.requestKey===reference.requestKey&&row.requestHash===reference.requestHash&&row.actor===scope.actor&&row.patientId===scope.patientId&&row.visitId===scope.visitId;};
 function verifyReceipt(raw:unknown,reference:ClinicalLabReference){guard();if(!receiptMatches(raw,reference))throw Error("تعذّر إثبات نتيجة حفظ المختبر؛ تحقق من الطلب قبل أي تعديل.");}
 async function acknowledge(raw:unknown,reference:ClinicalLabReference){verifyReceipt(raw,reference);
  const next=await acknowledgeClinicalLabReference(scope!,reference);guard();setState({owner,key,journal:next,error:""});sealed.current=null;
 }
 async function prepare(body:Record<string,unknown>){guard();const fresh=admission.current;const journal=fresh?.owner===owner?fresh.journal:null;if(!journal)throw Error("لم يكتمل التحقق الحصري من مرجع الحفظ.");
  const pending=journal.pending;
  if(pending){const previous=sealed.current;if(previous?.owner!==owner||previous.reference.requestKey!==pending.requestKey||previous.reference.requestHash!==pending.requestHash)throw Error("نتيجة حفظ سابق غير مؤكدة وجسم الطلب غير متاح بعد إعادة التحميل؛ تحقق من النتيجة. لا يمكن إنشاء طلب بديل.");return previous;}
  if(sealed.current?.owner===owner)throw Error("حُسم مرجع الطلب في نافذة أخرى؛ حدّث السجل قبل إنشاء طلب جديد.");
  const requestKey=crypto.randomUUID(),encoded=JSON.stringify({...body,labPatientId:scope!.patientId,labRequestKey:requestKey});
  const reference=await clinicalLabBodyReference(requestKey,encoded);guard();
  const next=await reserveClinicalLabReference(scope!,journal.revision,reference);guard();setState({owner,key,journal:next,error:""});
  if(next.pending?.requestKey!==reference.requestKey||next.pending.requestHash!==reference.requestHash)throw Error("توجد عملية أخرى لهذه الزيارة؛ تحقق منها قبل الحفظ.");
  const value={owner,body:encoded,reference};sealed.current=value;return value;
 }
 async function withMutationLock<T>(kind:"ordinary"|"lab"|"reconcile",run:()=>Promise<T>):Promise<T>{
  const identity=lockScope??scope;if(!identity)throw Error("تعذّر إثبات نطاق قفل الزيارة.");
  return withClinicalVisitBrowserLock(identity,async()=>{
   if(live.current!==owner||liveScope.current!==key)throw Error("تغيّر نطاق الزيارة.");
   const fresh=scope?await readClinicalLabReference(scope):null;
   if(live.current!==owner||liveScope.current!==key)throw Error("تغيّر نطاق الزيارة.");
   if(fresh)setState({owner,key,journal:fresh,error:""});
   if(kind==="ordinary"&&fresh?.pending)throw Error("توجد عملية مختبر معلّقة من نافذة أخرى؛ تحقق منها قبل تعديل الزيارة أو توقيعها.");
   admission.current={owner,journal:fresh};
   try{return await run();}finally{if(admission.current?.owner===owner)admission.current=null;}
  },kind==="ordinary"&&(scope===null||allowLegacyWithoutLocks));
 }
 async function reconcile(){guard();const pending=admission.current?.owner===owner?admission.current.journal?.pending:null;if(!pending)return false;
  const response=await fetch(`/api/visits/${scope!.visitId}/lab-work-command?key=${encodeURIComponent(pending.requestKey)}&hash=${pending.requestHash}`,{cache:"no-store"});const body=await response.json();guard();
  if(!response.ok||body.found!==true)throw Error("لم تثبت نتيجة الطلب السابق بعد. أعد المحاولة الأصلية من هذه الجلسة إن كانت متاحة؛ بعد فقد جسم الطلب تبقى الكتابة متوقفة ولا تُنشأ هوية بديلة.");
  verifyReceipt(body.receipt,pending);
  if(body.result?.outcome!==undefined&&body.result.outcome!=="applied"&&body.result.outcome!=="rejected")throw Error("نتيجة الطلب غير معروفة؛ بقي مرجع الحفظ محفوظًا.");
  return {reference:pending,receipt:body.receipt,outcome:body.result?.outcome==="rejected"?"rejected" as const:"applied" as const};
 }
 return {prepare,withMutationLock,verifyReceipt,acknowledge,reconcile,retryReference:()=>{guard();setReadAttempt(value=>value+1);},pending,blocked:enabled&&(!journal||!!pending),error:state.owner===owner&&state.key===key?state.error:"",canRetry:!!pending&&sealed.current?.owner===owner};
}
