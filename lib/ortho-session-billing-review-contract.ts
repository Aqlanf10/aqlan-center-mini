import type {BillingClassification} from './billing-classification';
export type SessionBillingInvoice = {state:'none'|'restricted'|'missing'} | {state:'current'|'cancelled';id:number;number:string};
export interface SessionBillingEntry {id:number;doneOn:string;recordedClass:BillingClassification|null;decision:'billed'|'no_charge'|null;reason:string|null;reasonRestricted:boolean;decidedBy:string|null;decidedAt:string|null;invoice:SessionBillingInvoice}
export interface SessionBillingReview {patientId:number;orthoCaseId:number;actorId:number;generatedAt:string;access:'clinical'|'financial'|'clinical_financial';entries:SessionBillingEntry[]}
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0;
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const keys=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.hasOwn(v,k));
const text=(v:unknown,max:number)=>v===null||typeof v==='string'&&v.length<=max;
const stamp=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function invalid():never{throw new Error('Invalid session billing review');}
/** Exact allowlisted, role-projected current records. Never a payment or coverage calculation. */
export function readSessionBillingReview(raw:unknown,expected:{patientId:number;orthoCaseId:number;actorId:number;access:SessionBillingReview['access']}):SessionBillingReview{
 if(!object(raw)||!keys(raw,['patientId','orthoCaseId','actorId','generatedAt','access','entries'])||!positive(raw.patientId)||!positive(raw.orthoCaseId)||!positive(raw.actorId)||raw.patientId!==expected.patientId||raw.orthoCaseId!==expected.orthoCaseId||raw.actorId!==expected.actorId||raw.access!==expected.access||!stamp(raw.generatedAt)||!['clinical','financial','clinical_financial'].includes(String(raw.access))||!Array.isArray(raw.entries)||raw.entries.length>1000)invalid();
 const ids=new Set<number>();let previous='';
 for(const row of raw.entries){
  if(!object(row)||!keys(row,['id','doneOn','recordedClass','decision','reason','reasonRestricted','decidedBy','decidedAt','invoice'])||!positive(row.id)||ids.has(row.id)||typeof row.doneOn!=='string'||!/^\d{4}-\d\d-\d\d$/.test(row.doneOn)||!Number.isFinite(Date.parse(row.doneOn))||new Date(row.doneOn).toISOString().slice(0,10)!==row.doneOn||row.recordedClass!==null&&!['INCLUDED','LEGACY_INCLUDED','NEW_BILLABLE','OUTSIDE_CONTRACT','NO_CHARGE'].includes(String(row.recordedClass))||row.decision!==null&&!['billed','no_charge'].includes(String(row.decision))||!text(row.reason,4000)||typeof row.reasonRestricted!=='boolean'||!text(row.decidedBy,200)||row.decidedAt!==null&&!stamp(row.decidedAt)||!object(row.invoice))invalid();
  const order=`${row.doneOn}:${String(row.id).padStart(16,'0')}`;if(order<previous)invalid();previous=order;ids.add(row.id);
  const inv=row.invoice;
  if(inv.state==='current'||inv.state==='cancelled'){if(!keys(inv,['state','id','number'])||!positive(inv.id)||typeof inv.number!=='string'||!inv.number.trim()||inv.number.length>200||raw.access==='clinical')invalid();}
  else if(!['none','restricted','missing'].includes(String(inv.state))||!keys(inv,['state']))invalid();
  if(raw.access==='clinical'&&inv.state!=='restricted'||raw.access!=='clinical'&&inv.state==='restricted'||row.reasonRestricted&&row.reason!==null||raw.access==='financial'&&!row.reasonRestricted||raw.access!=='financial'&&row.reasonRestricted)invalid();
 }
 if(new TextEncoder().encode(JSON.stringify(raw)).length>2097152)invalid();
 return raw as unknown as SessionBillingReview;
}
