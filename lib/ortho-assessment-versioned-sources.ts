import type { DbClient } from "./db";
import { assessmentFail } from "./ortho-assessment-authority";
import { assessmentJsonHash,assessmentRevisionSources,decodeAnyAssessmentRevision,type AnyAssessmentRevision } from "./ortho-assessment-persisted-v2";
import { sameAssessmentStructure } from "./ortho-assessment-read-v2";
import type { AssessmentScope,AssessmentSourceChoiceV2,AssessmentSourceStateV2 } from "./ortho-assessment-response-v2";
import type { AssessmentSourceV2 } from "./ortho-assessment-v2";
import type { AssessmentDraftV2 } from "./ortho-assessment-measurement-set-v2";
import { positiveId } from "./ortho-assessment-model";
import { ASSESSMENT_SOURCE_GRAPH_MAX_BYTES,ASSESSMENT_EXTERNAL_SOURCE_MAX_BYTES,ASSESSMENT_CEPH_SOURCE_MAX_CHILD_ROWS,assessmentStoredByteCount } from "./ortho-assessment-limits";
export interface AssessmentSourceGraph { external:AssessmentSourceV2[];revisions:Map<number,AnyAssessmentRevision>;states:AssessmentSourceStateV2[];historicallyReadable:ReadonlySet<string> }
export type AssessmentExternalCapture=Map<string,AssessmentSourceChoiceV2>&{historicallyReadable:ReadonlySet<string>};
export type AssessmentExternalLockTarget={kind:Exclude<AssessmentSourceV2["kind"],"assessment_revision">;id:number};
const key=(s:Pick<AssessmentSourceV2,"kind"|"id">)=>`${s.kind}:${s.id}`;
function canonical(value:unknown):unknown{
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==="object"&&!(value instanceof Date))return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value instanceof Date?value.toISOString():value;
}
const version=(value:unknown)=>`sha256:${assessmentJsonHash(canonical(value))}`;
export interface AssessmentStoredRow {
  id:number;patient_id:number;recorded_patient_id:number;ortho_case_id:number;clinical_case_id:number;schema_version:number;version:number;supersedes_revision_id:number|null;
  created_at:Date|string;created_by:string;reason:string;recording_context:string;content_sha256:string;content:unknown;actor_user_id:number;command_id:string;request_fingerprint:string;
}
export const ASSESSMENT_COLUMNS="id,patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,supersedes_revision_id,created_at,created_by,reason,recording_context,content_sha256,content,actor_user_id,command_id,request_fingerprint";
export function decodeAssessmentStoredRow(row:AssessmentStoredRow,scope:AssessmentScope):AnyAssessmentRevision{
  if(!row||!positiveId(row.actor_user_id)||typeof row.command_id!=="string"||!/^[A-Za-z0-9_-]{16,80}$/.test(row.command_id)
    ||typeof row.request_fingerprint!=="string"||!/^[a-f0-9]{64}$/.test(row.request_fingerprint))
    assessmentFail(409,"invalid_command_witness","شاهد الطلب المحفوظ غير صالح؛ لم يُعامل كحفظ جديد.");
  const checked=decodeAnyAssessmentRevision({id:row.id,patientId:row.patient_id,recordedPatientId:row.recorded_patient_id,orthoCaseId:row.ortho_case_id,clinicalCaseId:row.clinical_case_id,
    schemaVersion:row.schema_version,version:row.version,supersedesRevisionId:row.supersedes_revision_id,createdAt:row.created_at instanceof Date?row.created_at.toISOString():row.created_at,
    createdBy:row.created_by,reason:row.reason,recordingContext:row.recording_context,contentHash:row.content_sha256,content:row.content},scope);
  if(!checked.ok)assessmentFail(409,checked.code,"النسخة المحفوظة غير مدعومة أو لا تطابق شاهدها؛ لم تُعدّل.");return checked.value;
}
/** Patient/current-user/access locks must already be held. Prior revisions are immutable;
 * external source locks are sorted and precede Ortho/bridge locks. No foreign-owner row is locked.
 */
export async function collectAssessmentSourceClosure(client:DbClient,scope:AssessmentScope,direct:AssessmentSourceV2[]):Promise<{external:AssessmentSourceV2[];revisions:Map<number,AnyAssessmentRevision>}>{
  const wanted=new Map<string,AssessmentSourceV2>(),revisions=new Map<number,AnyAssessmentRevision>(),queue: {source:AssessmentSourceV2;parentVersion:number|null}[]=direct.map(source=>({source,parentVersion:null}));
  let storedBytes=0;
  while(queue.length){const {source,parentVersion}=queue.shift()!,existing=wanted.get(key(source));
    if(existing){if(source.kind==="assessment_revision"&&parentVersion!==null&&(revisions.get(source.id)?.version??Infinity)>=parentVersion)assessmentFail(409,"assessment_source_cycle","مرجع التقييم لا يسبق النسخة التي تستند إليه.");if(existing.version!==source.version)assessmentFail(409,"source_version_conflict","إصدارات المرجع متعارضة.");continue;}
    wanted.set(key(source),source);if(wanted.size>160)assessmentFail(400,"source_reference_limit","عدد المراجع يتجاوز الحد.");
    if(source.kind!=="assessment_revision")continue;
    if(revisions.size>=32)assessmentFail(400,"source_reference_limit","تسلسل مراجع التقييم يتجاوز الحد.");
    const metadata=(await client.query<{bytes:string}>("SELECT octet_length(content::text)::text AS bytes FROM ortho_assessment_revisions WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4",[source.id,scope.patientId,scope.orthoCaseId,scope.clinicalCaseId])).rows[0];
    if(!metadata)assessmentFail(409,"assessment_source_unavailable","مرجع التقييم غير متاح لهذه الحالة.");
    const bytes=assessmentStoredByteCount(metadata.bytes);
    if(bytes===null)assessmentFail(409,"invalid_source_budget","تعذّر التحقق من حجم المرجع.");
    storedBytes+=bytes;if(storedBytes>ASSESSMENT_SOURCE_GRAPH_MAX_BYTES)assessmentFail(409,"source_resource_limit","تسلسل المصادر يتجاوز حد القراءة الآمنة.");
    const row=(await client.query<AssessmentStoredRow>(`SELECT ${ASSESSMENT_COLUMNS} FROM ortho_assessment_revisions WHERE id=$1 AND patient_id=$2 AND ortho_case_id=$3 AND clinical_case_id=$4`,[source.id,scope.patientId,scope.orthoCaseId,scope.clinicalCaseId])).rows[0];
    if(!row)assessmentFail(409,"assessment_source_unavailable","مرجع التقييم غير متاح لهذه الحالة.");
    const revision=decodeAssessmentStoredRow(row,scope);
    if(source.version!==`sha256:${revision.contentHash}`)assessmentFail(409,"assessment_source_changed","بصمة مرجع التقييم لا تطابق السجل.");
    if(parentVersion!==null&&revision.version>=parentVersion)assessmentFail(409,"assessment_source_cycle","مرجع التقييم لا يسبق النسخة التي تستند إليه.");
    revisions.set(source.id,revision);queue.push(...assessmentRevisionSources(revision).map(source=>({source,parentVersion:revision.version})));
  }
  const external=[...wanted.values()].filter(s=>s.kind!=="assessment_revision").sort((a,b)=>a.kind.localeCompare(b.kind)||a.id-b.id);
  if(external.length>128)assessmentFail(400,"source_reference_limit","عدد المراجع يتجاوز الحد.");
  return {external,revisions};
}
export async function resolveAssessmentSourceGraph(client:DbClient,scope:AssessmentScope,direct:AssessmentSourceV2[],imagingVisible:boolean):Promise<AssessmentSourceGraph>{
  const {external,revisions}=await collectAssessmentSourceClosure(client,scope,direct);
  if(!imagingVisible&&external.some(s=>s.kind==="document"||s.kind==="ceph_study"))assessmentFail(403,"imaging_restricted","المراجع المصورة مقيدة بالصلاحية الحالية.");
  const current=await captureAssessmentExternalSources(client,scope,external,imagingVisible);
  return {external,revisions,states:assessmentSourceStates({external,revisions},current),historicallyReadable:current.historicallyReadable};
}
/** Multi-document callers expand every immutable graph first, capture the union
 * once before any Ortho/bridge lock, then evaluate each expected version separately.
 * A union may contain two historical versions of one identity: that is not a new
 * write conflict and must not erase either graph's expected witness. */
export async function captureAssessmentExternalSources(client:DbClient,scope:AssessmentScope,union:readonly Pick<AssessmentSourceV2,"kind"|"id">[],imagingVisible:boolean):Promise<AssessmentExternalCapture>{
  if(union.some(s=>!positiveId(s.id)||!["document","ceph_study","patient_history","clinical_visit"].includes(s.kind)))assessmentFail(400,"invalid_source_target","هدف المرجع الخارجي غير صالح.");
  if(!imagingVisible&&union.some(s=>s.kind==="document"||s.kind==="ceph_study"))assessmentFail(403,"imaging_restricted","المراجع المصورة مقيدة بالصلاحية الحالية.");
  const unique=[...new Map(union.filter(s=>s.kind!=="assessment_revision").map(s=>[key(s),s])).values()];
  if(unique.length>128)assessmentFail(400,"source_reference_limit","عدد المراجع يتجاوز الحد.");
  return currentAssessmentExternalSources(client,scope,unique,true);
}
export function assessmentSourceStates(closure:{external:AssessmentSourceV2[];revisions:Map<number,AnyAssessmentRevision>},current:Map<string,AssessmentSourceChoiceV2>):AssessmentSourceStateV2[]{
  const {external,revisions}=closure;
  const states:AssessmentSourceStateV2[]=[...revisions.values()].map(r=>({source:{kind:"assessment_revision",id:r.id,version:`sha256:${r.contentHash}`},state:"available"}));
  for(const source of external){const now=current.get(key(source));states.push({source,state:!now?"unavailable":now.version===source.version?"available":"changed"});}
  return states;
}
// Versioned payloads deliberately exclude ownership and physical schema shape.
// Ownership is checked independently in WHERE clauses and the case/document graph.
export const ASSESSMENT_CEPH_CLINICAL_V1 = "jsonb_build_object('projection','ceph-clinical-v1','documentId',c.document_id,'status',c.status,'calibration',jsonb_build_array(c.cal_x1,c.cal_y1,c.cal_x2,c.cal_y2,c.cal_mm),'mmPerPixel',c.mm_per_pixel,'note',c.note,'createdBy',c.created_by,'createdAt',c.created_at,'completedBy',c.completed_by,'completedAt',c.completed_at,'phase',c.phase,'xrayDate',c.xray_date,'device',c.device,'referenceSet',c.ref_set)";
export const ASSESSMENT_HISTORY_CLINICAL_V1 = "jsonb_build_object('projection','patient-history-clinical-v1','answers',h.answers,'allergies',h.allergies,'medications',h.medications,'asaClass',h.asa_class,'bloodGroup',h.blood_group,'notes',h.notes,'patientConfirmed',h.patient_confirmed,'recordedBy',h.recorded_by,'recordedAt',h.recorded_at)";

/** Only a minimal clinical projection enters source hashing; no invoice/price fields. */
async function currentAssessmentExternalSources(client:DbClient,scope:AssessmentScope,sources:readonly Pick<AssessmentSourceV2,"kind"|"id">[],lock:boolean):Promise<AssessmentExternalCapture>{
  const readable=new Set<string>(),result:AssessmentExternalCapture=Object.assign(new Map<string,AssessmentSourceChoiceV2>(),{historicallyReadable:readable}),ids=(kind:AssessmentSourceV2["kind"])=>sources.filter(s=>s.kind===kind).map(s=>s.id);
  let admittedBytes=0;
  const admit=(raw:unknown)=>{const bytes=assessmentStoredByteCount(raw);if(bytes===null)assessmentFail(409,"invalid_source_budget","تعذّر التحقق من حجم المصدر.");admittedBytes+=bytes;if(admittedBytes>ASSESSMENT_EXTERNAL_SOURCE_MAX_BYTES)assessmentFail(409,"source_resource_limit","المصادر السريرية تتجاوز حد القراءة الآمنة.");};
  const cephIds=ids("ceph_study");
  // Discover backing documents without trusting their ownership; acquire documents
  // before studies and revalidate the exact study/document linkage after waiting.
  const discovered=cephIds.length?(await client.query<{id:number;document_id:number}>("SELECT id,document_id FROM ceph_analyses WHERE patient_id=$1 AND id=ANY($2::bigint[])",[scope.patientId,cephIds])).rows:[];
  const documentIds=[...new Set([...ids("document"),...discovered.map(s=>s.document_id)])].sort((a,b)=>a-b);
  const documents=documentIds.length?(await client.query<{id:number;sha256:string;title:string;removed_at:Date|null;ortho_case_id:number|null}>(
    `SELECT id,sha256,LEFT(title,200) AS title,removed_at,ortho_case_id FROM patient_documents WHERE patient_id=$1 AND id=ANY($2::int[]) ORDER BY id ${lock?"FOR SHARE":""}`,[scope.patientId,documentIds])).rows:[];
  const ownedDocuments=new Map(documents.filter(d=>d.ortho_case_id===null||d.ortho_case_id===scope.orthoCaseId).map(d=>[d.id,d]));
  for(const d of ownedDocuments.values())readable.add(`document:${d.id}`);
  const usable=new Map(documents.filter(d=>d.removed_at===null&&(d.ortho_case_id===null||d.ortho_case_id===scope.orthoCaseId)&&/^[a-f0-9]{64}$/.test(d.sha256)).map(d=>[d.id,d]));
  for(const d of usable.values())if(ids("document").includes(d.id))result.set(`document:${d.id}`,{kind:"document",id:d.id,version:`sha256:${d.sha256}`,label:d.title.slice(0,200)||`مستند #${d.id}`});
  if(cephIds.length){const studies=(await client.query<{id:string|number;document_id:number;ortho_case_id:number|null;status:string;bytes:string}>(
    `SELECT id,document_id,ortho_case_id,status,octet_length(( ${ASSESSMENT_CEPH_CLINICAL_V1} )::text)::text AS bytes FROM ceph_analyses c WHERE patient_id=$1 AND id=ANY($2::bigint[]) ORDER BY id ${lock?"FOR SHARE":""}`,[scope.patientId,cephIds])).rows;
    for(const s of studies){const id=Number(s.id),d=usable.get(s.document_id);
      if(!Number.isSafeInteger(id)||!ownedDocuments.has(s.document_id)||(s.ortho_case_id!==null&&s.ortho_case_id!==scope.orthoCaseId)||discovered.find(x=>Number(x.id)===id)?.document_id!==s.document_id)continue;
      readable.add(`ceph_study:${id}`);if(!d||s.status==="discarded")continue;
      admit(s.bytes);
      // Parent study SHARE protects the canonical child writers. Admit aggregate
      // bytes/counts before any child array or large note crosses the connection.
      for(const table of ["ceph_landmarks","ceph_measurements","ceph_diagnoses"] as const){
        const meta=(await client.query<{bytes:string;count:string}>(`SELECT COALESCE(SUM(octet_length(to_jsonb(t)::text)),0)::text AS bytes,COUNT(*)::text AS count FROM ${table} t WHERE analysis_id=$1`,[id])).rows[0];
        const count=assessmentStoredByteCount(meta?.count);if(count===null||count>ASSESSMENT_CEPH_SOURCE_MAX_CHILD_ROWS)assessmentFail(409,"source_resource_limit","سجل القياسات المرجعي يتجاوز حد القراءة الآمنة.");admit(meta?.bytes);
      }
      const facts=(await client.query<{facts:unknown}>(`SELECT ${ASSESSMENT_CEPH_CLINICAL_V1} AS facts FROM ceph_analyses c WHERE id=$1 AND patient_id=$2`,[id,scope.patientId])).rows[0]?.facts;
      const landmarks=(await client.query("SELECT code,x,y,source,confirmed_by,confirmed_at FROM ceph_landmarks WHERE analysis_id=$1 ORDER BY code",[id])).rows;
      const measurements=(await client.query("SELECT code,value FROM ceph_measurements WHERE analysis_id=$1 ORDER BY code,id",[id])).rows;
      const diagnosis=(await client.query("SELECT skeletal,dental,soft_tissue,note,final_dx,created_by,updated_at FROM ceph_diagnoses WHERE analysis_id=$1",[id])).rows;
      result.set(`ceph_study:${id}`,{kind:"ceph_study",id,version:version({projection:"assessment-ceph-source-v1",study:facts,documentHash:d.sha256,landmarks,measurements,diagnosis}),label:`دراسة سيفالومترية #${id}`});}
  }
  const historyIds=ids("patient_history");if(historyIds.length){const rows=(await client.query<{id:number;bytes:string}>(
    `SELECT id,octet_length(( ${ASSESSMENT_HISTORY_CLINICAL_V1} )::text)::text AS bytes FROM patient_medical_history h WHERE patient_id=$1 AND id=ANY($2::int[]) ORDER BY id ${lock?"FOR SHARE":""}`,[scope.patientId,historyIds])).rows;
    for(const r of rows){admit(r.bytes);readable.add(`patient_history:${r.id}`);}
    for(const r of rows){const facts=(await client.query<{facts:unknown}>(`SELECT ${ASSESSMENT_HISTORY_CLINICAL_V1} AS facts FROM patient_medical_history h WHERE id=$1 AND patient_id=$2`,[r.id,scope.patientId])).rows[0]?.facts;
      result.set(`patient_history:${r.id}`,{kind:"patient_history",id:r.id,version:version(facts),label:`التاريخ الطبي #${r.id}`});}}
  const visitFacts="jsonb_build_object('caseId',case_id,'complaint',chief_complaint,'examination',examination,'diagnosis',diagnosis,'treatment',treatment_done,'nextPlan',next_plan,'addendum',addendum,'doctorId',doctor_id,'signedAt',signed_at,'signedBy',signed_by)";
  const visitIds=ids("clinical_visit");if(visitIds.length){const rows=(await client.query<{id:number;bytes:string}>(
    `SELECT id,octet_length((${visitFacts})::text)::text AS bytes FROM visits WHERE patient_id=$1 AND case_id=$2 AND id=ANY($3::int[]) ORDER BY id ${lock?"FOR SHARE":""}`,[scope.patientId,scope.clinicalCaseId,visitIds])).rows;
    for(const r of rows){admit(r.bytes);readable.add(`clinical_visit:${r.id}`);}
    for(const r of rows){const facts=(await client.query<{facts:unknown}>(`SELECT ${visitFacts} AS facts FROM visits WHERE id=$1 AND patient_id=$2 AND case_id=$3`,[r.id,scope.patientId,scope.clinicalCaseId])).rows[0]?.facts;
      result.set(`clinical_visit:${r.id}`,{kind:"clinical_visit",id:r.id,version:version(facts),label:`زيارة سريرية #${r.id}`});}}
  return result;
}
export function validateAssessmentCopies(draft:AssessmentDraftV2,graph:AssessmentSourceGraph):void{
  for(const row of draft.observations.observations){const copy=row.provenance?.copiedFrom;if(!copy)continue;
    const revision=graph.revisions.get(copy.revisionId);
    if(!revision||revision.schemaVersion!==2||copy.kind!=="observation_v2"||copy.contentHash!==revision.contentHash)assessmentFail(409,"unsupported_copy_source","مرجع النسخ التاريخي غير مدعوم؛ لم تُخمن قيمه.");
    const original=revision.content.draft.observations.observations.find(o=>o.id===copy.observationId);
    if(!original||!sameAssessmentStructure({definition:row.definition,definitionVersion:row.definitionVersion,unit:row.unit,target:row.target,value:row.value,occurredOn:row.occurredOn,performer:row.provenance?.performer},
      {definition:original.definition,definitionVersion:original.definitionVersion,unit:original.unit,target:original.target,value:original.value,occurredOn:original.occurredOn,performer:original.provenance?.performer}))
      assessmentFail(409,"copied_value_changed","القيمة المنسوخة أو شاهدها لا يطابق المرجع؛ وثّق القياس الجديد صراحة.");
  }
}
/** Choices are bounded hints, never save authority; POST revalidates every exact version. */
export async function listAssessmentSourceChoices(client:DbClient,scope:AssessmentScope,imagingVisible:boolean,history:AnyAssessmentRevision[]):Promise<{items:AssessmentSourceChoiceV2[];truncated:boolean;imaging:"allowed"|"restricted"}>{
  const sources:AssessmentSourceV2[]=[];let truncated=false;
  const collect=async(kind:AssessmentSourceV2["kind"],sql:string,params:unknown[])=>{
    const rows=(await client.query<{id:number|string}>(sql,params)).rows;truncated ||= rows.length>100;
    for(const r of rows.slice(0,100)){const id=Number(r.id);if(Number.isSafeInteger(id)&&id>0)sources.push({kind,id,version:"choice-pending"});}
  };
  if(imagingVisible){
    await collect("document","SELECT id FROM patient_documents WHERE patient_id=$1 AND removed_at IS NULL AND (ortho_case_id IS NULL OR ortho_case_id=$2) ORDER BY id DESC LIMIT 101",[scope.patientId,scope.orthoCaseId]);
    await collect("ceph_study","SELECT id FROM ceph_analyses WHERE patient_id=$1 AND status<>'discarded' AND (ortho_case_id IS NULL OR ortho_case_id=$2) ORDER BY id DESC LIMIT 101",[scope.patientId,scope.orthoCaseId]);
  }
  await collect("patient_history","SELECT id FROM patient_medical_history WHERE patient_id=$1 ORDER BY id DESC LIMIT 101",[scope.patientId]);
  await collect("clinical_visit","SELECT id FROM visits WHERE patient_id=$1 AND case_id=$2 ORDER BY id DESC LIMIT 101",[scope.patientId,scope.clinicalCaseId]);
  const candidates=[...(await currentAssessmentExternalSources(client,scope,sources,false)).values(),...history.slice(0,100).map(r=>({kind:"assessment_revision" as const,id:r.id,version:`sha256:${r.contentHash}`,label:`تقييم محفوظ · نسخة ${r.version}`}))];
  truncated ||= history.length>100||candidates.length>100;
  return {items:candidates.slice(0,100),truncated,imaging:imagingVisible?"allowed":"restricted"};
}
