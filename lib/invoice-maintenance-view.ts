import { FinancialRecoveryError, type FinancialCommand } from "./financial-command-journal";
import type { InvoiceArchiveView, InvoiceArchiveReceipt } from "./invoice-archive";
import { isCurrency, parseAmount, type Currency } from "./money";

export const maintenanceRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
const minor = (value: unknown): value is number => integer(value) && value >= 0;
const id = (value: unknown): value is number => integer(value) && value > 0;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const ids = (value: unknown): value is number[] => Array.isArray(value) && value.every(id) && new Set(value).size === value.length;
const sameIds = (left: unknown, right: number[]) => ids(left) && left.length === right.length && left.every((entry, index) => entry === right[index]);

type ArchiveExpected = {kind:"archive"; currency:Currency; invoiceNumber:string; action:"archive"|"restore"; expectedVersion:number; reason:string};
type AddExpected = {kind:"add-service"; currency:Currency; invoiceNumber:string; addedNetMinor:number; requestHash:string; sourceVisitIds:number[]};
export interface InvoiceMaintenanceCommand {
  operation:"archive"|"add-service"; key:string; actor:string; patientId:number; invoiceId:number; body:string;
  expected:ArchiveExpected|AddExpected;
  outcome:"pending"|"uncertain"; message:string;
}
export function durableInvoiceMaintenance(command:InvoiceMaintenanceCommand):FinancialCommand {
  const {operation,key,actor,patientId,invoiceId,body,expected}=command;
  return {kind:"invoice-maintenance",key,original:JSON.stringify({operation,key,actor,patientId,invoiceId,body,expected}),payload:JSON.stringify(command)};
}
export function restoreInvoiceMaintenance(command:FinancialCommand,patientId:number,actor:string):InvoiceMaintenanceCommand {
  try {
    const value:unknown=JSON.parse(command.payload);
    if(!maintenanceRecord(value)||command.kind!=="invoice-maintenance"||value.key!==command.key||value.actor!==actor||value.patientId!==patientId
      ||!id(value.invoiceId)||typeof value.body!=="string"||!maintenanceRecord(value.expected)||!isCurrency(value.expected.currency)||!text(value.expected.invoiceNumber)
      ||value.operation!==value.expected.kind)throw new Error("invalid");
    const body:unknown=JSON.parse(value.body),expected=value.expected;
    if(!isCurrency(expected.currency))throw new Error("invalid");
    if(!maintenanceRecord(body)||body.idempotencyKey!==command.key||!text(body.reason))throw new Error("invalid");
    if(value.operation==="archive"){
      if(!["archive","restore"].includes(String(expected.action))||!minor(expected.expectedVersion)||!text(expected.reason)
        ||body.action!==expected.action||body.expectedVersion!==expected.expectedVersion||body.reason!==expected.reason)throw new Error("invalid");
    } else if(value.operation==="add-service") {
      if(!hash(expected.requestHash)||!hash(body.expectedSourceHash)||!id(body.serviceId)||!ids(expected.sourceVisitIds)||!id(expected.addedNetMinor)
        ||body.currency!==expected.currency||typeof body.price!=="string"||typeof body.discount!=="string")throw new Error("invalid");
      const price=parseAmount(body.price,expected.currency),discount=parseAmount(body.discount,expected.currency);
      if(price===null||discount===null||price-discount!==expected.addedNetMinor)throw new Error("invalid");
    } else throw new Error("invalid");
    const restored=value as unknown as InvoiceMaintenanceCommand;
    if(durableInvoiceMaintenance(restored).original!==command.original)throw new Error("invalid");
    return {...restored,outcome:"uncertain",message:"استُعيد الطلب السابق. أعد الطلب نفسه للتحقق من نتيجته قبل بدء عملية جديدة."};
  }catch{throw new FinancialRecoveryError("invalid");}
}
function archiveEvent(value:unknown):value is InvoiceArchiveReceipt {
  return maintenanceRecord(value)&&typeof value.eventId==="string"&&/^[1-9]\d*$/.test(value.eventId)&&id(value.invoiceId)&&id(value.patientId)
    &&text(value.invoiceNumber)&&date(value.invoiceCreatedAt)&&isCurrency(value.currency)&&id(value.version)
    &&(value.action==="archive"||value.action==="restore")&&value.archived===(value.action==="archive")
    &&text(value.reason)&&text(value.idempotencyKey)&&id(value.actorUserId)&&text(value.actor)&&date(value.at);
}
export function readInvoiceArchiveView(value:unknown,patientId:number,invoiceId?:number):InvoiceArchiveView|null {
  if(!maintenanceRecord(value)||!id(value.invoiceId)||value.patientId!==patientId||invoiceId!==undefined&&value.invoiceId!==invoiceId
    ||!text(value.invoiceNumber)||!isCurrency(value.currency)||!["open","paid","cancelled"].includes(String(value.status))||!minor(value.version)
    ||typeof value.archived!=="boolean"||!["ready","migration_pending"].includes(String(value.readiness))||!maintenanceRecord(value.eligibility))return null;
  const eligibility=value.eligibility;
  if(typeof eligibility.canArchive!=="boolean"||![null,"policy_decision_required","period_locked","migration_pending"].includes(eligibility.code as string|null)
    ||eligibility.message!==null&&typeof eligibility.message!=="string"||eligibility.remainingMinor!==null&&!minor(eligibility.remainingMinor))return null;
  if(value.latest!==null&&(!archiveEvent(value.latest)||value.latest.invoiceId!==value.invoiceId||value.latest.patientId!==patientId
    ||value.latest.version!==value.version||value.latest.archived!==value.archived))return null;
  if(value.readiness==="migration_pending"&&(eligibility.canArchive||eligibility.code!=="migration_pending"))return null;
  return value as unknown as InvoiceArchiveView;
}
export type InvoiceMaintenanceSuccess = {invoiceId:number;invoiceNumber:string;createdAt:string;archived?:boolean;version?:number};
export function readInvoiceMaintenanceReceipt(value:unknown,command:InvoiceMaintenanceCommand):InvoiceMaintenanceSuccess|null {
  if(!maintenanceRecord(value)||typeof value.replayed!=="boolean")return null;
  const expected=command.expected;
  if(expected.kind==="add-service") {
    if(value.originalInvoiceId!==command.invoiceId||!id(value.additionalInvoiceId)||value.additionalInvoiceId===command.invoiceId||!text(value.additionalInvoiceNumber)
      ||!date(value.additionalCreatedAt)||value.patientId!==command.patientId||value.currency!==expected.currency||value.addedNetMinor!==expected.addedNetMinor
      ||!sameIds(value.sourceVisitIds,expected.sourceVisitIds)||value.idempotencyKey!==command.key||value.requestHash!==expected.requestHash
      ||value.createdBy!==command.actor||value.cashMovementMinor!==0||!maintenanceRecord(value.clinical)
      ||value.clinical.planId!==null&&!id(value.clinical.planId)||!Array.isArray(value.clinical.links)||value.clinical.links.length!==1
      ||!value.clinical.links.every(link=>maintenanceRecord(link)&&link.line===0&&["clinical","financial"].includes(String(link.kind))
        &&(link.planItemId===null||id(link.planItemId))&&(link.caseId===null||id(link.caseId))))return null;
    return {invoiceId:value.additionalInvoiceId,invoiceNumber:value.additionalInvoiceNumber,createdAt:value.additionalCreatedAt};
  }
  const current=readInvoiceArchiveView(value.current,command.patientId,command.invoiceId),ack=value.acknowledgment;
  if(!current||current.readiness!=="ready"||typeof value.noop!=="boolean"||!maintenanceRecord(ack)||ack.idempotencyKey!==command.key||ack.actor!==command.actor
    ||ack.invoiceId!==command.invoiceId||ack.patientId!==command.patientId||ack.action!==expected.action||ack.expectedVersion!==expected.expectedVersion
    ||current.currency!==expected.currency||current.invoiceNumber!==expected.invoiceNumber)return null;
  if(value.noop){
    if(value.replayed||current.version!==expected.expectedVersion||current.archived!==(expected.action==="archive"))return null;
    return {invoiceId:command.invoiceId,invoiceNumber:current.invoiceNumber,createdAt:"",archived:current.archived,version:current.version};
  }
  const event=value.receipt;
  if(!archiveEvent(event)||event.invoiceId!==command.invoiceId||event.patientId!==command.patientId||event.actor!==command.actor||event.idempotencyKey!==command.key
    ||event.action!==expected.action||event.reason!==expected.reason||event.version!==expected.expectedVersion+1||event.currency!==expected.currency
    ||event.invoiceNumber!==expected.invoiceNumber||current.version<event.version||!value.replayed&&(current.version!==event.version||current.archived!==event.archived))return null;
  return {invoiceId:command.invoiceId,invoiceNumber:current.invoiceNumber,createdAt:event.at,archived:current.archived,version:current.version};
}
export function readInvoiceMaintenanceRejection(value:unknown,command:InvoiceMaintenanceCommand):string|null {
  if(!maintenanceRecord(value)||value.code!=="stale"||!text(value.message))return null;
  const expected=command.expected;
  if(expected.kind==="add-service")return value.terminal===true&&value.idempotencyKey===command.key&&value.requestHash===expected.requestHash?value.message:null;
  const refusal=value.refusal;
  return maintenanceRecord(refusal)&&refusal.kind==="version_advanced"&&refusal.invoiceId===command.invoiceId&&refusal.patientId===command.patientId
    &&refusal.actor===command.actor&&refusal.idempotencyKey===command.key&&refusal.action===expected.action&&refusal.reason===expected.reason
    &&refusal.expectedVersion===expected.expectedVersion&&integer(refusal.currentVersion)&&refusal.currentVersion>expected.expectedVersion?value.message:null;
}
