import {allocateHistoricalDiscount,type HistoricalDocumentInput,type HistoricalDocumentReceipt} from "./legacy-treatment-document";
import type {LineSite} from "./invoice-clinical-linkage";
import {validateDebtRepaymentTerms} from "./debt-installments";

export type HistoricalPreview = {
  patientId:number;currency:HistoricalDocumentInput["currency"];
  lines:{serviceId:number;site:LineSite;specialty:string;planId:number|null;case:
    {mode:"none"}|{mode:"existing";id:number;title:string|null}|{mode:"new";orthoCaseId:number|null;title:string}|{mode:"choose";options:{id:number;title:string}[]}}[];
  remainingMinor:number;accountDueMinor:number;sourceHash:string|null;scheduleVersion:number;requiresAllocationReview:boolean;openingPrincipalMinor:number;
};
export type HistoricalReceiptExpectation={kind:"historical";owner:object;patientId:number;currency:HistoricalDocumentInput["currency"];createdBy:string;
  input:HistoricalDocumentInput;preview:HistoricalPreview};
const object=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const minor=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value)&&value>=0;
const id=(value:unknown):value is number=>minor(value)&&value>0&&value<=2_147_483_647;
const nullableId=(value:unknown)=>value===null||id(value);
const sameSite=(raw:unknown,site:LineSite)=>object(raw)&&raw.mode===site.mode&&raw.toothCode===site.toothCode&&raw.surfaces===site.surfaces&&raw.scope===site.scope
  &&JSON.stringify(raw.episodeTeeth)===JSON.stringify(site.episodeTeeth);
export function readHistoricalPreview(raw:unknown,input:HistoricalDocumentInput):HistoricalPreview|null {
  if(!object(raw)||raw.patientId!==input.patientId||raw.currency!==input.currency||!Array.isArray(raw.lines)||raw.lines.length!==input.lines.length
    ||!minor(raw.remainingMinor)||!minor(raw.openingPrincipalMinor)||typeof raw.accountDueMinor!=="number"||!Number.isSafeInteger(raw.accountDueMinor)
    ||!minor(raw.scheduleVersion)||typeof raw.requiresAllocationReview!=="boolean"
    ||raw.requiresAllocationReview!==(raw.remainingMinor>Math.max(0,raw.accountDueMinor))
    ||raw.sourceHash!==null&&(typeof raw.sourceHash!=="string"||!/^[a-f0-9]{64}$/.test(raw.sourceHash)))return null;
  for(const [index,line] of raw.lines.entries()){
    const expected=input.lines[index];
    if(!object(line)||line.serviceId!==expected.serviceId||!sameSite(line.site,expected.site)||typeof line.specialty!=="string"||!line.specialty
      ||!nullableId(line.planId)||!object(line.case))return null;
    const choice=line.case;
    if(choice.mode==="none"){if(expected.caseId!==null)return null;}
    else if(choice.mode==="existing"){if(!id(choice.id)||choice.title!==null&&typeof choice.title!=="string"||expected.caseId!==null&&choice.id!==expected.caseId)return null;}
    else if(choice.mode==="new"){if(!nullableId(choice.orthoCaseId)||typeof choice.title!=="string"||expected.caseId!==null)return null;}
    else if(choice.mode==="choose"){if(!Array.isArray(choice.options)||choice.options.length<2||!choice.options.every(one=>object(one)&&id(one.id)&&typeof one.title==="string"))return null;}
    else return null;
  }
  return raw as unknown as HistoricalPreview;
}
/** Bind the entire financial and clinical acknowledgement to the retained command.
 * A valid-looking ID or successful HTTP status cannot retire an uncertain save. */
export function readHistoricalReceipt(raw:unknown,expected:HistoricalReceiptExpectation,owner:object):HistoricalDocumentReceipt|null {
  if(expected.owner!==owner||!object(raw)||typeof raw.replayed!=="boolean"||!object(raw.document))return null;
  const value=raw.document,input=expected.input;
  if(!id(value.id)||!id(value.revisionId)||value.version!==1||value.patientId!==expected.patientId||value.currency!==expected.currency
    ||value.createdBy!==expected.createdBy||value.idempotencyKey!==input.idempotencyKey
    ||value.totalMinor!==input.totalMinor||value.discountMinor!==input.discountMinor||value.discountReason!==input.discountReason
    ||value.agreedMinor!==input.agreedMinor||value.previouslyPaidMinor!==input.previouslyPaidMinor||value.remainingMinor!==input.remainingMinor
    ||value.historicalAsOf!==input.historicalAsOf||value.note!==input.note||typeof value.reason!=="string"||!value.reason.trim()
    ||!Array.isArray(value.lines)||value.lines.length!==input.lines.length)return null;
  const allocation=allocateHistoricalDiscount(input.lines.map(line=>line.unitPriceMinor),input.discountMinor);
  const agreements=new Set<number>(),items=new Set<number>(),plans=new Set<number>();
  for(const [index,line] of value.lines.entries()){
    const source=input.lines[index],proof=expected.preview.lines[index];
    if(!object(line)||!id(line.agreementId)||agreements.has(line.agreementId)||!id(line.planItemId)||items.has(line.planItemId)
      ||!id(line.planId)||proof.planId!==null&&line.planId!==proof.planId||!nullableId(line.caseId)
      ||line.serviceId!==source.serviceId||line.doctorId!==source.doctorId||line.description!==source.description
      ||line.toothCode!==source.site.toothCode||!sameSite(line.site,source.site)||line.unitPriceMinor!==source.unitPriceMinor
      ||line.discountMinor!==allocation[index].discountMinor||line.netMinor!==allocation[index].netMinor)return null;
    if(proof.case.mode==="choose"||proof.case.mode==="none"&&line.caseId!==null||proof.case.mode==="existing"&&line.caseId!==proof.case.id
      ||proof.case.mode==="new"&&!id(line.caseId))return null;
    agreements.add(line.agreementId);items.add(line.planItemId);plans.add(line.planId);
  }
  if(plans.size!==1)return null;
  const repayment=value.repayment;
  if(input.repaymentRemainingMinor===0&&input.repaymentVersion===0){if(repayment!==null)return null;}
  else {
    if(!object(repayment)||!id(repayment.arrangementId)||!id(repayment.revisionId)||repayment.version!==input.repaymentVersion+1)return null;
    const parsed=validateDebtRepaymentTerms(repayment.terms,input.repaymentRemainingMinor);
    if(!parsed.ok||JSON.stringify(parsed.value)!==JSON.stringify(input.repaymentTerms))return null;
  }
  return value as unknown as HistoricalDocumentReceipt;
}
