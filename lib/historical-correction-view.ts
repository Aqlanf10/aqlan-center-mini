import {allocateHistoricalDiscount,parseHistoricalCorrection,type HistoricalDocumentReceipt} from "./legacy-treatment-document";
import {isCurrency} from "./money";
import {validateDebtRepaymentTerms} from "./debt-installments";
import {FinancialRecoveryError,type FinancialCommand} from "./financial-command-journal";

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==="object"&&!Array.isArray(value);
const integer=(value:unknown):value is number=>typeof value==="number"&&Number.isSafeInteger(value);
const minor=(value:unknown):value is number=>integer(value)&&value>=0;
const id=(value:unknown):value is number=>minor(value)&&value>0;
const sameSite=(value:unknown,expected:HistoricalDocumentReceipt["lines"][number]["site"])=>record(value)&&value.mode===expected.mode&&value.toothCode===expected.toothCode
  &&value.surfaces===expected.surfaces&&value.scope===expected.scope&&JSON.stringify(value.episodeTeeth)===JSON.stringify(expected.episodeTeeth);
export type HistoricalDocumentView=HistoricalDocumentReceipt&{
  openingPrincipalMinor:number;openingCollectedMinor:number;openingRemainingMinor:number;accountDueMinor:number;scheduleVersion:number;sourceHash:string;
  correctionAvailable:boolean;correctionMessage:string|null;history:{version:number;reason:string;created_by:string}[];
};
function documentValue(document:unknown,patientId:number):document is HistoricalDocumentReceipt {
  if(!record(document)||!id(document.id)||!id(document.version)||!id(document.revisionId)||document.patientId!==patientId||!isCurrency(document.currency)
    ||![document.totalMinor,document.discountMinor,document.agreedMinor,document.previouslyPaidMinor,document.remainingMinor].every(minor)
    ||document.agreedMinor!==Number(document.totalMinor)-Number(document.discountMinor)||document.remainingMinor!==Number(document.agreedMinor)-Number(document.previouslyPaidMinor)
    ||typeof document.historicalAsOf!=="string"||typeof document.createdBy!=="string"||typeof document.idempotencyKey!=="string"||typeof document.reason!=="string"
    ||document.discountReason!==null&&typeof document.discountReason!=="string"||document.note!==null&&typeof document.note!=="string"
    ||!Array.isArray(document.lines)||!document.lines.length)return false;
  const agreements=new Set<number>(),items=new Set<number>();
  for(const line of document.lines){
    if(!record(line)||!id(line.agreementId)||agreements.has(line.agreementId)||!id(line.planItemId)||items.has(line.planItemId)||!id(line.planId)||!id(line.serviceId)
      ||line.caseId!==null&&!id(line.caseId)||line.doctorId!==null&&!id(line.doctorId)||line.toothCode!==null&&!id(line.toothCode)
      ||typeof line.description!=="string"||!minor(line.unitPriceMinor)||!minor(line.discountMinor)||!minor(line.netMinor)
      ||line.netMinor!==line.unitPriceMinor-line.discountMinor||!record(line.site))return false;
    agreements.add(line.agreementId);items.add(line.planItemId);
  }
  return document.lines.reduce((sum,line)=>sum+Number(line.unitPriceMinor),0)===document.totalMinor
    &&document.lines.reduce((sum,line)=>sum+Number(line.discountMinor),0)===document.discountMinor;
}
export function readHistoricalDocuments(value:unknown,patientId:number):HistoricalDocumentView[]|null {
  if(!record(value)||!Array.isArray(value.documents))return null;
  if(!value.documents.every(document=>documentValue(document,patientId)&&record(document)
    &&[document.openingPrincipalMinor,document.openingCollectedMinor,document.openingRemainingMinor,document.scheduleVersion].every(minor)
    &&document.openingRemainingMinor===Math.max(0,Number(document.openingPrincipalMinor)-Number(document.openingCollectedMinor))&&integer(document.accountDueMinor)
    &&typeof document.sourceHash==="string"&&/^[a-f0-9]{64}$/.test(document.sourceHash)&&typeof document.correctionAvailable==="boolean"
    &&(document.correctionMessage===null||typeof document.correctionMessage==="string")&&Array.isArray(document.history)&&document.history.length===document.version
    &&document.history.every((row,index)=>record(row)&&row.version===index+1&&typeof row.reason==="string"&&typeof row.created_by==="string")))return null;
  return value.documents as HistoricalDocumentView[];
}
export interface HistoricalCorrectionCommand {
  key:string;actor:string;patientId:number;documentId:number;body:string;original:HistoricalDocumentView;
  outcome:"pending"|"uncertain"|"refused";message:string;
}
export function durableHistoricalCorrection(command:HistoricalCorrectionCommand):FinancialCommand {
  const {key,actor,patientId,documentId,body,original}=command;
  return {kind:"historical-correction",key,original:JSON.stringify({key,actor,patientId,documentId,body,original}),payload:JSON.stringify(command)};
}
function commandInput(command:HistoricalCorrectionCommand) {
  const source:unknown=JSON.parse(command.body);
  if(!record(source)||source.idempotencyKey!==command.key||source.expectedVersion!==command.original.version||source.expectedSourceHash!==command.original.sourceHash
    ||source.repaymentVersion!==command.original.scheduleVersion)return null;
  const parsed=parseHistoricalCorrection(source,command.original,command.original.historicalAsOf>String(source.historicalAsOf)?command.original.historicalAsOf:String(source.historicalAsOf));
  if(!parsed.ok)return null;
  const after=command.original.openingPrincipalMinor-command.original.remainingMinor+parsed.value.remainingMinor;
  if(!minor(after)||Math.max(0,after-command.original.openingCollectedMinor)!==parsed.value.repaymentRemainingMinor)return null;
  return parsed.value;
}
export function restoreHistoricalCorrection(command:FinancialCommand,patientId:number,actor:string):HistoricalCorrectionCommand {
  const value:unknown=JSON.parse(command.payload);
  if(!record(value)||command.kind!=="historical-correction"||value.key!==command.key||value.actor!==actor||value.patientId!==patientId||!id(value.documentId)
    ||typeof value.body!=="string"||!readHistoricalDocuments({documents:[value.original]},patientId))throw new FinancialRecoveryError("invalid");
  const restored=value as unknown as HistoricalCorrectionCommand;
  if(restored.original.id!==restored.documentId||!commandInput(restored)||durableHistoricalCorrection(restored).original!==command.original)throw new FinancialRecoveryError("invalid");
  return {...restored,outcome:"uncertain",message:"استُعيد طلب تصحيح الاتفاق. أعد الطلب نفسه للتحقق قبل أي تعديل جديد."};
}
export function readHistoricalCorrectionReceipt(value:unknown,command:HistoricalCorrectionCommand):HistoricalDocumentReceipt|null {
  if(!record(value)||typeof value.replayed!=="boolean"||!documentValue(value.document,command.patientId))return null;
  const input=commandInput(command);if(!input)return null;
  const document=value.document,prior=command.original;
  if(document.id!==command.documentId||document.version!==prior.version+1||document.revisionId===prior.revisionId||document.currency!==prior.currency
    ||document.idempotencyKey!==command.key||document.createdBy!==command.actor||document.reason!==input.reason||document.totalMinor!==input.totalMinor
    ||document.discountMinor!==input.discountMinor||document.discountReason!==input.discountReason||document.previouslyPaidMinor!==input.previouslyPaidMinor
    ||document.remainingMinor!==input.remainingMinor||document.historicalAsOf!==input.historicalAsOf||document.note!==input.note||document.lines.length!==prior.lines.length)return null;
  const allocation=allocateHistoricalDiscount(input.prices,input.discountMinor);
  if(!document.lines.every((line,index)=>{
    const old=prior.lines[index];return line.agreementId===old.agreementId&&line.planItemId===old.planItemId&&line.planId===old.planId&&line.caseId===old.caseId
      &&line.serviceId===old.serviceId&&line.doctorId===old.doctorId&&line.description===old.description&&line.toothCode===old.toothCode&&sameSite(line.site,old.site)
      &&line.unitPriceMinor===input.prices[index]&&line.discountMinor===allocation[index].discountMinor&&line.netMinor===allocation[index].netMinor;
  }))return null;
  if(input.repaymentRemainingMinor===0&&input.repaymentVersion===0){if(document.repayment!==null)return null;}
  else {
    const terms=document.repayment;
    if(!record(terms)||!id(terms.arrangementId)||!id(terms.revisionId)||terms.version!==input.repaymentVersion+1)return null;
    const parsed=validateDebtRepaymentTerms(terms.terms,input.repaymentRemainingMinor);
    if(!parsed.ok||JSON.stringify(parsed.value)!==JSON.stringify(input.repaymentTerms))return null;
  }
  return document;
}
