import { CLINIC_TIME_ZONE, insertAuditRow, type DbClient } from "./db";
import { clinicDateString } from "./schedule";
import { PHASE_ORDER, type OrthoPhase } from "./ortho";
import { authorizeJourney, assertJourneyCurrent, journeyFail, journeyTransaction, lockJourneyOwner, type JourneyOwner, type JourneyOwnerInput } from "./ortho-case-journey-authority";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { readRetentionTransitionCommand, readRetentionTransitionRecord, type RetentionTransitionRecord } from "./ortho-retention-transition";
async function readRecord(client: DbClient, owner: JourneyOwner): Promise<RetentionTransitionRecord | null> {
  const {rows}=await client.query(`SELECT *,to_char(occurred_on,'YYYY-MM-DD') AS occurrence_date FROM ortho_retention_transitions WHERE ortho_case_id=$1`,[owner.orthoCaseId]);
  if(!rows.length)return null;
  if(rows.length!==1)journeyFail(500,"retention_transition_history_invalid");
  const r=rows[0];
  const record=readRetentionTransitionRecord({id:r.id,patientId:r.patient_id,orthoCaseId:r.ortho_case_id,clinicalCaseId:r.clinical_case_id,
    recordedPatientId:r.recorded_patient_id,actorId:r.actor_user_id,createdBy:r.created_by,createdAt:r.created_at.toISOString(),requestFingerprint:r.request_fingerprint,
    command:{schemaVersion:1,clientRequestId:r.command_id,expectedPhase:r.from_phase,confirmed:true,reason:r.reason,retentionPlan:r.retention_plan,
      occurrence:{occurredOn:r.occurrence_date,dateProvenance:r.date_provenance,sourceNote:r.source_note}}},owner);
  if(record.clinicalCaseId!==owner.clinicalCaseId || journeyContentHash(record.command)!==record.requestFingerprint)journeyFail(500,"retention_transition_history_invalid");
  return record;
}
async function phaseAndBridge(client: DbClient, owner: JourneyOwner) {
  const {rows:[row]}=await client.query(`SELECT o.phase,c.status AS bridge_status FROM ortho_cases o JOIN clinical_cases c ON c.id=$2 AND c.ortho_case_id=o.id WHERE o.id=$1`,[owner.orthoCaseId,owner.clinicalCaseId]);
  if(!row || !PHASE_ORDER.includes(row.phase))journeyFail(409,"invalid_case_phase");
  return {phase:row.phase as OrthoPhase,bridgeStatus:row.bridge_status as string};
}
export async function getOrthoRetentionTransition(input: JourneyOwnerInput) {
  return journeyTransaction(false,async client=>{
    const authority=await authorizeJourney(client,input,false),owner=await lockJourneyOwner(client,input,false);
    const {phase,bridgeStatus}=await phaseAndBridge(client,owner),transition=await readRecord(client,owner);
    assertJourneyCurrent(authority);
    return {ok:true as const,patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId,
      status:owner.status,phase,transition,canTransition:authority.canWrite && owner.status==="active" && !transition && ["active","waiting"].includes(bridgeStatus)};
  });
}
export async function startOrthoRetention(input: JourneyOwnerInput & {command:unknown}) {
  return journeyTransaction(true,async client=>{
    let command;try{command=readRetentionTransitionCommand(input.command);}catch{journeyFail(400,"invalid_retention_transition","أكمل القرار وخطة المتابعة ومصدر التاريخ صراحةً.");}
    const authority=await authorizeJourney(client,input,true),owner=await lockJourneyOwner(client,input,true);
    const old=await readRecord(client,owner),fingerprint=journeyContentHash(command);
    if(old){
      if(old.actorId===authority.userId && old.command.clientRequestId===command.clientRequestId){
        if(old.requestFingerprint!==fingerprint)journeyFail(409,"request_key_conflict","معرّف الطلب السابق مرتبط بمحتوى مختلف.");
        assertJourneyCurrent(authority);return {ok:true as const,replayed:true,transition:old};
      }
      journeyFail(409,"retention_transition_exists","سُجّل الانتقال من قبل. أعد قراءة سجل الحالة.");
    }
    const current=await phaseAndBridge(client,owner);
    if(owner.status!=="active" || current.phase!==command.expectedPhase || !["active","waiting"].includes(current.bridgeStatus))
      journeyFail(409,"case_state_changed","تغيّرت حالة العلاج أو مرحلته. أعد القراءة قبل اتخاذ القرار.");
    const today=clinicDateString(new Date(),CLINIC_TIME_ZONE);
    if(command.occurrence.occurredOn!==null && (command.occurrence.occurredOn>today || command.occurrence.occurredOn<"1900-01-01"))
      journeyFail(400,"invalid_retention_transition_date","تاريخ انتهاء العلاج يجب أن يكون تاريخاً فعلياً صالحاً، أو مجهولاً بشكل صريح.");
    await client.query(`INSERT INTO ortho_retention_transitions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,created_by,command_id,request_fingerprint,from_phase,occurred_on,date_provenance,source_note,reason,retention_plan)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10,$11,$12,$13)`,[owner.patientId,owner.orthoCaseId,owner.clinicalCaseId,authority.userId,authority.name,command.clientRequestId,fingerprint,command.expectedPhase,command.occurrence.occurredOn,command.occurrence.dateProvenance,command.occurrence.sourceNote,command.reason,command.retentionPlan]);
    // Keep the specialty bridge open. No delivery, visit, appointment, invoice,
    // closing timestamp or opening balance is inferred from this decision.
    await client.query("UPDATE ortho_cases SET status='retention',phase='retention' WHERE id=$1",[owner.orthoCaseId]);
    const transition=await readRecord(client,owner);if(!transition)journeyFail(500,"retention_transition_missing");
    await insertAuditRow(client,{action:"ortho.retention_transition",actor:authority.name,actorRole:authority.session.role,
      entity:"ortho_retention_transitions",entityId:transition.id,details:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,fromStatus:owner.status,toStatus:"retention",fromPhase:command.expectedPhase,requestFingerprint:fingerprint}});
    assertJourneyCurrent(authority);return {ok:true as const,replayed:false,transition};
  });
}
