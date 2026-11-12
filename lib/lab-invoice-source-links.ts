import { createHash } from "node:crypto";
import type { DbClient } from "./db";
import { DebtRepaymentError } from "./debt-installments-db";
import { labWorkIntentSupported, assertLabWorkCommandApplied } from "./lab-work-intent-db";

type Source = { invoice_item_id:number; plan_item_id:number|null; intent_id:string; member_id:string; patient_id:number };
const conflict=():never=>{throw new DebtRepaymentError("conflict","بند الفاتورة مرتبط بعمل مختبر محفوظ؛ لا تُغيّر هويته أو تحذف رابطه من تصحيح مالي.");};

/** Exact item/plan aliases only. Includes draft members so an unmaterialized intent is not bypassed. */
export async function linkedLabWorkForInvoiceInTransaction(client:Pick<DbClient,"query">,input:{patientId:number;invoiceId:number;lock?:boolean}) {
 if(!await labWorkIntentSupported(client))return {invoiceItemIds:[] as number[],planItemIds:[] as number[],sources:[] as Source[]};
 const {rows}=await client.query<Source>(`SELECT DISTINCT ii.id AS invoice_item_id,ii.plan_item_id,m.intent_id,m.id AS member_id,m.patient_id
   FROM invoice_items ii JOIN invoices inv ON inv.id=ii.invoice_id
   JOIN lab_work_members m ON m.plan_item_id=ii.plan_item_id OR EXISTS (
     SELECT 1 FROM lab_prescription_source_memberships a WHERE a.member_id=m.id
       AND (a.invoice_item_id=ii.id OR a.plan_item_id=ii.plan_item_id))
   WHERE ii.invoice_id=$1 ORDER BY ii.id,m.intent_id,m.id`,[input.invoiceId]);
 if(rows.some(row=>row.patient_id!==input.patientId))conflict();
 if(input.lock&&rows.length){
  const ids=[...new Set(rows.map(row=>row.intent_id))].sort();
  await client.query("SELECT id FROM lab_work_intents WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT",[ids]);
  await client.query("SELECT id FROM lab_work_members WHERE intent_id=ANY($1::uuid[]) ORDER BY intent_id,id FOR SHARE NOWAIT",[ids]);
 }
 return {invoiceItemIds:[...new Set(rows.map(row=>row.invoice_item_id))],planItemIds:[...new Set(rows.flatMap(row=>row.plan_item_id===null?[]:[row.plan_item_id]))],sources:rows};
}

/** The financial correction's proven itemPairs are the only accepted handoff; never a similarity join. */
export async function aliasCorrectedInvoiceLabWorkInTransaction(client:DbClient,input:{patientId:number;originalInvoiceId:number;correctedInvoiceId:number;actorUserId:number;itemPairs:readonly {originalItemId:number;correctedItemId:number}[]}) {
 const linked=await linkedLabWorkForInvoiceInTransaction(client,{patientId:input.patientId,invoiceId:input.originalInvoiceId,lock:true});
 if(!linked.sources.length)return;
 const pairs=new Map(input.itemPairs.map(pair=>[pair.originalItemId,pair.correctedItemId]));
 if(pairs.size!==input.itemPairs.length)conflict();
 for(const originalId of linked.invoiceItemIds){
  const correctedId=pairs.get(originalId);if(!correctedId)conflict();
  const sources=linked.sources.filter(row=>row.invoice_item_id===originalId);
  if(sources.length!==1)conflict();
  const source=sources[0];
  const {rows:[proof]}=await client.query<{valid:boolean}>(`SELECT (
    old.invoice_id=$3 AND replacement.invoice_id=$4 AND oi.patient_id=$5 AND ni.patient_id=$5
    AND ROW(old.service_id,old.doctor_id,old.quantity,old.plan_item_id)
      IS NOT DISTINCT FROM ROW(replacement.service_id,replacement.doctor_id,replacement.quantity,replacement.plan_item_id)
   ) AS valid FROM invoice_items old JOIN invoices oi ON oi.id=old.invoice_id
   CROSS JOIN invoice_items replacement JOIN invoices ni ON ni.id=replacement.invoice_id
   WHERE old.id=$1 AND replacement.id=$2`,[originalId,correctedId,input.originalInvoiceId,input.correctedInvoiceId,input.patientId]);
  if(!proof?.valid)conflict();
  const {rows:existing}=await client.query<{intent_id:string;member_id:string;patient_id:number}>("SELECT intent_id,member_id,patient_id FROM lab_prescription_source_memberships WHERE invoice_item_id=$1",[correctedId]);
  if(existing.length){if(existing.length!==1||existing[0].intent_id!==source.intent_id||existing[0].member_id!==source.member_id||existing[0].patient_id!==input.patientId)conflict();continue;}
  await client.query(`INSERT INTO lab_prescription_source_memberships(intent_id,member_id,patient_id,invoice_item_id,linked_by_user_id)
   VALUES($1::uuid,$2::uuid,$3,$4,$5)`,[source.intent_id,source.member_id,input.patientId,correctedId,input.actorUserId]);
 }
}

export type InvoiceLabWorkReceipt = Array<{intentId:string;orderId:number;revision:number;memberIds:string[]}>;
/** Original command receipt only: current spec/revision must never reinterpret a lost acknowledgement. */
export async function invoiceLabWorkReceiptInTransaction(client:Pick<DbClient,"query">,input:{patientId:number;invoiceId:number;actorUserId:number;requestKey:string;requestHash:string}):Promise<InvoiceLabWorkReceipt|undefined>{
 if(!await labWorkIntentSupported(client))return undefined;
 const {rows:[command]}=await client.query<{patient_id:number;source_kind:string;source_id:number;request_hash:string;result:unknown}>(
  "SELECT patient_id,source_kind,source_id,request_hash,result FROM lab_work_commands WHERE actor_user_id=$1 AND request_key=$2",[input.actorUserId,input.requestKey]);
 if(!command)return undefined;
 if(command.patient_id!==input.patientId||command.source_kind!=="invoice"||command.source_id!==input.invoiceId||command.request_hash!==createHash("sha256").update(input.requestHash).digest("hex"))conflict();
 const result=command.result as {outcome?:unknown;code?:unknown;labWork?:unknown}|null;
 if(result?.outcome === "rejected"){
  if(typeof result.code !== "string" || !/^[a-z][a-z0-9_]{0,95}$/.test(result.code))conflict();
  assertLabWorkCommandApplied({outcome:"rejected",code:result.code as string});
 }
 if(!result || (result.outcome !== undefined && result.outcome !== "applied"))conflict();
 const value=result?.labWork;
 if(!Array.isArray(value))conflict();
 const receipt=value as InvoiceLabWorkReceipt;
 for(const entry of receipt){
  if(!entry||typeof entry.intentId!=="string"||!Number.isSafeInteger(entry.orderId)||entry.orderId<=0||!Number.isSafeInteger(entry.revision)||entry.revision<1||!Array.isArray(entry.memberIds)||!entry.memberIds.length||entry.memberIds.some(id=>typeof id!=="string")||new Set(entry.memberIds).size!==entry.memberIds.length)conflict();
  const {rows}=await client.query<{member_id:string}>(`SELECT DISTINCT a.member_id FROM lab_prescription_source_memberships a
   JOIN invoice_items ii ON ii.id=a.invoice_item_id JOIN lab_work_intents i ON i.id=a.intent_id
   WHERE ii.invoice_id=$1 AND a.patient_id=$2 AND a.intent_id=$3::uuid AND i.initial_order_id=$4`,[input.invoiceId,input.patientId,entry.intentId,entry.orderId]);
  if(rows.length!==entry.memberIds.length||rows.some(row=>!entry.memberIds.includes(row.member_id)))conflict();
 }
 return receipt;
}
