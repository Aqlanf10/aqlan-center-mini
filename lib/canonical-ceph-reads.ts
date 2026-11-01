import "server-only";
import { CanonicalPatientReadRefusal,readCanonicalPatientRecord } from "./canonical-patient-reads";
import type { CanonicalSnapshotQuery } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { CEPH_READ_PHASES,CEPH_SUMMARY_LIMIT,type CanonicalCephList,type CanonicalCephSummary,type CephReadPhase } from "./canonical-ceph-projection";

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
  return {projection:"ceph-summary",patientId,analyses,hasMore:rows.length>CEPH_SUMMARY_LIMIT};
}
export function readCanonicalCephList(session:VerifiedDurableSession,patientId:number) {
  return readCanonicalPatientRecord(session,"read:ceph.list",patientId,q=>readCephSummariesWith(q,patientId),1024*1024);
}
