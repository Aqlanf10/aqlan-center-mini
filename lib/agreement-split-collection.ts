import { CLINIC_BASE_CURRENCY, isCurrency, toBaseAmount, type Currency } from "./money";

/** A single command can own several immutable cash receipts, but the client
 * MUST validate the whole committed allocation before retiring a recovery key.
 * This is response validation; account authority remains on the server.
 */
export type SplitAllocation = {invoiceId:number;paymentId:number;amountMinor:number};
export type SplitReceipt = {
 id:number;receiptNumber:string;patientId:number;invoiceId:number;planId:number|null;
 openingCurrency:null;createdBy:string;amountMinor:number;currency:Currency;
 kind:"payment";method:string;shiftId:number;createdAt:string;
 baseCurrency:Currency;baseAmountMinor:number;exchangeRate:number;reversalOfId:null;
};
export type SplitCollectionEvidence = {
 kind:"approved_agreement_split_v1";planId:number;patientId:number;
 currency:Currency;amountMinor:number;paymentIds:number[];
 allocations:SplitAllocation[];receipts:SplitReceipt[];
};
export type ExpectedSplitCollection = {
 key:string;patientId:number;planId:number;amountMinor:number;currency:Currency;
 actor:string;method:string;
};
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==="object"&&!Array.isArray(x);
const positive=(x:unknown):x is number=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0;
const nonnegative=(x:unknown):x is number=>typeof x==="number"&&Number.isSafeInteger(x)&&x>=0;
export function readSplitCollectionEvidence(value:unknown,expected?:ExpectedSplitCollection):SplitCollectionEvidence|null{
 if(!object(value)||!object(value.collection)||value.collection.kind!=="approved_agreement_split_v1")return null;
 const group=value.collection;
 if(!positive(group.planId)||!positive(group.patientId)||!isCurrency(group.currency)||
   !positive(group.amountMinor)||!Array.isArray(group.receipts)||!Array.isArray(group.paymentIds)||
   !Array.isArray(group.allocations)||group.receipts.length===0||
   group.receipts.length!==group.paymentIds.length||group.receipts.length!==group.allocations.length||
   group.receipts.length>200)return null;
 if(expected&&(value.idempotencyKey!==expected.key||group.patientId!==expected.patientId||
   group.planId!==expected.planId||group.amountMinor!==expected.amountMinor||
   group.currency!==expected.currency))return null;
 if(value.collectionAmountMinor!==group.amountMinor||value.id!==group.paymentIds[0]||
   JSON.stringify(value.paymentIds)!==JSON.stringify(group.paymentIds)||
   JSON.stringify(value.allocations)!==JSON.stringify(group.allocations))return null;
 const ids=new Set<number>(),invoices=new Set<number>();let sum=0;
 for(let i=0;i<group.receipts.length;i++){
  const receipt=group.receipts[i],allocation=group.allocations[i],paymentId=group.paymentIds[i];
  if(!object(receipt)||!object(allocation)||!positive(paymentId)||ids.has(paymentId)||
    !positive(allocation.invoiceId)||invoices.has(allocation.invoiceId)||
    allocation.paymentId!==paymentId||!positive(allocation.amountMinor)||
    !positive(receipt.id)||receipt.id!==paymentId||receipt.patientId!==group.patientId||
    receipt.invoiceId!==allocation.invoiceId||receipt.planId!==null||
    receipt.openingCurrency!==null||receipt.amountMinor!==allocation.amountMinor||
    receipt.currency!==group.currency||receipt.kind!=="payment"||
    receipt.reversalOfId!==null||typeof receipt.createdBy!=="string"||!receipt.createdBy||
    expected&&receipt.createdBy!==expected.actor||
    typeof receipt.receiptNumber!=="string"||!receipt.receiptNumber.trim()||
    typeof receipt.method!=="string"||expected&&receipt.method!==expected.method||
    !positive(receipt.shiftId)||typeof receipt.createdAt!=="string"||
    !Number.isFinite(Date.parse(receipt.createdAt))||receipt.baseCurrency!==CLINIC_BASE_CURRENCY||
    !nonnegative(receipt.baseAmountMinor)||typeof receipt.exchangeRate!=="number"||
    !Number.isFinite(receipt.exchangeRate)||receipt.exchangeRate<=0||
    receipt.baseAmountMinor!==toBaseAmount(receipt.amountMinor as number,receipt.currency as Currency,CLINIC_BASE_CURRENCY,receipt.exchangeRate as number))
      return null;
  // Top-level legacy receipt must match the first part exactly.
  if(i===0&&(value.receiptNumber!==receipt.receiptNumber||
    value.amountMinor!==receipt.amountMinor||value.invoiceId!==receipt.invoiceId||
    value.createdBy!==receipt.createdBy||value.patientId!==receipt.patientId))return null;
  ids.add(paymentId);invoices.add(allocation.invoiceId);sum+=allocation.amountMinor;
  if(!Number.isSafeInteger(sum))return null;
 }
 if(sum!==group.amountMinor)return null;
 return group as unknown as SplitCollectionEvidence;
}
