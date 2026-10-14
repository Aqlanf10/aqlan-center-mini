"use client";
import { useRef,useState } from "react";
interface Pending {operationKey:string;command:string;body:Record<string,unknown>}
/** Uncertain completion retains the exact payload/key and locks editing. Retry is
 * explicit and reuses server idempotency; it never starts a replacement command.
 */
export function useInventoryCommand(){
 const pending=useRef<Pending|null>(null);const inFlight=useRef(false);const uncertain=useRef(false);
 const [status,setStatus]=useState<"idle"|"submitting"|"uncertain">("idle");const [message,setMessage]=useState("");
 async function post(input:Pending):Promise<Record<string,unknown>|null>{
  if(inFlight.current)return null;inFlight.current=true;setStatus("submitting");setMessage("");
  try{
   const response=await fetch("/api/inventory/procurement",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({command:input.command,operationKey:input.operationKey,...input.body})});
   const result=await response.json() as Record<string,unknown>;
   if(!response.ok){
    if(response.status>=500&&result.code!=="schema_not_ready")throw new Error("uncertain_result");
    pending.current=null;uncertain.current=false;setStatus("idle");setMessage(typeof result.message==="string"?result.message:"لم تُقبل العملية. راجع المدخلات والصلاحية.");return null;
   }
   pending.current=null;uncertain.current=false;setStatus("idle");return result;
  }catch{
   pending.current=input;uncertain.current=true;setStatus("uncertain");setMessage("تعذّر تأكيد النتيجة. أعد تأكيد العملية نفسها؛ تبقى المدخلات محفوظة حتى تتأكد النتيجة.");return null;
  }finally{inFlight.current=false;}
 }
 async function send(command:string,body:Record<string,unknown>){
  if(uncertain.current||inFlight.current)return null;
  const input={command,body,operationKey:crypto.randomUUID()};pending.current=input;return post(input);
 }
 return {status,message,locked:status!=="idle",busy:status==="submitting",send,retry:()=>pending.current?post(pending.current):Promise.resolve(null)};
}
