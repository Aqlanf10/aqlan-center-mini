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
  projection:"ceph-summary"; patientId:number; analyses:CanonicalCephSummary[]; hasMore:boolean;
}
export function isCanonicalCephList(value:unknown,patientId:number):value is CanonicalCephList {
  if(!value||typeof value!=="object")return false;
  const v=value as CanonicalCephList;
  return v.projection==="ceph-summary"&&v.patientId===patientId&&typeof v.hasMore==="boolean"&&Array.isArray(v.analyses)&&v.analyses.length<=CEPH_SUMMARY_LIMIT
    &&v.analyses.every(a=>a&&Number.isSafeInteger(a.id)&&a.id>0&&a.patientId===patientId&&(a.status==="draft"||a.status==="completed")
      &&Object.hasOwn(CEPH_READ_PHASES,a.phase)&&(a.xrayDate===null||typeof a.xrayDate==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(a.xrayDate))
      &&typeof a.createdAt==="string"&&Number.isFinite(Date.parse(a.createdAt))&&(a.completedAt===null||typeof a.completedAt==="string"&&Number.isFinite(Date.parse(a.completedAt)))
      &&(a.imageState==="available"||a.imageState==="unavailable")&&(a.findings===null||a.status==="completed"&&typeof a.findings==="object"&&[a.findings.anb,a.findings.fma,a.findings.wits].every(n=>n===null||typeof n==="number"&&Number.isFinite(n))));
}
