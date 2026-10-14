import {createHash} from "node:crypto";
import type {DbClient} from "./db";
import {CLINIC_BASE_CURRENCY,isCurrency,requireCurrency,settlePaymentMinor,type Currency} from "./money";
import {invoiceSettlementLineage,InvoiceSettlementLineageError} from "./invoice-settlement-lineage";

export class InvoiceSettlementError extends Error {
  constructor(readonly code:"invalid"|"missing"="invalid"){super("ربط تسوية الفاتورة أو عملتها يحتاج مراجعة مالية؛ لم تُغيّر السندات.");}
}
const safe=(value:string|number)=>{const result=Number(value);if(!Number.isSafeInteger(result))throw new InvoiceSettlementError();return result;};
export interface InvoiceSettlementPosition {
  patientId:number;invoiceId:number;currency:Currency;principalMinor:number;settledMinor:number;remainingMinor:number;creditMinor:number;
  available:boolean;lineageInvoiceIds:number[];paymentIds:number[];proofHash:string;sourceSnapshot:Record<string,unknown>;
}
/** Read on the caller's transaction client. A write caller takes patient/visit
 * fences before invoice locks; a read caller uses a repeatable-read snapshot.
 * Settlement is specific to this explicit correction chain, never a patient pool.
 */
export async function readInvoiceSettlementPosition(client:DbClient,target:{patientId:number;invoiceId:number;currency:Currency},lock=false):Promise<InvoiceSettlementPosition>{
  if(!Number.isSafeInteger(target.patientId)||target.patientId<=0||!Number.isSafeInteger(target.invoiceId)||target.invoiceId<=0||!isCurrency(target.currency))throw new InvoiceSettlementError();
  const {rows:[root]}=await client.query<{patient_id:number;base_currency:string}>("SELECT patient_id,base_currency FROM invoices WHERE id=$1",[target.invoiceId]);
  if(!root||root.patient_id!==target.patientId||root.base_currency!==target.currency)throw new InvoiceSettlementError("missing");
  let lineageInvoiceIds:number[];
  try{lineageInvoiceIds=await invoiceSettlementLineage(client,target.invoiceId,target.patientId,target.currency);}
  catch(error){if(error instanceof InvoiceSettlementLineageError)throw new InvoiceSettlementError();throw error;}
  const {rows:invoices}=await client.query<{id:number;patient_id:number;base_currency:string;total_minor:string;discount_minor:string;status:string;note:string|null}>(
    `SELECT id,patient_id,base_currency,total_minor::text,discount_minor::text,status,note FROM invoices WHERE id=ANY($1::int[]) ORDER BY id ${lock?"FOR NO KEY UPDATE":""}`,[lineageInvoiceIds]);
  if(invoices.length!==lineageInvoiceIds.length||invoices.some(row=>row.patient_id!==target.patientId||row.base_currency!==target.currency||!["open","paid","cancelled"].includes(row.status)
    ||safe(row.total_minor)<0||safe(row.discount_minor)<0||safe(row.discount_minor)>safe(row.total_minor)))throw new InvoiceSettlementError();
  const current=invoices.find(row=>row.id===target.invoiceId);if(!current)throw new InvoiceSettlementError();
  const {rows:edges}=await client.query<{id:number;patient_id:number;currency:string;original_invoice_id:number;corrected_invoice_id:number;request_hash:string}>(
    "SELECT id,patient_id,currency,original_invoice_id,corrected_invoice_id,request_hash FROM invoice_corrections WHERE corrected_invoice_id=ANY($1::int[]) ORDER BY id",[lineageInvoiceIds]);
  if(edges.some(row=>row.patient_id!==target.patientId||row.currency!==target.currency||!lineageInvoiceIds.includes(row.original_invoice_id)||!lineageInvoiceIds.includes(row.corrected_invoice_id)))throw new InvoiceSettlementError();
  // The retired writer identified replacements only in their display note.
  // That is not an authoritative receipt link: refuse an unstructured past
  // rather than treating its replacement as an unpaid root or guessing IDs.
  if(invoices.some(row=>row.note?.startsWith("تصحيح للفاتورة ")&&!edges.some(edge=>edge.corrected_invoice_id===row.id)))throw new InvoiceSettlementError();
  // Imported corruption must not turn a cycle/branch or a live ancestor into
  // another source of settlement. A replacement has one linear cancelled past.
  if(edges.length!==lineageInvoiceIds.length-1
    ||new Set(edges.map(row=>row.original_invoice_id)).size!==edges.length
    ||new Set(edges.map(row=>row.corrected_invoice_id)).size!==edges.length
    ||edges.some(row=>row.original_invoice_id===target.invoiceId)
    ||invoices.some(row=>row.id!==target.invoiceId&&row.status!=="cancelled"))throw new InvoiceSettlementError();
  const {rows:payments}=await client.query<{id:number;invoice_id:number;patient_id:number;kind:string;amount_minor:string;base_amount_minor:string;currency:string;base_currency:string;exchange_rate:string;reversal_of_id:number|null;created_at:string}>(
    `SELECT id,invoice_id,patient_id,kind,amount_minor::text,base_amount_minor::text,currency,base_currency,exchange_rate::text,reversal_of_id,
       to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
     FROM payments WHERE invoice_id=ANY($1::int[]) ORDER BY id`,[lineageInvoiceIds]);
  let settledMinor=0;
  for(const payment of payments){
    if(payment.patient_id!==target.patientId||!["payment","refund"].includes(payment.kind)||safe(payment.amount_minor)<0||safe(payment.base_amount_minor)<0
      ||!isCurrency(payment.currency)||!isCurrency(payment.base_currency)||!Number.isFinite(Number(payment.exchange_rate))||Number(payment.exchange_rate)<=0)throw new InvoiceSettlementError();
    const currency=requireCurrency(payment.currency,"سند تسوية الفاتورة",payment.id);
    if(currency!==target.currency&&target.currency!==CLINIC_BASE_CURRENCY)throw new InvoiceSettlementError();
    if(currency!==target.currency&&target.currency===CLINIC_BASE_CURRENCY&&payment.base_currency!==target.currency)throw new InvoiceSettlementError();
    if(payment.reversal_of_id!==null){const original=payments.find(row=>row.id===payment.reversal_of_id);
      if(payment.kind!=="refund"||!original||original.kind!=="payment"||original.currency!==payment.currency||original.invoice_id!==payment.invoice_id)throw new InvoiceSettlementError();}
    const value=settlePaymentMinor({id:payment.id,currency,amountMinor:safe(payment.amount_minor),baseAmountMinor:safe(payment.base_amount_minor)},target.currency);
    settledMinor=safe(settledMinor+(payment.kind==="refund"?-value:value));
  }
  const totalMinor=safe(current.total_minor),discountMinor=safe(current.discount_minor);
  if(totalMinor<0||discountMinor<0||discountMinor>totalMinor)throw new InvoiceSettlementError();
  const available=current.status!=="cancelled",principalMinor=available?totalMinor-discountMinor:0;
  const sourceSnapshot={invoiceId:current.id,patientId:current.patient_id,currency:current.base_currency,totalMinor,discountMinor,cancelled:!available,
    lineage:invoices.map(row=>({id:row.id,patientId:row.patient_id,currency:row.base_currency,totalMinor:safe(row.total_minor),discountMinor:safe(row.discount_minor),status:row.status})),
    corrections:edges,payments};
  const proofHash=createHash("sha256").update(JSON.stringify(sourceSnapshot)).digest("hex");
  return {...target,principalMinor,settledMinor,remainingMinor:Math.max(0,principalMinor-settledMinor),creditMinor:Math.max(0,settledMinor-principalMinor),available,
    lineageInvoiceIds,paymentIds:payments.map(row=>row.id),proofHash,sourceSnapshot};
}
