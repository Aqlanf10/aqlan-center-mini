/** Minimal browser reconciliation evidence only. Never persist clinical bodies,
 * notes, specifications, session tokens, or source tuples. Server remains authority. */
export interface ClinicalLabScope {actor:string;patientId:number;visitId:number}
export interface ClinicalLabReference {requestKey:string;requestHash:string}
export interface ClinicalLabJournal {revision:number;pending:ClinicalLabReference|null;acknowledged?:ClinicalLabReference}
type Stored=ClinicalLabJournal&{scope:string};
const DATABASE="aqlan-clinical-lab-operation-references",STORE="references";
export class ClinicalLabReferenceError extends Error {
 constructor(){super("تعذّر التحقق من مرجع حفظ المختبر. لم يُرسل طلب جديد؛ لا تمسح بيانات المتصفح وأعد التحقق.");}
}
const same=(a:ClinicalLabReference|null|undefined,b:ClinicalLabReference)=>a?.requestKey===b.requestKey&&a.requestHash===b.requestHash;
export function validClinicalLabReference(value:unknown):value is ClinicalLabReference {
 if(!value||typeof value!=="object"||Array.isArray(value))return false;
 const row=value as Record<string,unknown>;
 return Object.keys(row).length===2&&typeof row.requestKey==="string"&&/^[A-Za-z0-9._:-]{8,128}$/.test(row.requestKey)
  &&typeof row.requestHash==="string"&&/^[a-f0-9]{64}$/.test(row.requestHash);
}
function scopeKey(scope:ClinicalLabScope):string{
 if(!scope.actor||scope.actor.length>200||!Number.isSafeInteger(scope.patientId)||scope.patientId<=0||!Number.isSafeInteger(scope.visitId)||scope.visitId<=0)throw new ClinicalLabReferenceError();
 return JSON.stringify([scope.actor,scope.patientId,scope.visitId]);
}
export async function clinicalLabBodyReference(requestKey:string,sealedBody:string):Promise<ClinicalLabReference>{
 const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(sealedBody));
 const reference={requestKey,requestHash:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("")};
 if(!validClinicalLabReference(reference))throw new ClinicalLabReferenceError();return reference;
}
export function reserveClinicalLabReferenceState(current:ClinicalLabJournal,expectedRevision:number,reference:ClinicalLabReference):ClinicalLabJournal{
 if(!validClinicalLabReference(reference)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)throw new ClinicalLabReferenceError();
 if(current.pending){if(current.pending.requestKey===reference.requestKey&&!same(current.pending,reference))throw new ClinicalLabReferenceError();return current;}
 if(same(current.acknowledged,reference))return current;
 if(current.revision!==expectedRevision)throw new ClinicalLabReferenceError();
 return {...current,pending:reference};
}
export function acknowledgeClinicalLabReferenceState(current:ClinicalLabJournal,reference:ClinicalLabReference):ClinicalLabJournal{
 if(!validClinicalLabReference(reference))throw new ClinicalLabReferenceError();
 if(!current.pending&&same(current.acknowledged,reference))return current;
 if(!same(current.pending,reference))throw new ClinicalLabReferenceError();
 return {revision:current.revision+1,pending:null,acknowledged:reference};
}
async function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
 if(typeof indexedDB==="undefined"){reject(new ClinicalLabReferenceError());return;}
 let request:IDBOpenDBRequest;try{request=indexedDB.open(DATABASE,1);}catch{reject(new ClinicalLabReferenceError());return;}
 let abandoned=false;const timeout=setTimeout(()=>{abandoned=true;reject(new ClinicalLabReferenceError());},5000);
 request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:"scope"});
 request.onerror=request.onblocked=()=>{abandoned=true;clearTimeout(timeout);reject(new ClinicalLabReferenceError());};
 request.onsuccess=()=>{clearTimeout(timeout);if(abandoned){request.result.close();return;}request.result.onversionchange=()=>request.result.close();resolve(request.result);};
});}
async function transaction(scope:ClinicalLabScope,change?:(current:ClinicalLabJournal)=>ClinicalLabJournal):Promise<ClinicalLabJournal>{
 const key=scopeKey(scope),db=await database();
 try{return await new Promise((resolve,reject)=>{
  const tx=db.transaction(STORE,change?"readwrite":"readonly",change?{durability:"strict"}:undefined),store=tx.objectStore(STORE);
  let result:ClinicalLabJournal,failure:unknown;const request=store.get(key);
  request.onsuccess=()=>{try{
   const raw=request.result as Stored|undefined;
   if(raw&&(raw.scope!==key||!Number.isSafeInteger(raw.revision)||raw.revision<0||(raw.pending!==null&&!validClinicalLabReference(raw.pending))||(raw.acknowledged!==undefined&&!validClinicalLabReference(raw.acknowledged))))throw new ClinicalLabReferenceError();
   const current=raw??{revision:0,pending:null};result=change?change(current):current;
   if(change)store.put({scope:key,revision:result.revision,pending:result.pending,...(result.acknowledged?{acknowledged:result.acknowledged}:{})});
  }catch(error){failure=error;tx.abort();}};
  tx.oncomplete=()=>resolve(result);tx.onerror=()=>{};tx.onabort=()=>reject(failure??new ClinicalLabReferenceError());
 });}finally{db.close();}
}
export const readClinicalLabReference=(scope:ClinicalLabScope)=>transaction(scope);
export const reserveClinicalLabReference=(scope:ClinicalLabScope,revision:number,reference:ClinicalLabReference)=>transaction(scope,current=>reserveClinicalLabReferenceState(current,revision,reference));
export const acknowledgeClinicalLabReference=(scope:ClinicalLabScope,reference:ClinicalLabReference)=>transaction(scope,current=>acknowledgeClinicalLabReferenceState(current,reference));
