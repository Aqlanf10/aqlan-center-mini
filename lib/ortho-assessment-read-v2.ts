import { assessmentTimestamp,boundedText,keys,plain,positiveId,type Checked } from "./ortho-assessment-model";
import { checkAssessmentDraftV2 } from "./ortho-assessment-measurement-set-v2";
import { deriveDraftAnalysisV2 } from "./ortho-assessment-engine-2_1_0";
import type { AnyAssessmentRevision,AssessmentRevisionV2,PersistedAssessmentContentV2 } from "./ortho-assessment-persisted-v2";
const fail=(code:string):Checked<never>=>({ok:false,code});
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
function stable(value:unknown,depth=0):unknown{
  if(depth>40)throw Error("structure_depth");
  if(value===null||typeof value==="string"||typeof value==="boolean")return value;
  if(typeof value==="number"&&Number.isFinite(value))return value;
  if(Array.isArray(value))return ["array",value.map(x=>stable(x,depth+1))];
  if(plain(value))return ["object",Object.keys(value).sort().map(k=>[k,stable(value[k],depth+1)])];
  throw Error("invalid_structure");
}
export function sameAssessmentStructure(a:unknown,b:unknown):boolean{
  try{return JSON.stringify(stable(a))===JSON.stringify(stable(b));}catch{return false;}
}
/** Version-pinned reconstruction. New engines must add verifiers, never change this historical version in place. */
export function decodePersistedAssessmentV2Structure(raw:unknown):Checked<PersistedAssessmentContentV2>{
  if(!plain(raw)||!keys(raw,["schemaVersion","verifierVersion","draft","results"])||raw.schemaVersion!==2
    ||raw.verifierVersion!=="ortho-assessment-payload-2.1.0"||!Array.isArray(raw.results))return fail("unsupported_payload_verifier");
  const draft=checkAssessmentDraftV2(raw.draft);if(!draft.ok)return draft;
  if(raw.results.length!==draft.value.analyses.length)return fail("invalid_result_witnesses");
  const results:PersistedAssessmentContentV2["results"]=[];
  for(let i=0;i<draft.value.analyses.length;i++){
    const selection=draft.value.analyses[i],entry=raw.results[i];
    if(!plain(entry)||!keys(entry,["analysisId","result","resultHash"])||entry.analysisId!==selection.id||!hash(entry.resultHash))return fail("invalid_result_witness");
    const expected=deriveDraftAnalysisV2(draft.value,draft.value.measurementSets.find(s=>s.id===selection.measurementSetId),selection);
    if(!expected.ok||!sameAssessmentStructure(entry.result,expected.value))return fail("result_reconstruction_mismatch");
    results.push({analysisId:selection.id,result:expected.value,resultHash:entry.resultHash});
  }
  return {ok:true,value:{schemaVersion:2,verifierVersion:"ortho-assessment-payload-2.1.0",draft:draft.value,results}};
}
export function decodeAnyAssessmentRevisionStructure(raw:unknown,scope:{patientId:number;orthoCaseId:number;clinicalCaseId:number}):Checked<AnyAssessmentRevision>{
  if(!plain(raw))return fail("invalid_revision");
  // No canonical schema1 implementation survived or exists in inspected published history.
  // Never interpret arbitrary old payloads or rewrite them under a guessed decoder.
  if(raw.schemaVersion!==2)return fail("unsupported_schema");
  try{if(new TextEncoder().encode(JSON.stringify(raw)).length>1_048_576)return fail("revision_too_large");}catch{return fail("invalid_revision");}
  if(!keys(raw,["id","patientId","recordedPatientId","orthoCaseId","clinicalCaseId","schemaVersion","version","supersedesRevisionId","createdAt","createdBy","reason","recordingContext","contentHash","content"])
    ||!positiveId(scope.patientId)||!positiveId(scope.orthoCaseId)||!positiveId(scope.clinicalCaseId)
    ||raw.patientId!==scope.patientId||raw.orthoCaseId!==scope.orthoCaseId||raw.clinicalCaseId!==scope.clinicalCaseId
    ||!positiveId(raw.id)||!positiveId(raw.recordedPatientId)||!positiveId(raw.version)
    ||!(raw.supersedesRevisionId===null||positiveId(raw.supersedesRevisionId))||(raw.version===1)!==(raw.supersedesRevisionId===null)||raw.supersedesRevisionId===raw.id
    ||!assessmentTimestamp(raw.createdAt)||!boundedText(raw.createdBy,200)||!boundedText(raw.reason,500)
    ||(raw.recordingContext!=="current"&&raw.recordingContext!=="retrospective")||!hash(raw.contentHash))return fail("invalid_revision");
  const content=decodePersistedAssessmentV2Structure(raw.content);if(!content.ok)return content;
  const revision:AssessmentRevisionV2={id:raw.id,patientId:scope.patientId,recordedPatientId:raw.recordedPatientId,orthoCaseId:scope.orthoCaseId,clinicalCaseId:scope.clinicalCaseId,
    schemaVersion:2,version:raw.version,supersedesRevisionId:raw.supersedesRevisionId,createdAt:raw.createdAt,createdBy:raw.createdBy,reason:raw.reason,
    recordingContext:raw.recordingContext,contentHash:raw.contentHash,content:content.value};
  return {ok:true,value:revision};
}
async function digest(value:unknown):Promise<string>{
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  const hash=await globalThis.crypto.subtle.digest("SHA-256",bytes);
  return Array.from(new Uint8Array(hash),n=>n.toString(16).padStart(2,"0")).join("");
}
export async function verifyAnyAssessmentRevisionBrowser(raw:unknown,scope:{patientId:number;orthoCaseId:number;clinicalCaseId:number}):Promise<Checked<AnyAssessmentRevision>>{
  const parsed=decodeAnyAssessmentRevisionStructure(raw,scope);if(!parsed.ok)return parsed;
  if(parsed.value.schemaVersion!==2)return fail("unsupported_schema");
  try{
    const revision=parsed.value;
    if(await digest(revision.content)!==revision.contentHash)return fail("invalid_content_hash");
    for(const entry of revision.content.results)if(await digest(entry.result)!==entry.resultHash)return fail("invalid_result_hash");
    return parsed;
  }catch{return fail("digest_unavailable");}
}
