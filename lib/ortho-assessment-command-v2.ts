import { boundedText,keys,plain,positiveId,type Checked } from "./ortho-assessment-model";
import { checkAssessmentDraftV2,type AssessmentDraftV2 } from "./ortho-assessment-measurement-set-v2";
import type { AssessmentSourceV2 } from "./ortho-assessment-v2";
export interface AssessmentCommandV2 {schemaVersion:2;commandId:string;expectedRevisionId:number|null;reason:string;content:AssessmentDraftV2}
/** Declared only for legacy consumer narrowing. No unknown schema1 command is admitted. */
export interface UnsupportedAssessmentCommandV1 {schemaVersion:1;commandId:string;expectedRevisionId:number|null;reason:string;content:unknown}
export type AnyAssessmentCommand=AssessmentCommandV2|UnsupportedAssessmentCommandV1;
export function checkAnyAssessmentCommand(raw:unknown):Checked<AnyAssessmentCommand>{
  const fail=(code:string):Checked<never>=>({ok:false,code});
  if(!plain(raw))return fail("invalid_command");
  if(raw.schemaVersion!==2)return fail("unsupported_schema");
  if(!keys(raw,["schemaVersion","commandId","expectedRevisionId","reason","content"])||typeof raw.commandId!=="string"
    ||!/^[A-Za-z0-9_-]{16,80}$/.test(raw.commandId)||!(raw.expectedRevisionId===null||positiveId(raw.expectedRevisionId))||!boundedText(raw.reason,500))return fail("invalid_command");
  const content=checkAssessmentDraftV2(raw.content);if(!content.ok)return content;
  const sources=assessmentDraftSources(content.value);
  if(sources.length>128||sources.filter(s=>s.kind==="assessment_revision").length>32)return fail("source_reference_limit");
  // Conflicting versions for one source identity cannot be hidden by deduplication.
  const seen=new Map<string,string>();
  for(const row of content.value.observations.observations)for(const source of row.provenance?.sources??[]){
    const key=`${source.kind}:${source.id}`,previous=seen.get(key);if(previous!==undefined&&previous!==source.version)return fail("conflicting_source_versions");seen.set(key,source.version);
  }
  return {ok:true,value:{schemaVersion:2,commandId:raw.commandId,expectedRevisionId:raw.expectedRevisionId,reason:raw.reason,content:content.value}};
}
export function assessmentDraftSources(draft:AssessmentDraftV2):AssessmentSourceV2[]{
  const sources:AssessmentSourceV2[]=[];
  for(const o of draft.observations.observations)for(const s of o.provenance?.sources??[])
    if(!sources.some(x=>x.kind===s.kind&&x.id===s.id&&x.version===s.version))sources.push({...s});
  return sources.sort((a,b)=>a.kind.localeCompare(b.kind)||a.id-b.id||a.version.localeCompare(b.version));
}
