import {parseLabWorkDraft} from "./lab-work-intent-contract";
/** Validate against the SEALED original submission, never today's mutable editor. */
export function hasExactLabOriginReceipt(body:Record<string,unknown>,payload:unknown):boolean{
 const sources=Array.isArray(body.items)?body.items:[];
 const expected=new Map<string,Set<string>>(),revisions=new Map<string,number>();
 try{for(const raw of sources){if(!raw||typeof raw!=="object")continue;const work=parseLabWorkDraft((raw as Record<string,unknown>).labWork);if(!work)continue;const members=expected.get(work.intentId)??new Set<string>();members.add(work.memberId);expected.set(work.intentId,members);revisions.set(work.intentId,Math.max(revisions.get(work.intentId)??0,work.expectedRevision));}}catch{return false;}
 if(!expected.size)return true;
 if(!payload||typeof payload!=="object")return false;const rows=(payload as Record<string,unknown>).labWork;if(!Array.isArray(rows)||rows.length!==expected.size)return false;
 const seen=new Set<string>(),orders=new Set<number>();
 return rows.every(raw=>{if(!raw||typeof raw!=="object")return false;const row=raw as Record<string,unknown>;if(typeof row.intentId!=="string"||seen.has(row.intentId))return false;const members=expected.get(row.intentId);
  if(!members||!Number.isSafeInteger(row.orderId)||(row.orderId as number)<=0||orders.has(row.orderId as number)||!Number.isSafeInteger(row.revision)||(row.revision as number)<Math.max(1,revisions.get(row.intentId)??0)||!Array.isArray(row.memberIds)||row.memberIds.length!==members.size||new Set(row.memberIds).size!==members.size||!row.memberIds.every(id=>typeof id==="string"&&members.has(id)))return false;
  seen.add(row.intentId);orders.add(row.orderId as number);return true;
 });
}
