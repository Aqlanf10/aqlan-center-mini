import "server-only";
import { CanonicalPatientReadRefusal, readCanonicalPatientRecord } from "./canonical-patient-reads";
import { canonicalCoverageQuery } from "./canonical-ortho-coverage";
import { readFollowupCoverageSnapshotWith } from "./ortho-followup-coverage-db";
import { isCanonicalCoverageEditor,projectCoverageSource,type CanonicalCoverageEditor } from "./canonical-ortho-coverage-editor-projection";
import type { VerifiedDurableSession } from "./staff-durable-session";
/** GET only; command/status query validation remains strict and unchanged. */
export function canonicalCoverageReadQuery(raw:string,params:URLSearchParams){
 if(params.getAll("edit").length>1||params.has("edit")&&params.get("edit")!=="1")throw new CanonicalPatientReadRefusal("invalid_patient_query","طلب مصدر التغطية غير صالح.");
 const rest=new URLSearchParams(params);rest.delete("edit");return {...canonicalCoverageQuery(raw,rest),edit:params.get("edit")==="1"};
}
export function readCanonicalCoverageEditor(session:VerifiedDurableSession,patientId:number,caseId:number){
 return readCanonicalPatientRecord(session,"read:ortho.coverage",patientId,async(q,scope):Promise<CanonicalCoverageEditor>=>{
  // Source labels and linked IDs have their own current read grants. Agreement
  // management alone continues to admit the minimal saved-decision reader.
  if(!scope.granted("finance.invoices.view")||!scope.granted("clinical.plans.view")||!scope.granted("clinical.ortho.view"))throw new Error("STAFF_READ_CAPABILITY_DENIED");
  const found=(await q.query<{status:string}>("SELECT status FROM ortho_cases WHERE id=$1 AND patient_id=$2",[caseId,patientId])).rows[0];
  if(!found)throw new CanonicalPatientReadRefusal("patient_not_found","لا يوجد مريض بهذا الرقم ضمن مرضاك.");
  const saved=await readFollowupCoverageSnapshotWith(q,patientId,caseId),h=saved.current;
  const result:CanonicalCoverageEditor={projection:"ortho-followup-coverage-editor",patientId,orthoCaseId:caseId,enabled:saved.enabled,
   canEdit:saved.enabled&&["active","retention"].includes(found.status),applicable:saved.applicable,
   current:h?{id:h.id,version:h.version,decision:h.decision,reason:h.reason,createdAt:h.createdAt,createdBy:h.createdBy}:null,
   sources:saved.sources.map(projectCoverageSource)};
  if(!isCanonicalCoverageEditor(result,patientId,caseId))throw new Error("STAFF_READ_READ_FAILED");return result;
 },2*1024*1024);
}
