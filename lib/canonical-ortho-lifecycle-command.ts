import "server-only";
import { CLINIC_TIME_ZONE, closeOrthoCaseInTransaction, doctorOwnsPatient, getPool, insertAuditRow, patientInDoctorScopeWith, setOrthoPhaseInTransaction, setRetainerInTransaction } from "./db";
import { PHASE_LABEL, RETAINER_LABEL, type OrthoPhase, type RetainerType } from "./ortho";
import { clinicDateString } from "./schedule";
import { orthoLifecycleVersionWith } from "./canonical-ortho-lifecycle-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";
export class CanonicalOrthoLifecycleRefusal extends Error {
  constructor(readonly code: "invalid_ortho_lifecycle" | "ortho_lifecycle_not_found" | "ortho_lifecycle_conflict" | "ortho_lifecycle_transition" | "ortho_lifecycle_plan_link_pending", readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "CanonicalOrthoLifecycleRefusal"; }
}
const missing=()=>new CanonicalOrthoLifecycleRefusal("ortho_lifecycle_not_found",404,"الحالة غير متاحة ضمن مرضاك.");
const conflict=()=>new CanonicalOrthoLifecycleRefusal("ortho_lifecycle_conflict",409,"تغيّرت الحالة أو تعذّر تثبيت حالتها. راجع السجل الحالي قبل طلب جديد.");
const invalid=()=>new CanonicalOrthoLifecycleRefusal("invalid_ortho_lifecycle",400,"اختر إجراءً واحدًا وراجع حقوله؛ لم تُختصر الملاحظة أو يُستبدل تاريخ غير صالح.");
type Mutation = { kind:"phase"; phase:OrthoPhase } | { kind:"retainer"; retainer:RetainerType; deliveredOn:string|null; preserveExistingDeliveryDate:boolean } | { kind:"close"; status:"completed"|"discontinued"; note:string|null };
export function parseCanonicalOrthoLifecycle(rawId:string,body:unknown) {
  const id=Number(rawId);
  if(!/^[1-9]\d*$/.test(rawId)||!Number.isSafeInteger(id)||id>2147483647||!body||typeof body!=="object"||Array.isArray(body))throw invalid();
  const value=body as Record<string,unknown>;
  if(Object.hasOwn(value,"planId"))throw new CanonicalOrthoLifecycleRefusal("ortho_lifecycle_plan_link_pending",409,"ربط الاتفاق له صلاحيات ومسار مستقلان؛ لم تُغيّر الحالة أو الاتفاق.");
  if(typeof value.expectedVersion!=="string"||!/^[a-f0-9]{64}$/.test(value.expectedVersion))throw invalid();
  const keys=Object.keys(value).sort().join(",");let mutation:Mutation;
  if(keys==="expectedVersion,phase"&&typeof value.phase==="string"&&Object.hasOwn(PHASE_LABEL,value.phase))mutation={kind:"phase",phase:value.phase as OrthoPhase};
  else if((keys==="expectedVersion,retainer"||keys==="expectedVersion,retainer,retainerOn")&&typeof value.retainer==="string"&&Object.hasOwn(RETAINER_LABEL,value.retainer)) {
    const date=value.retainerOn;
    if(date!==undefined&&date!==null&&(typeof date!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(date)||date.startsWith("0000-")||!Number.isFinite(Date.parse(`${date}T00:00:00Z`))||new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date))throw invalid();
    mutation={kind:"retainer",retainer:value.retainer as RetainerType,deliveredOn:typeof date==="string"?date:null,preserveExistingDeliveryDate:date==null};
  } else if(keys==="expectedVersion,note,status"&&(value.status==="completed"||value.status==="discontinued")&&(value.note===null||typeof value.note==="string"&&value.note.length<=300))mutation={kind:"close",status:value.status,note:typeof value.note==="string"?value.note.trim()||null:null};
  else throw invalid();
  return {id,expectedVersion:value.expectedVersion,mutation};
}
/** Native clinical lifecycle only; plan links and financial writers remain separate. */
export async function commandCanonicalOrthoLifecycle(session:VerifiedDurableSession,rawId:string,body:unknown,pool=getPool()) {
  const input=parseCanonicalOrthoLifecycle(rawId,body),action="clinical.ortho.edit" as const;
  try {return await withStaffOperation(pool,session,action,async(client,handle)=>{
    let scope=await staffOperationPatientScope(client,handle,action);
    if(scope.kind==="none")throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const initial=(await client.query<{patient_id:number}>("SELECT patient_id FROM ortho_cases WHERE id=$1",[input.id])).rows[0];
    if(!initial||scope.kind==="own"&&!await patientInDoctorScopeWith(client,scope.clinicianPartyId,initial.patient_id))throw missing();
    const patient=await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE",[initial.patient_id]);
    scope=await staffOperationPatientScope(client,handle,action);
    if(!patient.rows.length)throw missing();
    if(scope.kind==="none")throw new Error("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    if(scope.kind==="own"&&!await doctorOwnsPatient(scope.clinicianPartyId,initial.patient_id,client,"nowait"))throw missing();
    const before=(await client.query("SELECT id,patient_id,status,phase,retainer,retainer_on::text,closed_at::text,closed_by,closed_note FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR UPDATE NOWAIT",[input.id,initial.patient_id])).rows[0];
    if(!before)throw missing();
    if(!["active","retention"].includes(before.status)||await orthoLifecycleVersionWith(client,input.id)!==input.expectedVersion)throw conflict();
    const actor=await staffOperationIdentity(client,handle,action),m=input.mutation;
    if(m.kind==="phase") {if(!await setOrthoPhaseInTransaction(client,input.id,m.phase))throw conflict();}
    else if(m.kind==="retainer") {if(!await setRetainerInTransaction(client,{id:input.id,retainer:m.retainer,deliveredOn:m.retainer==="none"?null:m.deliveredOn??clinicDateString(new Date(),CLINIC_TIME_ZONE),preserveExistingDeliveryDate:m.preserveExistingDeliveryDate}))throw conflict();}
    else {const result=await closeOrthoCaseInTransaction(client,{id:input.id,status:m.status,note:m.note,actor:actor.username});if(!result.ok)throw new CanonicalOrthoLifecycleRefusal("ortho_lifecycle_transition",409,result.message);}
    const after=(await client.query("SELECT id,patient_id,status,phase,retainer,retainer_on::text,closed_at::text,closed_by,closed_note FROM ortho_cases WHERE id=$1",[input.id])).rows[0];
    await insertAuditRow(client,{action:"ortho.case_update",entity:"ortho_case",entityId:input.id,entityLabel:"مرحلة أو مثبت أو إقفال حالة تقويم",details:{operation:m.kind,before,after},actor:actor.username,actorRole:actor.role});
    await assertStaffOperation(client,handle,action);
    return {ok:true as const,caseId:input.id,status:after.status as string};
  });}catch(error){if(error&&typeof error==="object"&&"code" in error&&["55P03","40P01","40001"].includes(String(error.code)))throw conflict();throw error;}
}
