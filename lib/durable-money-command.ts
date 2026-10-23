import {CLINIC_BASE_CURRENCY,isCurrency,parseAmount,toBaseAmount,type Currency} from "./money";
import {FinancialRecoveryError,type FinancialCommand} from "./financial-command-journal";
import {moneyAcknowledgment,type MoneyAttempt,type MoneyAcknowledgment} from "./money-attempt";
import {readSplitCollectionEvidence} from "./agreement-split-collection";
import {readPaymentAcknowledgmentEvidence,calculationEvidenceMatchesReceipt,closingRefundEvidenceMatchesReceipt,replacementLineageEvidenceMatches} from "./payment-acknowledgment";

export interface MoneyReceiptContext {id:number;receiptNumber:string;amountMinor:number;currency:Currency;method:string;invoiceId:number|null;planId?:number|null;openingCurrency?:Currency|null;remainingMinor:number}
export interface DurableMoneyCommand {actor:string;patientId:number;owner:string;attempt:MoneyAttempt;receipt:MoneyReceiptContext|null}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const id=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>0;
const amount=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const nullableId=(value:unknown)=>value===null||id(value);
const targetId=(value:unknown)=>value===undefined||value===""||value===null?null:Number(value);
function input(command:DurableMoneyCommand){
  const body:unknown=JSON.parse(command.attempt.request.body);if(!record(body))return null;
  const {operation,url}=command.attempt.request;
  if(operation==="payment"){
    if(url!=="/api/payments"||body.patientId!==command.patientId||body.kind!=="payment"||!isCurrency(body.currency))return null;
    const value=parseAmount(String(body.amount),body.currency),invoiceId=targetId(body.invoiceId),planId=targetId(body.planId),openingCurrency=body.openingCurrency??null;
    if(value===null||value<=0||!nullableId(invoiceId)||!nullableId(planId)||openingCurrency!==null&&!isCurrency(openingCurrency)
      ||[invoiceId,planId,openingCurrency].filter(one=>one!==null).length>1)return null;
    // A legitimate funded-plan collection can create its installment invoice.
    // The immutable plan target still must match; an arbitrary invoice target cannot replace it.
    return {body,amountMinor:value,currency:body.currency,invoiceId:planId!==null?undefined:invoiceId,planId,openingCurrency,method:body.method==="transfer"?"transfer":"cash",note:typeof body.note==="string"?body.note.trim().slice(0,300)||null:null};
  }
  const prior=command.receipt;
  if(!prior||!id(prior.id)||url!==`/api/payments/${prior.id}/correct`||!isCurrency(prior.currency)||!amount(prior.remainingMinor)||prior.remainingMinor>prior.amountMinor
    ||!nullableId(prior.invoiceId)||!nullableId(prior.planId??null)||prior.openingCurrency!=null&&!isCurrency(prior.openingCurrency)
    ||!["correct","void"].includes(operation)||body.mode!==operation||typeof body.reason!=="string"||body.reason.trim().length<3)return null;
  if(operation==="void")return {body,amountMinor:0,currency:prior.currency,invoiceId:null,planId:null,openingCurrency:null,method:"cash",note:null};
  if(!isCurrency(body.currency))return null;
  const value=parseAmount(String(body.amount),body.currency),original=body.target==="original";
  const invoiceId=original?prior.invoiceId:targetId(body.invoiceId),planId=original?prior.planId??null:targetId(body.planId),openingCurrency=original?prior.openingCurrency??null:body.openingCurrency??null;
  if(value===null||value<=0||!nullableId(invoiceId)||!nullableId(planId)||openingCurrency!==null&&!isCurrency(openingCurrency))return null;
  return {body,amountMinor:value,currency:body.currency,invoiceId,planId,openingCurrency,method:body.method==="transfer"?"transfer":"cash",note:null};
}
export function durableMoneyCommand(command:DurableMoneyCommand):FinancialCommand {
  const {actor,patientId,owner,receipt,attempt}=command;
  return {kind:attempt.request.operation==="payment"?"collection":"receipt-correction",key:attempt.key,
    original:JSON.stringify({actor,patientId,owner,receipt,key:attempt.key,request:attempt.request}),payload:JSON.stringify(command)};
}
export function restoreMoneyCommand(command:FinancialCommand,patientId:number,actor:string):DurableMoneyCommand {
  const value:unknown=JSON.parse(command.payload);
  if(!record(value)||value.actor!==actor||value.patientId!==patientId||typeof value.owner!=="string"||!value.owner||!record(value.attempt)||!record(value.attempt.request)
    ||value.attempt.key!==command.key||typeof value.attempt.request.body!=="string"||typeof value.attempt.request.url!=="string")throw new FinancialRecoveryError("invalid");
  const result=value as unknown as DurableMoneyCommand,encoded=durableMoneyCommand(result);
  if(encoded.kind!==command.kind||encoded.original!==command.original||!input(result)
    ||result.owner!==(command.kind==="collection"?`collection:${patientId}`:`correction:${result.receipt!.id}`))throw new FinancialRecoveryError("invalid");
  return {...result,attempt:{request:result.attempt.request,key:result.attempt.key,phase:"uncertain"}};
}
function receipt(value:unknown,command:DurableMoneyCommand,expected:{kind:string;amountMinor:number;currency:Currency;invoiceId:unknown;planId:unknown;openingCurrency:unknown;method?:string;note?:string|null},baseProven=false){
  return record(value)&&id(value.id)&&typeof value.receiptNumber==="string"&&!!value.receiptNumber.trim()&&value.patientId===command.patientId&&value.createdBy===command.actor
    &&value.kind===expected.kind&&value.amountMinor===expected.amountMinor&&value.currency===expected.currency&&(expected.invoiceId===undefined?nullableId(value.invoiceId):value.invoiceId===expected.invoiceId)&&value.planId===expected.planId
    &&value.openingCurrency===expected.openingCurrency&&(expected.method===undefined||value.method===expected.method)&&(expected.note===undefined||value.note===expected.note)
    &&id(value.shiftId)&&typeof value.createdAt==="string"&&Number.isFinite(Date.parse(value.createdAt))&&value.baseCurrency===CLINIC_BASE_CURRENCY&&amount(value.baseAmountMinor)
    &&typeof value.exchangeRate==="number"&&Number.isFinite(value.exchangeRate)&&value.exchangeRate>0
    &&(baseProven||toBaseAmount(expected.amountMinor,expected.currency,CLINIC_BASE_CURRENCY,value.exchangeRate)===value.baseAmountMinor);
}
/** A successful status or ID alone never retires a saved money command. */
export function readDurableMoneyAcknowledgment(value:unknown,command:DurableMoneyCommand):MoneyAcknowledgment|null {
  const expected=input(command);if(!expected||!record(value)||value.idempotencyKey!==command.attempt.key)return null;
  const operation=command.attempt.request.operation;
  const hasEvidence=Object.hasOwn(value,"acknowledgmentEvidence");
  const evidence=hasEvidence?readPaymentAcknowledgmentEvidence(value.acknowledgmentEvidence):null;
  // Never discard an unknown or contradictory supplied proof and fall back to
  // standalone arithmetic, even if that arithmetic happens to match.
  if(hasEvidence&&(!evidence||"status" in evidence||evidence.operation!==operation||evidence.requestKey!==command.attempt.key))return null;
  if(operation==="payment"){
    if(Object.hasOwn(value,"collection")){
      // A plan-level upgrade is not one invoice receipt. Only the full
      // server-proven split, with exact actor, patient and total, can acknowledge it.
      if(expected.planId===null||expected.invoiceId!==undefined&&expected.invoiceId!==null||
         expected.openingCurrency!==null)return null;
      const split=readSplitCollectionEvidence(value,{
        key:command.attempt.key,patientId:command.patientId,planId:expected.planId,
        amountMinor:expected.amountMinor,currency:expected.currency,
        actor:command.actor,method:expected.method,
      });
      return split?{paymentId:split.paymentIds[0],paymentIds:split.paymentIds,collection:split}:null;
    }
    const calculation=evidence&&"operation" in evidence&&evidence.operation==="payment"?evidence.calculation:null;
    if(calculation&&(value.reversalOfId!==null||!calculationEvidenceMatchesReceipt(calculation,value))
      ||!calculation&&Object.hasOwn(value,"reversalOfId")&&value.reversalOfId!==null)return null;
    return receipt(value,command,{...expected,kind:"payment"},calculation!==null)?moneyAcknowledgment(operation,value):null;
  }
  const old=command.receipt!;
  const proof=evidence&&"correction" in evidence?evidence.correction:null;
  if(!record(value.original)||value.original.id!==old.id||value.original.patientId!==command.patientId||value.original.receiptNumber!==old.receiptNumber||typeof value.replayed!=="boolean"
    ||!record(value.reversal)||value.reversal.reversalOfId!==old.id||value.reversal.id===old.id
    ||!receipt(value.reversal,command,{kind:"refund",amountMinor:old.remainingMinor,currency:old.currency,invoiceId:old.invoiceId,planId:old.planId??null,openingCurrency:old.openingCurrency??null,method:old.method},proof!==null))return null;
  if(proof&&(proof.pair.originalId!==old.id||proof.pair.reversalId!==value.reversal.id||proof.pair.actor!==command.actor
    ||proof.pair.reason!==(expected.body.reason as string).trim().slice(0,300)
    ||!closingRefundEvidenceMatchesReceipt(proof,old,value.reversal)))return null;
  if(operation==="void")return value.replacement===null&&(!proof||proof.pair.replacementId===null)?moneyAcknowledgment(operation,value):null;
  if(!record(value.replacement)||value.replacement.reversalOfId!==null||value.replacement.id===old.id||value.replacement.id===value.reversal.id
    ||proof&&proof.pair.replacementId!==value.replacement.id)return null;
  let replacementInvoiceId=expected.invoiceId;
  if(proof?.replacementLineage){
    if(expected.body.target!=="original"||!replacementLineageEvidenceMatches(proof.replacementLineage,{patientId:command.patientId,originalPaymentId:old.id,sourceInvoiceId:old.invoiceId,targetInvoiceId:value.replacement.invoiceId}))return null;
    replacementInvoiceId=proof.replacementLineage.targetInvoiceId;
  }
  if(proof?.replacementCalculation&&!calculationEvidenceMatchesReceipt(proof.replacementCalculation,value.replacement))return null;
  return receipt(value.replacement,command,{...expected,invoiceId:replacementInvoiceId,kind:"payment",note:undefined},proof?.replacementCalculation!==undefined)?moneyAcknowledgment(operation,value):null;
}
