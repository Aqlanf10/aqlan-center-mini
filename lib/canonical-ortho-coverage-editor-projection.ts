import type { FollowupCoverageRead, FollowupSourceChoice } from "./ortho-followup-coverage";
export type CoverageEditorRead = Omit<FollowupCoverageRead,"current"> & {
 current: null | Pick<NonNullable<FollowupCoverageRead["current"]>,"id"|"version"|"decision"|"reason"|"createdAt"|"createdBy">;
};
export interface CanonicalCoverageEditor extends CoverageEditorRead { projection:"ortho-followup-coverage-editor" }
const record=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==="object"&&!Array.isArray(v);
const exact=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const positive=(v:unknown)=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
/** Exact allowlist for the explicit source picker; no raw source snapshot,
 * amounts, clinical notes, historical command IDs or inferred grants. */
export function isCanonicalCoverageEditor(value:unknown,patientId:number,caseId:number):value is CanonicalCoverageEditor{
 if(!record(value)||!exact(value,["projection","patientId","orthoCaseId","enabled","canEdit","current","applicable","sources"])
  ||value.projection!=="ortho-followup-coverage-editor"||value.patientId!==patientId||value.orthoCaseId!==caseId
  ||typeof value.enabled!=="boolean"||typeof value.canEdit!=="boolean"||typeof value.applicable!=="boolean"||!Array.isArray(value.sources)||value.sources.length>256)return false;
 const h=value.current;
 if(h!==null&&(!record(h)||!exact(h,["id","version","decision","reason","createdAt","createdBy"])
  ||typeof h.id!=="string"||!/^[1-9]\d{0,18}$/.test(h.id)||!positive(h.version)||typeof h.decision!=="string"||!['included','excluded'].includes(h.decision)
  ||typeof h.reason!=="string"||h.reason.length>600||typeof h.createdBy!=="string"||h.createdBy.length>1000
  ||typeof h.createdAt!=="string"||!Number.isFinite(Date.parse(h.createdAt))))return false;
 if(!value.enabled&&(value.current!==null||value.applicable||value.canEdit||value.sources.length)||value.current===null&&value.applicable)return false;
 const seen=new Set<string>();return value.sources.every((s:unknown)=>{
  if(!record(s)||!exact(s,["patientId","orthoCaseId","clinicalCaseId","planId","planItemId","invoiceId","fingerprint","invoiceNumber","serviceName"])
   ||s.patientId!==patientId||s.orthoCaseId!==caseId||![s.clinicalCaseId,s.planId,s.planItemId,s.invoiceId].every(positive)
   ||typeof s.fingerprint!=="string"||!/^[0-9a-f]{64}$/.test(s.fingerprint)||typeof s.invoiceNumber!=="string"||s.invoiceNumber.length>8000||typeof s.serviceName!=="string"||s.serviceName.length>8000)return false;
  const key=`${s.planItemId}:${s.invoiceId}`;if(seen.has(key))return false;seen.add(key);return true;
 });
}
export function projectCoverageSource(s:FollowupSourceChoice):FollowupSourceChoice{
 return {patientId:s.patientId,orthoCaseId:s.orthoCaseId,clinicalCaseId:s.clinicalCaseId,planId:s.planId,planItemId:s.planItemId,invoiceId:s.invoiceId,fingerprint:s.fingerprint,invoiceNumber:s.invoiceNumber,serviceName:s.serviceName};
}
