import { CLINIC_TIME_ZONE, insertAuditRow, type DbClient } from "./db";
import { clinicDateString } from "./schedule";
import { authorizeJourney, assertJourneyCurrent, journeyFail, journeyTransaction, lockJourneyOwner, type JourneyOwnerInput, type JourneyOwner } from "./ortho-case-journey-authority";
import { journeyContentHash } from "./ortho-case-journey-hash";
import { canonicalJourneyJSON } from "./ortho-case-journey-json";
import { computeFacialResults, readFacialCommand } from "./ortho-facial-analysis";
import { readFacialRevision, type FacialRevision, type FacialRead, type FacialDocument } from "./ortho-facial-records";
import { facialImageBasis } from "./ortho-facial-image";
type Source={id:number;patient_id:number;ortho_case_id:number;sha256:string;storage_key:string;mime_type:string;size_bytes:string;removed_at:Date|null;title:string;taken_on:string|null};
async function source(client:DbClient,input:JourneyOwnerInput,documentId:number){
  const {rows:[doc]}=await client.query<Source>("SELECT id,patient_id,ortho_case_id,sha256,storage_key,mime_type,size_bytes,removed_at,title,to_char(taken_on,'YYYY-MM-DD') AS taken_on FROM patient_documents WHERE id=$1 FOR SHARE",[documentId]);
  if(!doc||doc.patient_id!==input.patientId||doc.ortho_case_id!==input.orthoCaseId||doc.removed_at!==null)journeyFail(404,"facial_document_unavailable","الصورة غير متاحة لهذه الحالة أو أُخفيت. لا تُستخدم صورة من حالة أخرى.");return doc;
}
function revision(row:Record<string,unknown>,owner:JourneyOwner):FacialRevision{
  const r=readFacialRevision({id:row.id,patientId:row.patient_id,orthoCaseId:row.ortho_case_id,clinicalCaseId:row.clinical_case_id,documentId:row.document_id,
    recordedPatientId:row.recorded_patient_id,version:row.version,actorId:row.actor_user_id,createdBy:row.created_by,createdAt:(row.created_at as Date).toISOString(),
    requestFingerprint:row.request_fingerprint,contentHash:row.content_sha256,command:row.command,results:row.results},owner);
  if(r.clinicalCaseId!==owner.clinicalCaseId||journeyContentHash(r.command)!==r.requestFingerprint||journeyContentHash({content:r.command.content,results:r.results})!==r.contentHash)journeyFail(500,"facial_history_invalid");return r;
}
export async function getFacialAnalysis(input:JourneyOwnerInput&{documentId:number|null}){
  return journeyTransaction(false,async client=>{
    const authority=await authorizeJourney(client,input,false);if(!authority.canViewImages)journeyFail(403,"image_access_denied");
    const doc=input.documentId===null?null:await source(client,input,input.documentId);
    const owner=await lockJourneyOwner(client,input,false);
    const listed=await client.query<FacialDocument>(`SELECT id,title,sha256,to_char(taken_on,'YYYY-MM-DD') AS "takenOn" FROM patient_documents
      WHERE patient_id=$1 AND ortho_case_id=$2 AND removed_at IS NULL AND mime_type IN ('image/jpeg','image/png','image/webp') ORDER BY uploaded_at DESC,id DESC LIMIT 101`,[input.patientId,input.orthoCaseId]);
    const documents=listed.rows.slice(0,100);if(doc&&!documents.some(d=>d.id===doc.id)){documents.pop();documents.push({id:doc.id,title:doc.title,sha256:doc.sha256,takenOn:doc.taken_on});}
    const image=doc?(await facialImageBasis(doc)).basis:null;
    const history=doc?(await client.query("SELECT * FROM ortho_facial_revisions WHERE ortho_case_id=$1 AND document_id=$2 ORDER BY version DESC LIMIT 31",[owner.orthoCaseId,doc.id])).rows:[];
    const revisions=history.slice(0,30).map(r=>revision(r,owner));
    if(revisions.some(r=>canonicalJourneyJSON(r.command.content.image)!==canonicalJourneyJSON(image)))journeyFail(409,"facial_image_changed","أصل الصورة الحالي لا يطابق مصدر المراجعات؛ لا تعرض المعالم على صورة مختلفة.");
    const result:FacialRead={ok:true,patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId,actorId:authority.userId,canWrite:authority.canWrite,
      documents,documentsTruncated:listed.rows.length>100,selectedDocumentId:doc?.id??null,image,history:revisions,historyTruncated:history.length>30};
    assertJourneyCurrent(authority);return result;
  });
}
export async function appendFacialAnalysis(input:JourneyOwnerInput&{command:unknown}){
  return journeyTransaction(true,async client=>{
    let command;try{command=readFacialCommand(input.command);}catch{journeyFail(400,"invalid_facial_analysis","راجع المعالم ومصدر التاريخ وسبب المراجعة وشروط مراجعة الطبيب.");}
    const authority=await authorizeJourney(client,input,true);if(!authority.canViewImages)journeyFail(403,"image_access_denied");
    const doc=await source(client,input,command.documentId),owner=await lockJourneyOwner(client,input,true);
    const fingerprint=journeyContentHash(command);
    const replay=(await client.query("SELECT * FROM ortho_facial_revisions WHERE ortho_case_id=$1 AND actor_user_id=$2 AND command_id=$3",[owner.orthoCaseId,authority.userId,command.clientRequestId])).rows[0];
    if(replay){const saved=revision(replay,owner);if(saved.requestFingerprint!==fingerprint)journeyFail(409,"request_key_conflict");assertJourneyCurrent(authority);return {ok:true as const,replayed:true,revision:saved};}
    const image=(await facialImageBasis(doc)).basis;
    if(canonicalJourneyJSON(image)!==canonicalJourneyJSON(command.content.image))journeyFail(409,"facial_image_changed","تغير أصل الصورة أو اتجاهه. أعد فتح الصورة؛ لم تُنقل المعالم تلقائياً.");
    const date=command.content.occurrence.occurredOn;
    if(date!==null&&(date<"1900-01-01"||date>clinicDateString(new Date(),CLINIC_TIME_ZONE)))journeyFail(400,"invalid_image_date");
    const head=(await client.query("SELECT id,version FROM ortho_facial_revisions WHERE ortho_case_id=$1 AND document_id=$2 ORDER BY version DESC LIMIT 1",[owner.orthoCaseId,doc.id])).rows[0];
    if((head?.id??null)!==command.expectedHeadId)journeyFail(409,"facial_head_changed","حُفظت مراجعة أحدث لهذه الصورة. احتفظ بمسودتك وراجع النسخة الحالية قبل إعادة التحرير.");
    const results=computeFacialResults(command.content),contentHash=journeyContentHash({content:command.content,results});
    const saved=(await client.query(`INSERT INTO ortho_facial_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,document_id,version,previous_revision_id,actor_user_id,created_by,command_id,request_fingerprint,content_sha256,command,results)
      VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb) RETURNING *`,[owner.patientId,owner.orthoCaseId,owner.clinicalCaseId,doc.id,(head?.version??0)+1,head?.id??null,authority.userId,authority.name,command.clientRequestId,fingerprint,contentHash,JSON.stringify(command),JSON.stringify(results)])).rows[0];
    await insertAuditRow(client,{action:"ortho.facial_revision",actor:authority.name,actorRole:authority.session.role,entity:"ortho_facial_revisions",entityId:saved.id,
      details:{patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,documentId:doc.id,version:saved.version,review:command.content.review.state,requestFingerprint:fingerprint}});
    assertJourneyCurrent(authority);return {ok:true as const,replayed:false,revision:revision(saved,owner)};
  });
}
export async function getFacialImage(input:JourneyOwnerInput&{documentId:number;sha256:string}){
  return journeyTransaction(false,async client=>{
    const authority=await authorizeJourney(client,input,false);if(!authority.canViewImages)journeyFail(403,"image_access_denied");
    const doc=await source(client,input,input.documentId);await lockJourneyOwner(client,input,false);
    if(doc.sha256!==input.sha256)journeyFail(409,"facial_image_changed");
    const rendered=await facialImageBasis(doc,true);assertJourneyCurrent(authority);return {ok:true as const,png:rendered.png!};
  });
}
