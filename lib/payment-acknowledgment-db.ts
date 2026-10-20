import type {DbClient} from "./db";
import {readCurrencyReclassificationEvidence} from "./invoice-currency-evidence";
import {ReclassificationProofError} from "./invoice-currency-reclassification";
import {CLINIC_BASE_CURRENCY,isCurrency,toBaseAmount,type Currency} from "./money";
import type {
  CorrectionAcknowledgmentEvidence,PaymentCalculationEvidence,PaymentReplacementLineageEvidence,
} from "./payment-acknowledgment";

/** Server-only persisted evidence reader. Callers own authorization and the
 * transaction/origin lock. These readers never create or repair evidence. */
type Reader=Pick<DbClient,"query">;
export interface AckPaymentRow {
  id:number;receipt_number:string;patient_id:number;kind:string;
  amount_minor:string;currency:string;exchange_rate:string;base_amount_minor:string;base_currency:string;
  invoice_id:number|null;plan_id:number|null;opening_currency:string|null;
  method:string|null;note:string|null;created_by:string|null;reversal_of_id:number|null;
  idempotency_key:string|null;idempotency_request_hash:string|null;
}
const COLUMNS=`id,receipt_number,patient_id,kind,amount_minor::text,currency,exchange_rate::text,
  base_amount_minor::text,base_currency,invoice_id,plan_id,opening_currency,method,note,created_by,
  reversal_of_id,idempotency_key,idempotency_request_hash`;
const MAX_SAFE=BigInt(Number.MAX_SAFE_INTEGER);
const id=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0;
const nullableId=(value:unknown)=>value===null||id(value);
const nonempty=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const validKey=(value:unknown):value is string=>typeof value==="string"&&/^[A-Za-z0-9._:-]{8,128}$/.test(value);
function integer(value:unknown):number|null {
  if(typeof value!=="string"||!/^\d+$/.test(value))return null;
  const parsed=BigInt(value);
  return parsed<=MAX_SAFE?Number(parsed):null;
}
function monetary(row:AckPaymentRow){
  const native=integer(row.amount_minor),base=integer(row.base_amount_minor),rate=Number(row.exchange_rate);
  if(!id(row.id)||!id(row.patient_id)||!nonempty(row.receipt_number)||native===null||native<=0||base===null
    ||!isCurrency(row.currency)||row.base_currency!==CLINIC_BASE_CURRENCY
    ||!Number.isFinite(rate)||rate<=0||!nullableId(row.invoice_id)||!nullableId(row.plan_id)
    ||!nullableId(row.reversal_of_id)||row.opening_currency!==null&&!isCurrency(row.opening_currency)
    ||row.currency===row.base_currency&&native!==base)return null;
  return {native,base,rate,currency:row.currency,baseCurrency:CLINIC_BASE_CURRENCY,openingCurrency:row.opening_currency};
}
async function payment(client:Reader,paymentId:number):Promise<AckPaymentRow|null>{
  if(!id(paymentId))return null;
  const {rows}=await client.query<AckPaymentRow>(`SELECT ${COLUMNS} FROM payments WHERE id=$1`,[paymentId]);
  return rows.length===1?rows[0]:null;
}

/** Only genuine, bounded server observations may be supplied as rates. Hash
 * equality binds a candidate to the persisted request, not merely its amount. */
export async function provePaymentCalculation(client:Reader,input:{
  paymentId:number;key:string;rates:readonly (number|null)[];
  hashAtRate:(rate:number,row:AckPaymentRow)=>string;
}):Promise<PaymentCalculationEvidence|null>{
  if(!id(input.paymentId)||!validKey(input.key))return null;
  const row=await payment(client,input.paymentId);
  if(!row||row.kind!=="payment"||row.reversal_of_id!==null||row.idempotency_key!==input.key
    ||typeof row.idempotency_request_hash!=="string"||!/^[a-f0-9]{64}$/.test(row.idempotency_request_hash))return null;
  const value=monetary(row);
  if(!value)return null;
  for(const rate of new Set(input.rates)){
    if(rate===null||!Number.isFinite(rate)||rate<=0
      ||input.hashAtRate(rate,row)!==row.idempotency_request_hash
      ||toBaseAmount(value.native,value.currency,value.baseCurrency,rate)!==value.base)continue;
    // Cast only after the unconstrained numeric value has been rounded and
    // range-checked. A finite Number can exceed NUMERIC(18,6); that is invalid
    // proof, not a transaction-aborting numeric overflow.
    const {rows:[cast]}=await client.query<{matches:boolean}>(`
      WITH candidate AS (SELECT ROUND($1::numeric,6) AS rounded)
      SELECT CASE WHEN rounded>0 AND rounded<1000000000000::numeric
        THEN rounded::numeric(18,6)=$2::numeric AND $3::numeric=$2::numeric ELSE FALSE END AS matches FROM candidate`,
    [String(rate),row.exchange_rate,String(value.rate)]);
    if(cast?.matches!==true)continue;
    return {kind:"generic-v1-request-rate",paymentId:row.id,amountMinor:value.native,currency:value.currency,
      baseCurrency:value.baseCurrency,exchangeRate:value.rate,baseAmountMinor:value.base,calculationRate:rate};
  }
  return null;
}

/** Prove the particular saved descendant, not merely some current invoice for
 * this patient. All source membership and 0063 event proofs remain authoritative. */
async function replacementLineage(client:Reader,origin:AckPaymentRow,replacement:AckPaymentRow):Promise<PaymentReplacementLineageEvidence|null>{
  if(origin.invoice_id===null||replacement.invoice_id===null||origin.invoice_id===replacement.invoice_id)return null;
  const {rows:documents}=await client.query<{
    id:number;patient_id:number;correction_id:number;source_invoice_ids:number[];
    source_currency:string;target_currency:string;correction_patient_id:number|null;
    original_invoice_id:number|null;corrected_invoice_id:number|null;original_currency:string|null;currency:string|null;
  }>(`SELECT d.id,d.patient_id,d.correction_id,d.source_invoice_ids,d.source_currency,d.target_currency,
        c.patient_id AS correction_patient_id,c.original_invoice_id,c.corrected_invoice_id,c.original_currency,c.currency
      FROM invoice_settlement_reclassifications d LEFT JOIN invoice_corrections c ON c.id=d.correction_id
      WHERE $1::int=ANY(d.source_invoice_ids)`,[origin.invoice_id]);
  if(documents.length!==1)return null;
  const document=documents[0];
  if(!id(document.id)||!id(document.correction_id)||document.patient_id!==origin.patient_id
    ||document.correction_patient_id!==origin.patient_id||document.source_currency!=="YER"||document.target_currency!=="SAR"
    ||document.original_currency!=="YER"||document.currency!=="SAR"
    ||!id(document.original_invoice_id)||!id(document.corrected_invoice_id)
    ||!Array.isArray(document.source_invoice_ids)||!document.source_invoice_ids.length
    ||document.source_invoice_ids.some(source=>!id(source))
    ||new Set(document.source_invoice_ids).size!==document.source_invoice_ids.length
    ||!document.source_invoice_ids.includes(origin.invoice_id)||!document.source_invoice_ids.includes(document.original_invoice_id)
    ||document.source_invoice_ids.includes(document.corrected_invoice_id))return null;
  const sources=new Set(document.source_invoice_ids);
  const {rows:nodes}=await client.query<{
    invoice_id:number;patient_id:number|null;base_currency:string|null;
    correction_id:number|null;correction_patient_id:number|null;corrected_invoice_id:number|null;
    original_currency:string|null;currency:string|null;
  }>(`WITH RECURSIVE successors(id) AS (
        SELECT $1::int UNION
        SELECT c.corrected_invoice_id FROM invoice_corrections c JOIN successors s ON c.original_invoice_id=s.id)
      SELECT s.id AS invoice_id,i.patient_id,i.base_currency,c.id AS correction_id,
        c.patient_id AS correction_patient_id,c.corrected_invoice_id,c.original_currency,c.currency
      FROM successors s LEFT JOIN invoices i ON i.id=s.id
      LEFT JOIN invoice_corrections c ON c.original_invoice_id=s.id ORDER BY s.id,c.id`,
  [document.corrected_invoice_id]);
  const byId=new Map<number,typeof nodes[number]>();
  for(const node of nodes){
    if(!id(node.invoice_id)||byId.has(node.invoice_id)||sources.has(node.invoice_id)
      ||node.patient_id!==origin.patient_id||node.base_currency!=="SAR")return null;
    if(node.correction_id!==null&&(!id(node.correction_id)||node.correction_id===document.correction_id
      ||node.correction_patient_id!==origin.patient_id||!id(node.corrected_invoice_id)
      ||node.currency!=="SAR"||node.original_currency!==null&&node.original_currency!=="SAR"))return null;
    if(node.correction_id===null&&node.corrected_invoice_id!==null)return null;
    byId.set(node.invoice_id,node);
  }
  let current=document.corrected_invoice_id;
  const visited=new Set<number>(),corrections=new Set([document.correction_id]);
  const path:PaymentReplacementLineageEvidence["path"]=[];
  let selectedPath:PaymentReplacementLineageEvidence["path"]|null=null;
  for(;;){
    if(visited.has(current))return null;
    visited.add(current);
    const node=byId.get(current);
    if(!node)return null;
    if(current===replacement.invoice_id)selectedPath=[...path];
    if(node.correction_id===null)break;
    if(node.corrected_invoice_id===null||corrections.has(node.correction_id))return null;
    corrections.add(node.correction_id);
    path.push({correctionId:node.correction_id,originalInvoiceId:current,correctedInvoiceId:node.corrected_invoice_id});
    current=node.corrected_invoice_id;
  }
  if(selectedPath===null||visited.size!==byId.size)return null;
  let evidence:Awaited<ReturnType<typeof readCurrencyReclassificationEvidence>>;
  try{evidence=await readCurrencyReclassificationEvidence(client,origin.patient_id);}
  catch(error){if(error instanceof ReclassificationProofError)return null;throw error;}
  const origins=evidence.filter(row=>row.paymentId===origin.id);
  const values=monetary(origin);
  if(!values||origins.length!==1)return null;
  const proof=origins[0];
  if(proof.documentId!==document.id||proof.correctionId!==document.correction_id||proof.direction!==1
    ||proof.sourceInvoiceId!==origin.invoice_id||proof.targetInvoiceId!==current
    ||proof.sourceCurrency!==values.baseCurrency||proof.targetCurrency!==values.currency
    ||proof.sourceMinor!==values.base||proof.targetMinor!==values.native)return null;
  return {kind:"reclassified-original-target",patientId:origin.patient_id,originalPaymentId:origin.id,
    sourceInvoiceId:origin.invoice_id,targetInvoiceId:replacement.invoice_id,documentId:document.id,
    correctionId:document.correction_id,sourceInvoiceIds:[...document.source_invoice_ids],
    documentOriginalInvoiceId:document.original_invoice_id,documentCorrectedInvoiceId:document.corrected_invoice_id,path:selectedPath};
}

export async function proveCorrectionAcknowledgment(client:Reader,input:{
  originId:number;reversalId:number;replacementId:number|null;key:string;actor:string;reason:string;originalTarget:boolean;
  replacementExpected:null|{amountMinor:number;currency:Currency;method:string;invoiceId:number|null;planId:number|null;openingCurrency:Currency|null};
  calculationRates:readonly (number|null)[];
  replacementHashAtRate:(rate:number,row:AckPaymentRow)=>string;
}):Promise<CorrectionAcknowledgmentEvidence|null>{
  if(!id(input.originId)||!id(input.reversalId)||!nullableId(input.replacementId)||!validKey(input.key)
    ||!nonempty(input.actor)||typeof input.reason!=="string"||input.reason!==input.reason.trim()
    ||input.reason.length<3||input.reason.length>300||input.originId===input.reversalId
    ||input.replacementId!==null&&(input.replacementId===input.originId||input.replacementId===input.reversalId)
    ||(input.replacementId===null)!==(input.replacementExpected===null))return null;
  const origin=await payment(client,input.originId),reversal=await payment(client,input.reversalId);
  if(!origin||!reversal)return null;
  const source=monetary(origin),closing=monetary(reversal);
  if(!source||!closing||origin.kind!=="payment"||origin.reversal_of_id!==null||!nonempty(origin.method)
    ||reversal.kind!=="refund"||reversal.reversal_of_id!==origin.id||reversal.created_by!==input.actor
    ||reversal.method!==origin.method||reversal.note!==`تصحيح السند ${origin.receipt_number}: ${input.reason}`.slice(0,300)
    ||(input.replacementId===null?reversal.idempotency_key!==input.key:reversal.idempotency_key!==null))return null;

  // Do not filter kind, patient or currency here: every linked row participates
  // in proving membership, and a contradictory row invalidates the evidence.
  const {rows:refunds}=await client.query<AckPaymentRow>(
    `SELECT ${COLUMNS} FROM payments WHERE reversal_of_id=$1 ORDER BY id`,[origin.id]);
  let nativeTotal=0n,baseTotal=0n;
  const ids=new Set<number>(),otherRefunds:CorrectionAcknowledgmentEvidence["closingRefund"]["otherRefunds"]=[];
  for(const refund of refunds){
    const values=monetary(refund);
    if(!values||ids.has(refund.id)||refund.id===origin.id||refund.id===input.replacementId
      ||refund.kind!=="refund"||refund.reversal_of_id!==origin.id||refund.patient_id!==origin.patient_id
      ||refund.currency!==origin.currency||refund.base_currency!==origin.base_currency||refund.exchange_rate!==origin.exchange_rate
      ||refund.invoice_id!==origin.invoice_id||refund.plan_id!==origin.plan_id||refund.opening_currency!==origin.opening_currency)return null;
    ids.add(refund.id);
    nativeTotal+=BigInt(values.native);baseTotal+=BigInt(values.base);
    if(nativeTotal>MAX_SAFE||baseTotal>MAX_SAFE)return null;
    if(refund.id!==reversal.id)otherRefunds.push({id:refund.id,amountMinor:values.native,baseAmountMinor:values.base});
  }
  if(!ids.has(reversal.id)||nativeTotal!==BigInt(source.native)||baseTotal!==BigInt(source.base))return null;
  let remainingNative=BigInt(source.native),remainingBase=BigInt(source.base);
  for(const refund of otherRefunds){remainingNative-=BigInt(refund.amountMinor);remainingBase-=BigInt(refund.baseAmountMinor);}
  if(remainingNative<=0n||remainingBase<0n||remainingNative!==BigInt(closing.native)||remainingBase!==BigInt(closing.base))return null;

  let replacement:AckPaymentRow|null=null;
  let replacementCalculation:PaymentCalculationEvidence|undefined;
  let lineage:PaymentReplacementLineageEvidence|undefined;
  if(input.replacementId!==null){
    const expected=input.replacementExpected!;
    if(!Number.isSafeInteger(expected.amountMinor)||expected.amountMinor<=0||!isCurrency(expected.currency)
      ||!nonempty(expected.method)||!nullableId(expected.invoiceId)||!nullableId(expected.planId)
      ||expected.openingCurrency!==null&&!isCurrency(expected.openingCurrency))return null;
    replacement=await payment(client,input.replacementId);
    const values=replacement?monetary(replacement):null;
    if(!replacement||!values||replacement.kind!=="payment"||replacement.reversal_of_id!==null
      ||replacement.patient_id!==origin.patient_id||replacement.created_by!==input.actor||replacement.idempotency_key!==input.key
      ||replacement.note!==`بدل السند ${origin.receipt_number}`.slice(0,300)
      ||values.native!==expected.amountMinor||replacement.currency!==expected.currency||replacement.method!==expected.method
      ||replacement.plan_id!==expected.planId||replacement.opening_currency!==expected.openingCurrency)return null;
    if(input.originalTarget&&(expected.invoiceId!==origin.invoice_id||expected.planId!==origin.plan_id
      ||expected.openingCurrency!==origin.opening_currency))return null;
    if(replacement.invoice_id!==expected.invoiceId){
      if(!input.originalTarget)return null;
      const verified=await replacementLineage(client,origin,replacement);
      if(!verified)return null;
      lineage=verified;
    }
    if(toBaseAmount(values.native,values.currency,values.baseCurrency,values.rate)!==values.base){
      const verified=await provePaymentCalculation(client,{paymentId:replacement.id,key:input.key,
        rates:input.calculationRates,hashAtRate:input.replacementHashAtRate});
      if(!verified)return null;
      replacementCalculation=verified;
    }
  }
  // Exact audit membership, not a note-shaped guess. A second contradictory or
  // duplicate correction audit is ambiguous even when one row happens to match.
  const {rows:audits}=await client.query<{id:string;actor:string;details:unknown}>(
    `SELECT id::text,actor,details FROM audit_log
      WHERE action='payment.correct' AND entity='payment' AND entity_id=$1 ORDER BY id`,[String(origin.id)]);
  if(audits.length!==1||audits[0].actor!==input.actor||!record(audits[0].details))return null;
  const auditId=integer(audits[0].id),details=audits[0].details;
  if(auditId===null||auditId<=0||details["الطريقة"]!==(replacement?"تصحيح":"إبطال")
    ||details["السبب"]!==input.reason||details["المريض"]!==origin.patient_id
    ||details["سند_العكس"]!==reversal.receipt_number||details["المبلغ_المعكوس"]!==closing.native||details["العملة_المعكوسة"]!==reversal.currency
    ||details["السند_الصحيح"]!==(replacement?.receipt_number??null)
    ||details["المبلغ_الصحيح"]!==(replacement?integer(replacement.amount_minor):null)
    ||details["العملة_الصحيحة"]!==(replacement?.currency??null))return null;
  return {
    pair:{auditId,originalId:origin.id,reversalId:reversal.id,replacementId:replacement?.id??null,
      actor:input.actor,reason:input.reason,keyedPaymentId:replacement?.id??reversal.id},
    origin:{id:origin.id,receiptNumber:origin.receipt_number,amountMinor:source.native,baseAmountMinor:source.base,
      currency:source.currency,baseCurrency:source.baseCurrency,exchangeRate:source.rate,method:origin.method,
      invoiceId:origin.invoice_id,planId:origin.plan_id,openingCurrency:source.openingCurrency},
    closingRefund:{reversalId:reversal.id,otherRefunds},
    ...(replacementCalculation?{replacementCalculation}:{}),
    ...(lineage?{replacementLineage:lineage}:{}),
  };
}
