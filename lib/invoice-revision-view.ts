import type { Invoice, InvoiceItem } from "./db";
import { isCurrency, parseAmount } from "./money";
import { validateDebtRepaymentTerms, type DebtRepaymentTerms } from "./debt-installments";
import { FinancialRecoveryError, type FinancialCommand } from "./financial-command-journal";

export const revisionRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const minor = (value: unknown): value is number => integer(value) && value >= 0;
const id = (value: unknown): value is number => integer(value) && value > 0;
const nullableId = (value: unknown) => value === null || id(value);
function sameTerms(left:unknown,right:unknown,remaining:number):boolean {
  const a=validateDebtRepaymentTerms(left,remaining),b=validateDebtRepaymentTerms(right,remaining);
  return a.ok&&b.ok&&JSON.stringify(a.value)===JSON.stringify(b.value);
}
function invoiceValue(value: unknown): value is Invoice {
  return revisionRecord(value) && id(value.id) && id(value.patientId) && typeof value.invoiceNumber === "string" && !!value.invoiceNumber.trim()
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) && isCurrency(value.baseCurrency)
    && ["open","paid","cancelled"].includes(String(value.status)) && minor(value.totalMinor) && minor(value.discountMinor) && value.discountMinor <= value.totalMinor
    && Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 200
    && value.items.every(item => revisionRecord(item) && id(item.id) && nullableId(item.serviceId) && nullableId(item.doctorId)
      && typeof item.description === "string" && id(item.quantity) && minor(item.unitPriceMinor) && minor(item.totalMinor)
      && item.totalMinor === item.quantity * item.unitPriceMinor && nullableId(item.planItemId ?? null) && nullableId(item.caseId ?? null))
    && new Set(value.items.map(item=>item.id)).size === value.items.length
    && value.items.reduce((sum,item)=>sum+item.totalMinor,0) === value.totalMinor;
}
export interface InvoiceRevisionView {
  invoice: Invoice; sourceHash: string; settledMinor: number; remainingMinor: number; accountDueMinor: number;
  repaymentVersion: number; repaymentTerms: DebtRepaymentTerms;
  work: { id:number; clinical_locked:boolean; category?:string|null; case_site?:string|null }[];
  currencyCorrection?:{available:boolean;targetCurrency:"SAR";settledMinor:number;accountDueMinor:number;message:string};
  identityAmendmentAvailable?:boolean;
  identityCatalog?:{services:{id:number;name:string;category:string|null}[];doctors:{id:number;name:string}[]};
}
export function readInvoiceRevisionView(value: unknown, patientId: number, invoiceId: number): InvoiceRevisionView | null {
  if (!revisionRecord(value) || !invoiceValue(value.invoice) || value.invoice.patientId !== patientId || value.invoice.id !== invoiceId
    || typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash) || !integer(value.settledMinor)
    || !minor(value.remainingMinor) || !integer(value.accountDueMinor) || !minor(value.repaymentVersion)
    || !Array.isArray(value.work) || !value.work.every(row=>revisionRecord(row)&&id(row.id)&&typeof row.clinical_locked==="boolean")) return null;
  if(value.currencyCorrection!==undefined&&(!revisionRecord(value.currencyCorrection)||typeof value.currencyCorrection.available!=="boolean"||value.currencyCorrection.targetCurrency!=="SAR"||!integer(value.currencyCorrection.settledMinor)||!integer(value.currencyCorrection.accountDueMinor)||typeof value.currencyCorrection.message!=="string"))return null;
  if(value.identityAmendmentAvailable!==undefined&&typeof value.identityAmendmentAvailable!=="boolean")return null;
  if(value.identityCatalog!==undefined&&(!revisionRecord(value.identityCatalog)||!Array.isArray(value.identityCatalog.services)||!Array.isArray(value.identityCatalog.doctors)
    ||!value.identityCatalog.services.every(row=>revisionRecord(row)&&id(row.id)&&typeof row.name==="string"&&(row.category===null||typeof row.category==="string"))
    ||!value.identityCatalog.doctors.every(row=>revisionRecord(row)&&id(row.id)&&typeof row.name==="string")))return null;
  const terms=validateDebtRepaymentTerms(value.repaymentTerms,
    revisionRecord(value.repaymentTerms)&&Array.isArray(value.repaymentTerms.installments)
      ? value.repaymentTerms.installments.reduce((sum,row)=>sum+(revisionRecord(row)&&minor(row.amountMinor)?row.amountMinor:NaN),0) : NaN);
  if (!terms.ok || value.remainingMinor !== Math.max(0,value.invoice.totalMinor-value.invoice.discountMinor-value.settledMinor)) return null;
  return value as unknown as InvoiceRevisionView;
}
export interface InvoiceRevisionCommand {
  key:string; actor:string; patientId:number; invoiceId:number; body:string;
  expected:{ currency?:"YER"|"SAR"|"USD"; original:Invoice; lines:InvoiceItem[]; discountMinor:number; settledMinor:number; accountDueMinor:number; terms:DebtRepaymentTerms };
  outcome:"pending"|"uncertain"|"refused"; message:string;
}
export function durableInvoiceRevision(command:InvoiceRevisionCommand):FinancialCommand {
  const {key,actor,patientId,invoiceId,body,expected}=command;
  return {kind:"invoice-correction",key,original:JSON.stringify({key,actor,patientId,invoiceId,body,expected}),payload:JSON.stringify(command)};
}
export function restoreInvoiceRevision(command:FinancialCommand,patientId:number,actor:string):InvoiceRevisionCommand {
  const value:unknown=JSON.parse(command.payload);
  if (!revisionRecord(value) || command.kind!=="invoice-correction" || value.key!==command.key || value.actor!==actor || value.patientId!==patientId
    || !id(value.invoiceId) || typeof value.body!=="string" || !revisionRecord(value.expected) || !invoiceValue(value.expected.original)
    || value.expected.original.id!==value.invoiceId || value.expected.original.patientId!==patientId
    || !Array.isArray(value.expected.lines) || !minor(value.expected.discountMinor) || !integer(value.expected.settledMinor) || !integer(value.expected.accountDueMinor)) throw new FinancialRecoveryError("invalid");
  const body:unknown=JSON.parse(value.body);
  const currency=value.expected.currency??value.expected.original.baseCurrency;
  if(!isCurrency(currency)||currency!==value.expected.original.baseCurrency&&!(currency==="SAR"&&value.expected.original.baseCurrency==="YER"))throw new FinancialRecoveryError("invalid");
  if(!revisionRecord(body)||(body.currency??value.expected.original.baseCurrency)!==currency||body.idempotencyKey!==command.key||!Array.isArray(body.lines)||body.lines.length!==value.expected.lines.length
    ||parseAmount(String(body.discount),currency)!==value.expected.discountMinor)throw new FinancialRecoveryError("invalid");
  const original=value.expected.original,bodyLines=body.lines;
  if (!value.expected.lines.every((line,index)=>revisionRecord(line)&&original.items.some(item=>item.id===line.id)&&id(line.quantity)&&minor(line.unitPriceMinor)
    &&revisionRecord(bodyLines[index])&&bodyLines[index].itemId===line.id&&bodyLines[index].quantity===line.quantity
    &&parseAmount(String(bodyLines[index].unitPrice),currency)===line.unitPriceMinor
    &&["serviceId","doctorId","toothCode","surfaces"].every(key=>!Object.hasOwn(bodyLines[index],key)||bodyLines[index][key]===line[key]))) throw new FinancialRecoveryError("invalid");
  const restored=value as unknown as InvoiceRevisionCommand;
  const remaining=Math.max(0,restored.expected.lines.reduce((sum,item)=>sum+item.quantity*item.unitPriceMinor,0)-restored.expected.discountMinor-restored.expected.settledMinor);
  if(!sameTerms(restored.expected.terms,body.repaymentTerms,remaining)||body.expectedRemainingMinor!==remaining
    ||durableInvoiceRevision(restored).original!==command.original)throw new FinancialRecoveryError("invalid");
  return {...restored,outcome:"uncertain",message:"استُعيد طلب التصحيح السابق. أعد الطلب نفسه للتحقق من نتيجته قبل أي عملية جديدة."};
}
const sameLine=(line:InvoiceItem,expected:InvoiceItem)=>line.serviceId===expected.serviceId&&line.doctorId===expected.doctorId
  &&line.description===expected.description&&line.quantity===expected.quantity&&line.unitPriceMinor===expected.unitPriceMinor
  &&(line.planItemId??null)===(expected.planItemId??null)&&(line.caseId??null)===(expected.caseId??null)
  &&(line.toothCode??null)===(expected.toothCode??null)&&(line.surfaces??null)===(expected.surfaces??null);

/** Exact original intent, including immutable settlement, must match before clearing browser recovery. */
export function readInvoiceRevisionReceipt(value:unknown,command:InvoiceRevisionCommand):{corrected:Invoice;creditMinor:number}|null {
  const {expected}=command;const original=expected.original,currency=expected.currency??original.baseCurrency,changed=currency!==original.baseCurrency;
  const total=expected.lines.reduce((sum,item)=>sum+item.quantity*item.unitPriceMinor,0),after=total-expected.discountMinor;
  const before=original.totalMinor-original.discountMinor,remaining=Math.max(0,after-expected.settledMinor),due=expected.accountDueMinor+after-(changed?expected.settledMinor:before);
  if(!revisionRecord(value)||!invoiceValue(value.original)||!invoiceValue(value.corrected)||typeof value.replayed!=="boolean"
    ||value.patientId!==command.patientId||value.currency!==currency||value.createdBy!==command.actor||value.idempotencyKey!==command.key
    ||value.beforeMinor!==before||value.afterMinor!==after||value.settledMinor!==expected.settledMinor||value.remainingMinor!==remaining
    ||value.creditMinor!==Math.max(0,expected.settledMinor-after)||value.accountCreditMinor!==Math.max(0,-due)||value.accountDueMinor!==due
    ||value.original.id!==original.id||value.original.status!=="cancelled"||value.original.totalMinor!==original.totalMinor||value.original.discountMinor!==original.discountMinor
    ||value.original.patientId!==command.patientId||value.original.baseCurrency!==original.baseCurrency
    ||value.original.items.length!==original.items.length||!value.original.items.every((item,index)=>item.id===original.items[index].id&&sameLine(item,original.items[index]))
    ||value.corrected.id===original.id||value.corrected.patientId!==command.patientId||value.corrected.baseCurrency!==currency
    ||(!changed&&value.corrected.createdAt!==original.createdAt)||(changed&&(!id(value.reclassificationId)||value.originalCurrency!==original.baseCurrency))||value.corrected.totalMinor!==total||value.corrected.discountMinor!==expected.discountMinor
    ||value.corrected.status!==(remaining===0?"paid":"open")||value.corrected.items.length!==expected.lines.length
    ||!value.corrected.items.every((item,index)=>sameLine(item,expected.lines[index])))return null;
  if(remaining===0){if(value.repayment!==null)return null;}
  else {
    const repayment=value.repayment;
    if(!revisionRecord(repayment)||!id(repayment.arrangementId)||!id(repayment.revisionId)||repayment.version!==1||!revisionRecord(repayment.receipt))return null;
    const receipt=repayment.receipt;
    if(!revisionRecord(receipt.target)||receipt.target.patientId!==command.patientId||receipt.target.invoiceId!==value.corrected.id||receipt.target.openingCurrency!==null
      ||receipt.target.currency!==currency||receipt.createdBy!==command.actor||receipt.status!=="active"
      ||!sameTerms(receipt.terms,expected.terms,remaining))return null;
  }
  return {corrected:value.corrected,creditMinor:Math.max(0,expected.settledMinor-after)};
}
