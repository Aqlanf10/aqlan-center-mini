import type {DbClient} from "./db";
import {readInvoiceSettlementPosition} from "./invoice-settlement-position";
import {isCurrency} from "./money";
export class InvoiceVisitContextError extends Error {
  constructor(){super("الزيارة المحددة لا تخص هذا المريض أو لم تعد متاحة لربط الفاتورة. حدّث الزيارة واختر سياقها صراحةً.");}
}
/** Explicit context only. Generic invoices never query or guess a nearby visit.
 * Caller owns the patient fence and current invoice authority. */
export async function lockInvoiceVisitContext(client:DbClient,patientId:number,visitId:number){
  if(!Number.isSafeInteger(visitId)||visitId<=0||visitId>2_147_483_647)throw new InvoiceVisitContextError();
  const {rows:[visit]}=await client.query<{patient_id:number|null;status:string;signed_at:unknown;invoice_id:number|null}>(
    "SELECT patient_id,status,signed_at,invoice_id FROM visits WHERE id=$1 FOR UPDATE",[visitId]);
  if(!visit||visit.patient_id!==patientId||visit.signed_at!==null||visit.invoice_id!==null||!["waiting","called","in_chair"].includes(visit.status))throw new InvoiceVisitContextError();
}
/** An exact replay may arrive after signature/checkout, but cannot claim a link
 * that a different workflow erased or reassigned. No replay repairs or posts it. */
export async function readInvoiceVisitContext(client:DbClient,patientId:number,visitId:number,invoiceId:number){
  const {rows:[visit]}=await client.query<{patient_id:number|null;invoice_id:number|null}>("SELECT patient_id,invoice_id FROM visits WHERE id=$1 FOR SHARE",[visitId]);
  if(!visit||visit.patient_id!==patientId||visit.invoice_id===null)throw new InvoiceVisitContextError();
  if(visit.invoice_id!==invoiceId){
    const {rows:[original]}=await client.query<{patient_id:number;base_currency:string}>("SELECT patient_id,base_currency FROM invoices WHERE id=$1",[invoiceId]);
    if(!original||original.patient_id!==patientId||!isCurrency(original.base_currency))throw new InvoiceVisitContextError();
    try{
      const position=await readInvoiceSettlementPosition(client,{patientId,invoiceId:visit.invoice_id,currency:original.base_currency});
      if(!position.lineageInvoiceIds.includes(invoiceId))throw new InvoiceVisitContextError();
    }catch{throw new InvoiceVisitContextError();}
  }
  return visitId;
}
