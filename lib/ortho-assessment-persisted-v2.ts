import { createHash } from "node:crypto";
import type { Checked } from "./ortho-assessment-model";
import { checkAssessmentDraftV2,type AssessmentDraftV2 } from "./ortho-assessment-measurement-set-v2";
import { deriveDraftAnalysisV2,type DraftAnalysisReadinessV2 } from "./ortho-assessment-engine-v2";
import { assessmentDraftSources } from "./ortho-assessment-command-v2";
import { decodeAnyAssessmentRevisionStructure } from "./ortho-assessment-read-v2";
import type { AssessmentSourceV2 } from "./ortho-assessment-v2";
export { checkAnyAssessmentCommand } from "./ortho-assessment-command-v2";
export type { AssessmentCommandV2,AnyAssessmentCommand } from "./ortho-assessment-command-v2";
export const ASSESSMENT_PAYLOAD_VERIFIER="ortho-assessment-payload-2.1.0" as const;
export interface PersistedAssessmentContentV2 {schemaVersion:2;verifierVersion:typeof ASSESSMENT_PAYLOAD_VERIFIER;draft:AssessmentDraftV2;results:{analysisId:string;result:DraftAnalysisReadinessV2;resultHash:string}[]}
export interface AssessmentRevisionBase {
  id:number;patientId:number;recordedPatientId:number;orthoCaseId:number;clinicalCaseId:number;version:number;supersedesRevisionId:number|null;
  createdAt:string;createdBy:string;reason:string;recordingContext:"current"|"retrospective";contentHash:string;
}
export interface AssessmentRevisionV2 extends AssessmentRevisionBase {schemaVersion:2;content:PersistedAssessmentContentV2}
/** Type-only readback compatibility. Decoder refuses this unavailable historical format. */
export interface UnsupportedAssessmentRevisionV1 extends AssessmentRevisionBase {schemaVersion:1;content:{sources:AssessmentSourceV2[];[key:string]:unknown}}
export type AnyAssessmentRevision=AssessmentRevisionV2|UnsupportedAssessmentRevisionV1;
export const assessmentJsonHash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function createPersistedAssessmentV2(raw:unknown):Checked<PersistedAssessmentContentV2>{
  const parsed=checkAssessmentDraftV2(raw);if(!parsed.ok)return parsed;const draft=parsed.value,results:PersistedAssessmentContentV2["results"]=[];
  for(const selection of draft.analyses){const result=deriveDraftAnalysisV2(draft,draft.measurementSets.find(s=>s.id===selection.measurementSetId),selection);if(!result.ok)return result;
    results.push({analysisId:selection.id,result:result.value,resultHash:assessmentJsonHash(result.value)});}
  return {ok:true,value:{schemaVersion:2,verifierVersion:ASSESSMENT_PAYLOAD_VERIFIER,draft,results}};
}
export function decodeAnyAssessmentRevision(raw:unknown,scope:{patientId:number;orthoCaseId:number;clinicalCaseId:number}):Checked<AnyAssessmentRevision>{
  const parsed=decodeAnyAssessmentRevisionStructure(raw,scope);if(!parsed.ok)return parsed;
  if(parsed.value.schemaVersion!==2)return {ok:false,code:"unsupported_schema"};
  const revision=parsed.value;
  if(assessmentJsonHash(revision.content)!==revision.contentHash||revision.content.results.some(r=>assessmentJsonHash(r.result)!==r.resultHash))return {ok:false,code:"invalid_content_hash"};
  return parsed;
}
export function assessmentRevisionSources(revision:AnyAssessmentRevision):AssessmentSourceV2[]{
  return revision.schemaVersion===2?assessmentDraftSources(revision.content.draft):revision.content.sources;
}
