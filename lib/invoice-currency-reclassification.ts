import {isCurrency, toBaseAmount, type Currency} from "./money";

/** Arithmetic for the guarded writer. Ownership, complete lineage and locking
 * are proved separately by the database adapter before this planner is called. */
export interface ReclassificationPayment {
  id: number; patientId: number; invoiceId: number | null;
  kind: "payment" | "refund"; reversalOfId: number | null;
  currency: Currency; amountMinor: number; baseCurrency: Currency;
  baseAmountMinor: number; exchangeRate: number;
}
export interface ReclassificationEvidence {
  paymentId: number; refundIds: number[];
  sourceMinor: number; targetMinor: number;
}
export class ReclassificationProofError extends Error {
  constructor(){super("تعذّر إثبات تسوية كل سند بعملته الأصلية؛ يلزم مراجعة مالية، ولم تتغيّر السندات.");}
}
const fail=():never=>{throw new ReclassificationProofError();};
const positiveId=(value:number)=>Number.isSafeInteger(value)&&value>0;
const signed=(value:number)=>{if(!Number.isSafeInteger(value))fail();return value;};
const safe=(value:number)=>{if(!Number.isSafeInteger(value)||value<0)fail();return value;};

/** Only YER -> the recorded receipt currency is supported initially. Receipts
 * must be selected by authoritative invoice lineage, never from patient credit.
 * Monetary values are recorded minor units; no aggregate division/current FX.
 * Refunds are projected once using their own immutable recorded amounts.
 * The DB adapter must prove completeness and lock the patient before this call.
 */
export function planCurrencyReclassification(input:{
  patientId:number; lineageInvoiceIds:readonly number[]; fromCurrency:Currency;
  toCurrency:Currency; principalMinor:number; payments:readonly ReclassificationPayment[];
}){
  const {patientId,lineageInvoiceIds,fromCurrency,toCurrency,payments}=input;
  if(!positiveId(patientId)||fromCurrency!=="YER"||!isCurrency(toCurrency)||toCurrency===fromCurrency
    ||!lineageInvoiceIds.length||lineageInvoiceIds.some(id=>!positiveId(id))
    ||new Set(lineageInvoiceIds).size!==lineageInvoiceIds.length)fail();
  safe(input.principalMinor);
  const ids=new Set<number>();
  for(const row of payments){
    if(!positiveId(row.id)||ids.has(row.id)||row.patientId!==patientId||row.invoiceId===null||!lineageInvoiceIds.includes(row.invoiceId)
      ||row.currency!==toCurrency||row.baseCurrency!==fromCurrency||!["payment","refund"].includes(row.kind)
      ||!Number.isFinite(row.exchangeRate)||row.exchangeRate<=0)fail();
    ids.add(row.id);safe(row.amountMinor);safe(row.baseAmountMinor);
    if(toBaseAmount(row.amountMinor,row.currency,row.baseCurrency,row.exchangeRate)!==row.baseAmountMinor)fail();
    if(row.kind==="payment"&&row.reversalOfId!==null||row.kind==="refund"&&(row.reversalOfId===null||!positiveId(row.reversalOfId)))fail();
  }
  const originals=payments.filter(row=>row.kind==="payment");
  for(const refund of payments.filter(row=>row.kind==="refund")){
    const original=originals.find(row=>row.id===refund.reversalOfId);
    if(!original||refund.invoiceId!==original.invoiceId||refund.exchangeRate!==original.exchangeRate)fail();
  }
  let sourceMinor=0,targetMinor=0;
  const evidence:ReclassificationEvidence[]=originals.map(row=>{
    const refunds=payments.filter(refund=>refund.kind==="refund"&&refund.reversalOfId===row.id);
    let source=row.baseAmountMinor,target=row.amountMinor;
    for(const refund of refunds){source=signed(source-refund.baseAmountMinor);target=safe(target-refund.amountMinor);}
    sourceMinor=signed(sourceMinor+source);targetMinor=safe(targetMinor+target);
    return {paymentId:row.id,refundIds:refunds.map(refund=>refund.id),sourceMinor:source,targetMinor:target};
  });
  // Settlement deltas reverse the old credit and apply the new credit. Cash
  // deltas are deliberately absent. GL balances each currency against 1901.
  return {evidence,sourceMinor,settledMinor:targetMinor,
    remainingMinor:Math.max(0,input.principalMinor-targetMinor),creditMinor:Math.max(0,targetMinor-input.principalMinor),
    settlementDeltas:[{currency:fromCurrency,minor:-sourceMinor},{currency:toCurrency,minor:targetMinor}]};
}
