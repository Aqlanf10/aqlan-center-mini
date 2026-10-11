import { permitsOrthoDocumentation, orthoDocumentationContext } from "./ortho-assessment-lifecycle";
import { ensureSchema,getPool,insertAuditRow,type DbClient } from "./db";
import { AssessmentStoreFault,assessmentFail,authorizeAssessment,assertAssessmentAuthorityCurrent,type AssessmentOwnerInput,type AssessmentAuthority } from "./ortho-assessment-authority";
import { checkAnyAssessmentCommand,assessmentDraftSources } from "./ortho-assessment-command-v2";
import { assessmentJsonHash,assessmentRevisionSources,createPersistedAssessmentV2,type AnyAssessmentRevision,type AssessmentRevisionV2 } from "./ortho-assessment-persisted-v2";
import { positiveId } from "./ortho-assessment-model";
import { ASSESSMENT_COLUMNS,collectAssessmentSourceClosure,decodeAssessmentStoredRow,listAssessmentSourceChoices,resolveAssessmentSourceGraph,validateAssessmentCopies,type AssessmentStoredRow } from "./ortho-assessment-versioned-sources";
import type { AssessmentReadResponseV2,AssessmentHistoryEntryV2,AssessmentScope } from "./ortho-assessment-response-v2";
import { ASSESSMENT_HISTORY_MAX_BYTES,ASSESSMENT_HISTORY_MAX_REVISIONS,assessmentStoredByteCount } from "./ortho-assessment-limits";
export interface AssessmentFailure {ok:false;status:number;code:string;message:string}
interface OwnerSnapshot {clinicalCaseId:number|null;recordingContext:"current"|"retrospective"}
async function ownerSnapshot(client:DbClient,input:AssessmentOwnerInput,lock:boolean,write:boolean):Promise<OwnerSnapshot>{
  const row=(await client.query<{id:number;patient_id:number;status:string}>(`SELECT id,patient_id,status FROM ortho_cases WHERE id=$1 AND patient_id=$2 ${lock?(write?"FOR UPDATE":"FOR SHARE"):""}`,[input.orthoCaseId,input.patientId])).rows[0];
  if(!row)assessmentFail(404,"ortho_case_not_found","حالة التقويم غير متاحة لهذا المريض.");
  if(!permitsOrthoDocumentation(row.status))assessmentFail(409,"unsupported_case_state","مرحلة الحالة غير مدعومة في هذا الإصدار.");
  const bridges=(await client.query<{id:number;patient_id:number;ortho_case_id:number}>(`SELECT id,patient_id,ortho_case_id FROM clinical_cases WHERE ortho_case_id=$1 ${lock?(write?"FOR UPDATE":"FOR SHARE"):""}`,[input.orthoCaseId])).rows;
  if(bridges.length>1||bridges.some(b=>b.patient_id!==input.patientId||b.ortho_case_id!==input.orthoCaseId))assessmentFail(409,"scope_mismatch","رابط الحالة السريري يحتاج تحققًا.");
  return {clinicalCaseId:bridges[0]?.id??null,recordingContext:orthoDocumentationContext(row.status)};
}
function sameOwner(before:OwnerSnapshot,after:OwnerSnapshot){
  if(before.clinicalCaseId!==after.clinicalCaseId||before.recordingContext!==after.recordingContext)assessmentFail(409,"case_changed","تغيرت هوية الحالة أو مرحلتها أثناء القراءة؛ أعد تحميلها.");
}
const scopeOf=(input:AssessmentOwnerInput,owner:OwnerSnapshot):AssessmentScope=>{
  if(owner.clinicalCaseId===null)assessmentFail(409,"bridge_missing","اربط الحالة سريريًا بالإجراء الصريح أولًا.");
  return {patientId:input.patientId,orthoCaseId:input.orthoCaseId,clinicalCaseId:owner.clinicalCaseId};
};
async function history(client:DbClient,scope:AssessmentScope):Promise<{rows:AssessmentStoredRow[];revisions:AnyAssessmentRevision[]}>{
  // Admit only aggregate metadata before transferring or decoding any content.
  // Both read snapshot and write patient lock keep this admission stable through
  // the bounded fetch; canonical writers for the case use the same patient lock.
  const stats=(await client.query<{count:string;bytes:string}>(`SELECT COUNT(*)::text AS count,COALESCE(SUM(octet_length(content::text)),0)::text AS bytes FROM ortho_assessment_revisions WHERE ortho_case_id=$1`,[scope.orthoCaseId])).rows[0];
  const count=assessmentStoredByteCount(stats?.count),bytes=assessmentStoredByteCount(stats?.bytes);
  if(count===null||bytes===null)assessmentFail(409,"invalid_history_budget","تعذّر التحقق من حجم السجل؛ لم يُعتبر فارغًا.");
  if(count>ASSESSMENT_HISTORY_MAX_REVISIONS||bytes>ASSESSMENT_HISTORY_MAX_BYTES)assessmentFail(409,"history_resource_limit","سجل الحالة يتجاوز حد القراءة الآمنة؛ يلزم عرض مخصص دون اختصار السجل.");
  const rows=(await client.query<AssessmentStoredRow>(`SELECT ${ASSESSMENT_COLUMNS} FROM ortho_assessment_revisions WHERE ortho_case_id=$1 ORDER BY version DESC LIMIT ${ASSESSMENT_HISTORY_MAX_REVISIONS+1}`,[scope.orthoCaseId])).rows;
  if(rows.length!==count||rows.length>ASSESSMENT_HISTORY_MAX_REVISIONS)assessmentFail(409,"history_changed","تغير السجل أثناء القراءة؛ لم يُرجع سجل جزئي.");
  const revisions=rows.map(r=>decodeAssessmentStoredRow(r,scope));
  const ids=new Set<number>();
  for(let i=0;i<revisions.length;i++){const r=revisions[i],previous=revisions[i+1];
    if(ids.has(r.id)||r.version!==(previous?.version??0)+1||r.supersedesRevisionId!==(previous?.id??null))assessmentFail(409,"invalid_lineage","تسلسل مراجعات الحالة غير صالح.");ids.add(r.id);}
  return {rows,revisions};
}
function entry(r:AnyAssessmentRevision):AssessmentHistoryEntryV2{return {schemaVersion:r.schemaVersion,id:r.id,version:r.version,supersedesRevisionId:r.supersedesRevisionId,recordedPatientId:r.recordedPatientId,recordingContext:r.recordingContext,createdBy:r.createdBy,createdAt:r.createdAt,reason:r.reason};}
async function checkHeadVisibility(client:DbClient,scope:AssessmentScope,authority:AssessmentAuthority,revision:AnyAssessmentRevision|undefined){
  if(!revision)return;const closure=await collectAssessmentSourceClosure(client,scope,assessmentRevisionSources(revision));
  if(!authority.imagingVisible&&closure.external.some(s=>s.kind==="document"||s.kind==="ceph_study"))assessmentFail(403,"imaging_restricted","المراجعة الحالية تستند إلى مصادر مقيدة؛ لا يمكن إسقاطها بصمت.");
}
async function transaction<T extends {ok:true}>(write:boolean,body:(client:DbClient)=>Promise<T>):Promise<T|AssessmentFailure>{
  await ensureSchema();const client=await getPool().connect();let committing=false;
  try{await client.query(write?"BEGIN":"BEGIN ISOLATION LEVEL REPEATABLE READ");const value=await body(client);committing=true;await client.query("COMMIT");return value;}
  catch(error){await client.query("ROLLBACK").catch(()=>undefined);
    if(error instanceof AssessmentStoreFault)return {ok:false,status:error.status,code:error.code,message:error.message};
    if(write&&committing)return {ok:false,status:503,code:"write_unconfirmed",message:"لم تتأكد نتيجة الحفظ؛ أعد التحقق بنفس الطلب."};
    throw error;
  }finally{client.release();}
}
export async function getOrthoAssessment(input:AssessmentOwnerInput&{revisionId?:number;acceptedSchemas?:readonly number[]}):Promise<AssessmentReadResponseV2|AssessmentFailure>{
  if(!input.acceptedSchemas?.includes(2))return {ok:false,status:409,code:"schema_negotiation_required",message:"يلزم قارئ يدعم الإصدار الثاني؛ لم يُعتبر السجل فارغًا."};
  return transaction(false,async client=>{
    if(input.revisionId!==undefined&&!positiveId(input.revisionId))assessmentFail(400,"invalid_revision","رقم المراجعة غير صالح.");
    const authority=await authorizeAssessment(client,input,false),before=await ownerSnapshot(client,input,false,false);
    if(before.clinicalCaseId===null){
      if((await client.query("SELECT id FROM ortho_assessment_revisions WHERE ortho_case_id=$1 LIMIT 1",[input.orthoCaseId])).rows.length)assessmentFail(409,"scope_mismatch","سجل موجود فقد رابطه السريري؛ لم يُخفَ السجل.");
      sameOwner(before,await ownerSnapshot(client,input,true,false));assertAssessmentAuthorityCurrent(authority);
      if(input.revisionId!==undefined)assessmentFail(404,"revision_not_found","المراجعة غير متاحة.");
      return {ok:true as const,representation:2 as const,state:"bridge_missing" as const,patientId:input.patientId,orthoCaseId:input.orthoCaseId,clinicalCaseId:null,recordingContext:before.recordingContext,clinicalWritable:authority.clinicalWritable,revision:null,history:[],sourceStates:[],sources:{items:[],truncated:false,imaging:authority.imagingVisible?"allowed" as const:"restricted" as const}};
    }
    const scope=scopeOf(input,before),saved=await history(client,scope),selected=input.revisionId===undefined?saved.revisions[0]??null:saved.revisions.find(r=>r.id===input.revisionId)??null;
    if(input.revisionId!==undefined&&!selected)assessmentFail(404,"revision_not_found","المراجعة لا تخص الحالة المطلوبة.");
    await checkHeadVisibility(client,scope,authority,saved.revisions[0]);
    const graph=await resolveAssessmentSourceGraph(client,scope,selected?assessmentRevisionSources(selected):[],authority.imagingVisible);
    sameOwner(before,await ownerSnapshot(client,input,true,false));
    const sources=await listAssessmentSourceChoices(client,scope,authority.imagingVisible,saved.revisions);
    assertAssessmentAuthorityCurrent(authority);
    return {ok:true as const,representation:2 as const,state:"ready" as const,...scope,recordingContext:before.recordingContext,clinicalWritable:authority.clinicalWritable,revision:selected,history:saved.revisions.map(entry),sources,sourceStates:graph.states};
  });
}
export async function appendOrthoAssessment(input:AssessmentOwnerInput&{command:unknown}):Promise<AssessmentFailure|{ok:true;revision:AssessmentRevisionV2;replayed:boolean}>{
  const checked=checkAnyAssessmentCommand(input.command);
  if(!checked.ok||checked.value.schemaVersion!==2)return {ok:false,status:400,code:checked.ok?"unsupported_schema":checked.code,message:"طلب التقييم غير صالح أو غير مدعوم."};
  const command=checked.value,requestFingerprint=assessmentJsonHash({schemaVersion:2,expectedRevisionId:command.expectedRevisionId,reason:command.reason,content:command.content});
  return transaction(true,async client=>{
    const authority=await authorizeAssessment(client,input,true),before=await ownerSnapshot(client,input,false,true),scope=scopeOf(input,before);
    const saved=await history(client,scope);await checkHeadVisibility(client,scope,authority,saved.revisions[0]);
    const graph=await resolveAssessmentSourceGraph(client,scope,assessmentDraftSources(command.content),authority.imagingVisible);
    sameOwner(before,await ownerSnapshot(client,input,true,true));
    // Same patient row already serializes these assessment writers. Re-read the exact
    // head under case locks rather than trusting the pre-lock projection.
    const fresh=await history(client,scope);
    if(fresh.revisions[0]?.id!==saved.revisions[0]?.id)assessmentFail(409,"head_changed","تغيرت المراجعة الحالية؛ أعد تحميل السجل.");
    const replay=fresh.rows.find(r=>r.actor_user_id===authority.actorId&&r.command_id===command.commandId);
    if(replay){
      if(replay.request_fingerprint!==requestFingerprint)assessmentFail(409,"command_conflict","معرّف الطلب مستخدم لمحتوى آخر.");
      const revision=decodeAssessmentStoredRow(replay,scope);if(revision.schemaVersion!==2)assessmentFail(409,"unsupported_schema","صيغة الطلب التاريخي غير مدعومة.");
      // A confirmed immutable command is acknowledged under current source
      // ownership/visibility. Mutable same-owner content may have changed since
      // commit; it cannot turn this retry into a new write or strand it forever.
      if(graph.external.some(s=>!graph.historicallyReadable.has(`${s.kind}:${s.id}`)))assessmentFail(403,"source_access_changed","لم تعد ملكية أحد المصادر أو صلاحية عرضه متاحة لهذا الطلب التاريخي.");
      assertAssessmentAuthorityCurrent(authority);return {ok:true as const,revision,replayed:true};
    }
    if((fresh.revisions[0]?.id??null)!==command.expectedRevisionId)assessmentFail(409,"head_changed","المراجعة السابقة لا تطابق الرأس الحالي.");
    if(graph.states.some(s=>s.state!=="available"))assessmentFail(409,"source_unavailable","مرجع مفقود أو تغير إصداره؛ لم يُحفظ بديل مفترض.");
    for(const r of graph.revisions.values())if(r.version>(fresh.revisions[0]?.version??0))assessmentFail(409,"future_assessment_source","المرجع لا يسبق المراجعة الجديدة.");
    validateAssessmentCopies(command.content,graph);
    const content=createPersistedAssessmentV2(command.content);if(!content.ok)assessmentFail(400,content.code,"تعذّر التحقق من القياسات والنتائج.");
    const contentHash=assessmentJsonHash(content.value);
    const row=(await client.query<AssessmentStoredRow>(`INSERT INTO ortho_assessment_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,supersedes_revision_id,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,content_sha256,content)
      VALUES($1,$1,$2,$3,2,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb) RETURNING ${ASSESSMENT_COLUMNS}`,
      [scope.patientId,scope.orthoCaseId,scope.clinicalCaseId,(fresh.revisions[0]?.version??0)+1,command.expectedRevisionId,authority.actorId,authority.actorName,command.reason,before.recordingContext,command.commandId,requestFingerprint,contentHash,JSON.stringify(content.value)])).rows[0];
    const revision=decodeAssessmentStoredRow(row,scope);if(revision.schemaVersion!==2)assessmentFail(500,"invalid_insert","تعذّر التحقق من النسخة الجديدة.");
    await insertAuditRow(client,{action:"ortho.assessment.append",entity:"ortho_case",entityId:scope.orthoCaseId,entityLabel:`نسخة تقييم ${revision.version}`,actor:authority.actorName,actorRole:authority.session.role,
      details:{patientId:scope.patientId,revisionId:revision.id,version:revision.version,contentHash,reason:command.reason}});
    assertAssessmentAuthorityCurrent(authority);return {ok:true as const,revision,replayed:false};
  });
}
