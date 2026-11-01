import { cephDraftVersionWith } from "./canonical-ceph-draft-version";
import "server-only";
import { CLINIC_TIME_ZONE, patientInDoctorScopeWith } from "./db";
import { runCanonicalReadSnapshot,type CanonicalSnapshotScope } from "./canonical-read-snapshot";
import { CanonicalPatientReadRefusal,readCanonicalPatientRecord } from "./canonical-patient-reads";
import type { CanonicalSnapshotQuery } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { CEPH_READ_PHASES,CEPH_SUMMARY_LIMIT,type CanonicalCephStudy,type CanonicalCephList,type CanonicalCephSummary,type CephReadPhase } from "./canonical-ceph-projection";

export class CanonicalCephReadRefusal extends Error {
  constructor(readonly code:"ceph_reference_unavailable"|"ceph_stored_data_invalid"|"ceph_read_limit",message:string) {super(message);this.name="CanonicalCephReadRefusal";}
}
export function canonicalCephReadId(raw:string,params:URLSearchParams,patient=false) {
  if(!/^[1-9]\d*$/.test(raw)||!Number.isSafeInteger(Number(raw))||(patient&&Number(raw)>2147483647)||[...params.keys()].length) {
    throw new CanonicalPatientReadRefusal("invalid_patient_query","رقم السجل أو طلب السيفالومتري غير صالح.");
  }
  return Number(raw);
}
interface SummaryRow {
  id:number|string; patient_id:number; status:string; phase:string; xray_date:string|null; created_at:Date; completed_at:Date|null;
  doc_patient_id:number|null; doc_removed_at:Date|null; doc_mime:string|null; ortho_case_id:number|null; ortho_patient_id:number|null;
}
function projectSummary(row:SummaryRow):CanonicalCephSummary {
  if(row.doc_patient_id!==row.patient_id||row.ortho_case_id!==null&&row.ortho_patient_id!==row.patient_id) {
    throw new CanonicalCephReadRefusal("ceph_reference_unavailable","تعذّر التحقق من ملكية مراجع الدراسة؛ لم يُعتبر السجل فارغًا.");
  }
  if(!Number.isSafeInteger(Number(row.id))||Number(row.id)<=0||(row.status!=="draft"&&row.status!=="completed")||!Object.hasOwn(CEPH_READ_PHASES,row.phase)) {
    throw new CanonicalCephReadRefusal("ceph_stored_data_invalid","تعذّر التحقق من بيانات الدراسة المحفوظة.");
  }
  return {id:Number(row.id),patientId:row.patient_id,status:row.status,phase:row.phase as CephReadPhase,xrayDate:row.xray_date,
    createdAt:row.created_at.toISOString(),completedAt:row.completed_at?.toISOString()??null,
    imageState:row.doc_removed_at===null&&row.doc_mime?.startsWith("image/")?"available":"unavailable",findings:null};
}
export async function readCephSummariesWith(q:CanonicalSnapshotQuery,patientId:number):Promise<CanonicalCephList> {
  const rows=(await q.query<SummaryRow>(`SELECT a.id,a.patient_id,a.status,a.phase,a.xray_date::text AS xray_date,a.created_at,a.completed_at,
    d.patient_id AS doc_patient_id,d.removed_at AS doc_removed_at,d.mime_type AS doc_mime,a.ortho_case_id,o.patient_id AS ortho_patient_id
    FROM ceph_analyses a LEFT JOIN patient_documents d ON d.id=a.document_id LEFT JOIN ortho_cases o ON o.id=a.ortho_case_id
    WHERE a.patient_id=$1 AND a.status<>'discarded' ORDER BY (a.status='draft') DESC,a.created_at DESC,a.id DESC LIMIT $2`,[patientId,CEPH_SUMMARY_LIMIT+1])).rows;
  const analyses=rows.slice(0,CEPH_SUMMARY_LIMIT).map(projectSummary);
  const completed=analyses.filter(a=>a.status==="completed");
  if(completed.length) {
    const values=(await q.query<{analysis_id:number|string;code:string;value:number}>("SELECT analysis_id,code,value FROM ceph_measurements WHERE analysis_id=ANY($1::bigint[]) AND code IN ('ANB','FMA','WITS')",[completed.map(a=>a.id)])).rows;
    if(values.some(v=>!Number.isFinite(v.value)))throw new CanonicalCephReadRefusal("ceph_stored_data_invalid","قياس محفوظ غير صالح؛ لم يُستبدل بحساب جديد.");
    for(const analysis of completed) {
      const own=values.filter(v=>Number(v.analysis_id)===analysis.id);
      if(own.length)analysis.findings={anb:own.find(v=>v.code==="ANB")?.value??null,fma:own.find(v=>v.code==="FMA")?.value??null,wits:own.find(v=>v.code==="WITS")?.value??null};
    }
  }
  return {projection:"ceph-summary",clinicTimeZone:CLINIC_TIME_ZONE,patientId,analyses,hasMore:rows.length>CEPH_SUMMARY_LIMIT};
}
export function readCanonicalCephList(session:VerifiedDurableSession,patientId:number) {
  return readCanonicalPatientRecord(session,"read:ceph.list",patientId,q=>readCephSummariesWith(q,patientId),1024*1024);
}

const STUDY_MAX_ROWS=256,STUDY_MAX_BYTES=2*1024*1024;
interface StudyRow extends SummaryRow {
  device:string|null;ref_set:string;note:string|null;created_by:string;completed_by:string|null;
  cal_x1:number|null;cal_y1:number|null;cal_x2:number|null;cal_y2:number|null;cal_mm:number|null;mm_per_pixel:number|null;
}
/** Saved database facts only; no compute/diagnosis/reference engine, image reader or legacy schema initialization. */
export async function readCephStudyWith(q:CanonicalSnapshotQuery,scope:CanonicalSnapshotScope,studyId:number):Promise<CanonicalCephStudy> {
  const owner=(await q.query<{patient_id:number}>("SELECT a.patient_id FROM ceph_analyses a JOIN patients p ON p.id=a.patient_id WHERE a.id=$1 AND a.status<>'discarded'",[studyId])).rows[0];
  if(!owner||scope.patientScope.kind==="own"&&!await patientInDoctorScopeWith(q,scope.patientScope.clinicianPartyId,owner.patient_id))throw new CanonicalPatientReadRefusal("patient_not_found","الدراسة غير موجودة ضمن مرضاك.");
  // Reject oversized stored records before materializing notes or unbounded tables.
  const budget=(await q.query<{landmarks:string;measurements:string;bytes:string}>(`SELECT
    (SELECT count(*)::text FROM ceph_landmarks WHERE analysis_id=$1) AS landmarks,
    (SELECT count(*)::text FROM ceph_measurements WHERE analysis_id=$1) AS measurements,
    (octet_length(to_jsonb(a)::text)
      +COALESCE((SELECT sum(octet_length(to_jsonb(l)::text)) FROM ceph_landmarks l WHERE analysis_id=$1),0)
      +COALESCE((SELECT sum(octet_length(to_jsonb(m)::text)) FROM ceph_measurements m WHERE analysis_id=$1),0)
      +COALESCE((SELECT sum(octet_length(to_jsonb(d)::text)) FROM ceph_diagnoses d WHERE analysis_id=$1),0))::text AS bytes
    FROM ceph_analyses a WHERE a.id=$1`,[studyId])).rows[0];
  if(!budget||Number(budget.landmarks)>STUDY_MAX_ROWS||Number(budget.measurements)>STUDY_MAX_ROWS||Number(budget.bytes)>STUDY_MAX_BYTES)throw new CanonicalCephReadRefusal("ceph_read_limit","الدراسة تتجاوز حد القراءة الآمنة؛ لم تُختصر النتائج.");
  const row=(await q.query<StudyRow>(`SELECT a.id,a.patient_id,a.status,a.phase,a.xray_date::text AS xray_date,a.created_at,a.completed_at,
    d.patient_id AS doc_patient_id,d.removed_at AS doc_removed_at,d.mime_type AS doc_mime,a.ortho_case_id,o.patient_id AS ortho_patient_id,
    a.device,a.ref_set,a.note,a.created_by,a.completed_by,a.cal_x1,a.cal_y1,a.cal_x2,a.cal_y2,a.cal_mm,a.mm_per_pixel
    FROM ceph_analyses a LEFT JOIN patient_documents d ON d.id=a.document_id LEFT JOIN ortho_cases o ON o.id=a.ortho_case_id WHERE a.id=$1`,[studyId])).rows[0];
  if(!row)throw new CanonicalCephReadRefusal("ceph_stored_data_invalid","تعذّر التحقق من الدراسة المحفوظة.");
  const analysis=projectSummary(row);
  const calibrationValues=[row.cal_x1,row.cal_y1,row.cal_x2,row.cal_y2,row.cal_mm];
  const present=calibrationValues.filter(n=>n!==null).length;
  if((present!==0&&present!==5)||calibrationValues.some(n=>n!==null&&!Number.isFinite(n))||(row.cal_mm!==null&&row.cal_mm<=0)||(row.mm_per_pixel!==null&&(!Number.isFinite(row.mm_per_pixel)||row.mm_per_pixel<=0)))throw new CanonicalCephReadRefusal("ceph_stored_data_invalid","بيانات معايرة محفوظة غير صالحة؛ لم تُحسب معايرة بديلة.");
  const landmarks=(await q.query<{code:string;x:number;y:number;source:"manual"|"suggested";confirmed_by:string}>("SELECT code,x,y,source,confirmed_by FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY confirmed_at,id",[studyId])).rows.map(p=>({code:p.code,x:p.x,y:p.y,source:p.source,confirmedBy:p.confirmed_by}));
  const measurements=(await q.query<{code:string;value:number}>("SELECT code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY id",[studyId])).rows;
  // Unknown historical codes are preserved literally. No current engine drops or rewrites them.
  if(landmarks.some(p=>!p.code.length||p.code.length>100||!Number.isFinite(p.x)||!Number.isFinite(p.y))||measurements.some(m=>!m.code.length||m.code.length>100||!Number.isFinite(m.value)))throw new CanonicalCephReadRefusal("ceph_stored_data_invalid","قياس أو معلم محفوظ غير صالح؛ لم تُعد كتابة النتائج.");
  const diagnosis=(await q.query<{skeletal:string|null;dental:string|null;soft_tissue:string|null;note:string|null;final_dx:string;created_by:string;updated_at:Date}>("SELECT skeletal,dental,soft_tissue,note,final_dx,created_by,updated_at FROM ceph_diagnoses WHERE analysis_id=$1",[studyId])).rows[0];
  if(analysis.status==="completed"&&measurements.some(m=>["ANB","FMA","WITS"].includes(m.code)))analysis.findings={anb:measurements.find(m=>m.code==="ANB")?.value??null,fma:measurements.find(m=>m.code==="FMA")?.value??null,wits:measurements.find(m=>m.code==="WITS")?.value??null};
  return {projection:"ceph-saved-study",clinicTimeZone:CLINIC_TIME_ZONE,...(analysis.status==="draft"?{discardVersion:await cephDraftVersionWith(q,studyId)}:{}),analysis:{...analysis,device:row.device,refSet:row.ref_set,note:row.note,createdBy:row.created_by,completedBy:row.completed_by,
    calibration:present===5?{x1:row.cal_x1!,y1:row.cal_y1!,x2:row.cal_x2!,y2:row.cal_y2!,mm:row.cal_mm!}:null,mmPerPixel:row.mm_per_pixel},
    measurementsState:analysis.status==="completed"?"saved-approved":"saved-unapproved",landmarks,measurements,
    diagnosis:diagnosis?{skeletal:diagnosis.skeletal,dental:diagnosis.dental,softTissue:diagnosis.soft_tissue,note:diagnosis.note,finalDx:diagnosis.final_dx,createdBy:diagnosis.created_by,updatedAt:diagnosis.updated_at.toISOString()}:null};
}
export function readCanonicalCephStudy(session:VerifiedDurableSession,studyId:number) {
  return runCanonicalReadSnapshot(session,"read:ceph.study",(q,scope)=>readCephStudyWith(q,scope,studyId),{errorPrefix:"STAFF_READ",maxBytes:STUDY_MAX_BYTES});
}
