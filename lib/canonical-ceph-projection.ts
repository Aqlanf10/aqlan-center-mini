import { isKnownZone } from "./clinicZone";
/** Saved cephalometric projection. No tracing engine, financial or image payload. */
export const CEPH_SUMMARY_LIMIT = 300;
export const CEPH_READ_PHASES = {pretreatment:"قبل العلاج",during:"أثناء العلاج",posttreatment:"بعد العلاج",followup:"متابعة"} as const;
export type CephReadPhase = keyof typeof CEPH_READ_PHASES;
export interface CanonicalCephSummary {
  id:number; patientId:number; status:"draft"|"completed"; phase:CephReadPhase;
  xrayDate:string|null; createdAt:string; completedAt:string|null;
  imageState:"available"|"unavailable";
  findings:{anb:number|null;fma:number|null;wits:number|null}|null;
}
export interface CanonicalCephList {
  projection:"ceph-summary"; clinicTimeZone:string; patientId:number; analyses:CanonicalCephSummary[]; hasMore:boolean;
}
export function isCanonicalCephList(value:unknown,patientId:number):value is CanonicalCephList {
  if(!value||typeof value!=="object")return false;
  const v=value as CanonicalCephList;
  return typeof v.clinicTimeZone==="string"&&isKnownZone(v.clinicTimeZone)&&v.projection==="ceph-summary"&&v.patientId===patientId&&typeof v.hasMore==="boolean"&&Array.isArray(v.analyses)&&v.analyses.length<=CEPH_SUMMARY_LIMIT
    &&v.analyses.every(a=>a&&Number.isSafeInteger(a.id)&&a.id>0&&a.patientId===patientId&&(a.status==="draft"||a.status==="completed")
      &&Object.hasOwn(CEPH_READ_PHASES,a.phase)&&(a.xrayDate===null||typeof a.xrayDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(a.xrayDate))
      &&typeof a.createdAt==="string"&&Number.isFinite(Date.parse(a.createdAt))&&(a.completedAt===null||typeof a.completedAt==="string"&&Number.isFinite(Date.parse(a.completedAt)))
      &&(a.imageState==="available"||a.imageState==="unavailable")&&(a.findings===null||a.status==="completed"&&typeof a.findings==="object"&&[a.findings.anb,a.findings.fma,a.findings.wits].every(n=>n===null||typeof n==="number"&&Number.isFinite(n))));
}

export interface CanonicalCephStudy {
  projection:"ceph-saved-study";
  clinicTimeZone:string;
  /** Absent in older read-only payloads; commands require a fresh observed draft token. */
  discardVersion?:string|null;
  analysis:CanonicalCephSummary & {
    device:string|null;refSet:string;note:string|null;createdBy:string;completedBy:string|null;
    calibration:{x1:number;y1:number;x2:number;y2:number;mm:number}|null;mmPerPixel:number|null;
  };
  measurementsState:"saved-approved"|"saved-unapproved";
  landmarks:{code:string;x:number;y:number;source:"manual"|"suggested";confirmedBy:string}[];
  measurements:{code:string;value:number}[];
  diagnosis:{skeletal:string|null;dental:string|null;softTissue:string|null;note:string|null;finalDx:string;createdBy:string;updatedAt:string}|null;
  /** Drafts: fingerprint of the reviewed snapshot and its image/reference sources, sent back on completion.
   * Only a fingerprint: staging's identity carries internal image identifiers this read never discloses. */
  completionSources?:CephReviewFingerprint;
  /** Completed studies: fingerprint of staging's correction-source token, sent back to open a correction copy. */
  correctionSource?:CephReviewFingerprint;
}
export type CephReviewFingerprint={state:"available";fingerprint:string}|{state:"unavailable";reason:string};
const textOrNull=(v:unknown)=>v===null||typeof v==="string";
const isReviewFingerprint=(v:unknown):v is CephReviewFingerprint=>!!v&&typeof v==="object"&&!Array.isArray(v)&&(
  (v as {state?:unknown}).state==="available"?Object.keys(v).length===2&&typeof (v as {fingerprint?:unknown}).fingerprint==="string"&&/^[a-f0-9]{64}$/.test((v as {fingerprint:string}).fingerprint)
  :(v as {state?:unknown}).state==="unavailable"&&Object.keys(v).length===2&&typeof (v as {reason?:unknown}).reason==="string");
export function isCanonicalCephStudy(value:unknown,patientId:number,studyId:number):value is CanonicalCephStudy {
  if(!value||typeof value!=="object")return false;
  const v=value as CanonicalCephStudy,a=v.analysis;
  if(v.projection!=="ceph-saved-study"||!a||a.id!==studyId||!isCanonicalCephList({projection:"ceph-summary",clinicTimeZone:v.clinicTimeZone,patientId,hasMore:false,analyses:[a]},patientId))return false;
  if(!textOrNull(a.device)||!textOrNull(a.note)||!textOrNull(a.completedBy)||typeof a.refSet!=="string"||typeof a.createdBy!=="string")return false;
  if(a.mmPerPixel!==null&&(!Number.isFinite(a.mmPerPixel)||a.mmPerPixel<=0))return false;
  if(a.calibration!==null&&(!a.calibration||![a.calibration.x1,a.calibration.y1,a.calibration.x2,a.calibration.y2,a.calibration.mm].every(n=>typeof n==="number"&&Number.isFinite(n))||a.calibration.mm<=0))return false;
  if(v.discardVersion!==undefined&&v.discardVersion!==null&&(a.status!=="draft"||typeof v.discardVersion!=="string"||!/^[a-f0-9]{64}$/.test(v.discardVersion)))return false;
  if(v.measurementsState!==(a.status==="completed"?"saved-approved":"saved-unapproved"))return false;
  if(!Array.isArray(v.landmarks)||v.landmarks.length>256||v.landmarks.some(p=>!p||typeof p.code!=="string"||!p.code.length||p.code.length>100||!Number.isFinite(p.x)||!Number.isFinite(p.y)||(p.source!=="manual"&&p.source!=="suggested")||typeof p.confirmedBy!=="string"))return false;
  if(!Array.isArray(v.measurements)||v.measurements.length>256||v.measurements.some(m=>!m||typeof m.code!=="string"||!m.code.length||m.code.length>100||!Number.isFinite(m.value)))return false;
  if(v.diagnosis!==null){const d=v.diagnosis;if(!d||![d.skeletal,d.dental,d.softTissue,d.note].every(textOrNull)||typeof d.finalDx!=="string"||typeof d.createdBy!=="string"||typeof d.updatedAt!=="string"||!Number.isFinite(Date.parse(d.updatedAt)))return false;}
  if(v.completionSources!==undefined&&(a.status!=="draft"||!isReviewFingerprint(v.completionSources)))return false;
  if(v.correctionSource!==undefined&&(a.status!=="completed"||!isReviewFingerprint(v.correctionSource)))return false;
  return true;
}
/** The reviewed completion fingerprint of an observed draft; null when the sources cannot be proved. */
export function cephCompletionFingerprintFromStudy(feed:CanonicalCephStudy):string|null{
  return feed.analysis.status==="draft"&&feed.completionSources?.state==="available"?feed.completionSources.fingerprint:null;
}
