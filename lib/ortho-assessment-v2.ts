import { assessmentDate, assessmentFinite, boundedText, keys, plain, positiveId, type Checked } from "./ortho-assessment-model";
export type AssessmentSourceV2 = { kind:"document"|"ceph_study"|"patient_history"|"clinical_visit"|"assessment_revision"; id:number; version:string };
export type ObservationTarget = {kind:"case"}|{kind:"arch";arch:"upper"|"lower"}|{kind:"side";side:"right"|"left"}|{kind:"tooth";tooth:number}|{kind:"contact";teeth:[number,number]}|{kind:"segment";teeth:number[]};
export type ObservationValueV2 = {state:"not_recorded"}|{state:"measured";value:number}|{state:"recorded";text:string}
  |{state:"unknown"|"not_measured"|"unavailable"|"not_applicable"|"tooth_absent"|"not_erupted";reason:string};
export type ObservationDateV2 = {state:"known";date:string}|{state:"unknown";reason:string};
export type CopiedObservationV2 = {kind:"observation_v2";revisionId:number;contentHash:string;observationId:string}
  |{kind:"legacy_field_v1";revisionId:number;contentHash:string;fieldPath:string};
export interface ObservationProvenanceV2 {
  performer:{state:"unknown"}|{state:"documented";attribution:string};
  method:{version:1;kind:"direct_examination"|"manual_record_measurement"|"external_report"|"legacy_revision";description:string};
  sources:AssessmentSourceV2[]; copiedFrom:CopiedObservationV2|null;
}
export type ObservationDefinitionV2 = "mesiodistal_width"|"arch_available_space"|"dentition"|"overjet"|"overbite"|"clinical_finding"|"growth_assessment";
export interface AssessmentObservationV2 {
  id:string;definition:ObservationDefinitionV2;definitionVersion:1;label:string;unit:"mm"|"qualitative";target:ObservationTarget;
  value:ObservationValueV2;occurredOn:ObservationDateV2|null;provenance:ObservationProvenanceV2|null;
}
export interface AssessmentObservationSetV2 {schemaVersion:2;dentitionObservationId:string|null;observations:AssessmentObservationV2[]}
const fail=(code:string):Checked<never>=>({ok:false,code});
export const observationIdV2=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const hash=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const isTooth=(v:unknown):v is number=>typeof v==="number"&&Number.isInteger(v)&&((v>=11&&v<=48&&v%10>=1&&v%10<=8)||(v>=51&&v<=85&&v%10>=1&&v%10<=5));
export function checkAssessmentSourceV2(raw:unknown):Checked<AssessmentSourceV2>{
  if(!plain(raw)||!keys(raw,["kind","id","version"])||typeof raw.kind!=="string"
    ||!["document","ceph_study","patient_history","clinical_visit","assessment_revision"].includes(raw.kind)||!positiveId(raw.id)||!boundedText(raw.version,200)
    ||raw.kind==="assessment_revision"&&!/^sha256:[a-f0-9]{64}$/.test(raw.version))return fail("invalid_source");
  return {ok:true,value:{kind:raw.kind as AssessmentSourceV2["kind"],id:raw.id,version:raw.version}};
}
function target(raw:unknown):Checked<ObservationTarget>{
  if(!plain(raw))return fail("invalid_target");
  if(raw.kind==="case"&&keys(raw,["kind"]))return {ok:true,value:{kind:"case"}};
  if(raw.kind==="arch"&&keys(raw,["kind","arch"])&&(raw.arch==="upper"||raw.arch==="lower"))return {ok:true,value:{kind:"arch",arch:raw.arch}};
  if(raw.kind==="side"&&keys(raw,["kind","side"])&&(raw.side==="right"||raw.side==="left"))return {ok:true,value:{kind:"side",side:raw.side}};
  if(raw.kind==="tooth"&&keys(raw,["kind","tooth"])&&isTooth(raw.tooth))return {ok:true,value:{kind:"tooth",tooth:raw.tooth}};
  if((raw.kind==="contact"||raw.kind==="segment")&&keys(raw,["kind","teeth"])&&Array.isArray(raw.teeth)
    &&raw.teeth.length>=(raw.kind==="contact"?2:2)&&raw.teeth.length<=(raw.kind==="contact"?2:32)
    &&raw.teeth.every(isTooth)&&new Set(raw.teeth).size===raw.teeth.length)
    return raw.kind==="contact"?{ok:true,value:{kind:"contact",teeth:[raw.teeth[0],raw.teeth[1]]}}:{ok:true,value:{kind:"segment",teeth:[...raw.teeth]}};
  return fail("invalid_target");
}
function date(raw:unknown):Checked<ObservationDateV2>{
  if(!plain(raw))return fail("missing_observation_date");
  if(raw.state==="known"&&keys(raw,["state","date"])&&assessmentDate(raw.date))return {ok:true,value:{state:"known",date:raw.date}};
  if(raw.state==="unknown"&&keys(raw,["state","reason"])&&boundedText(raw.reason,500))return {ok:true,value:{state:"unknown",reason:raw.reason}};
  return fail("invalid_observation_date");
}
function provenance(raw:unknown):Checked<ObservationProvenanceV2>{
  if(!plain(raw)||!keys(raw,["performer","method","sources","copiedFrom"])||!plain(raw.performer)||!plain(raw.method)
    ||!Array.isArray(raw.sources)||raw.sources.length>32)return fail("invalid_provenance");
  let performer:ObservationProvenanceV2["performer"];
  if(raw.performer.state==="unknown"&&keys(raw.performer,["state"]))performer={state:"unknown"};
  else if(raw.performer.state==="documented"&&keys(raw.performer,["state","attribution"])&&boundedText(raw.performer.attribution,500))performer={state:"documented",attribution:raw.performer.attribution};
  else return fail("invalid_performer");
  const m=raw.method;
  if(!keys(m,["version","kind","description"])||m.version!==1||typeof m.kind!=="string"
    ||!["direct_examination","manual_record_measurement","external_report","legacy_revision"].includes(m.kind)||!boundedText(m.description,500))return fail("invalid_method");
  const sources:AssessmentSourceV2[]=[];
  for(const s of raw.sources){const c=checkAssessmentSourceV2(s);if(!c.ok)return c;
    if(sources.some(x=>x.kind===c.value.kind&&x.id===c.value.id))return fail("duplicate_source");sources.push(c.value);}
  let copiedFrom:CopiedObservationV2|null=null;
  if(raw.copiedFrom!==null){const c=raw.copiedFrom;
    if(!plain(c)||!positiveId(c.revisionId)||!hash(c.contentHash))return fail("invalid_copy_reference");
    if(c.kind==="observation_v2"&&keys(c,["kind","revisionId","contentHash","observationId"])&&observationIdV2(c.observationId))
      copiedFrom={kind:c.kind,revisionId:c.revisionId,contentHash:c.contentHash,observationId:c.observationId};
    else if(c.kind==="legacy_field_v1"&&keys(c,["kind","revisionId","contentHash","fieldPath"])&&boundedText(c.fieldPath,200)&&/^[A-Za-z][A-Za-z0-9_.]*$/.test(c.fieldPath))
      copiedFrom={kind:c.kind,revisionId:c.revisionId,contentHash:c.contentHash,fieldPath:c.fieldPath};
    else return fail("invalid_copy_reference");
    if(!sources.some(s=>s.kind==="assessment_revision"&&s.id===c.revisionId&&s.version===`sha256:${c.contentHash}`))return fail("missing_copy_source");
  }
  if(m.kind==="legacy_revision"&&copiedFrom===null)return fail("missing_copy_reference");
  if(m.kind==="external_report"&&sources.length===0)return fail("missing_report_source");
  return {ok:true,value:{performer,method:{version:1,kind:m.kind as ObservationProvenanceV2["method"]["kind"],description:m.description},sources,copiedFrom}};
}
export function checkAssessmentObservationV2(raw:unknown):Checked<AssessmentObservationV2>{
  if(!plain(raw)||!keys(raw,["id","definition","definitionVersion","label","unit","target","value","occurredOn","provenance"])
    ||!observationIdV2(raw.id)||raw.definitionVersion!==1||!boundedText(raw.label,200)||typeof raw.definition!=="string"
    ||!["mesiodistal_width","arch_available_space","dentition","overjet","overbite","clinical_finding","growth_assessment"].includes(raw.definition))return fail("invalid_observation");
  const definition=raw.definition as ObservationDefinitionV2,t=target(raw.target);if(!t.ok)return t;
  const numeric=["mesiodistal_width","arch_available_space","overjet","overbite"].includes(definition);
  if(raw.unit!==(numeric?"mm":"qualitative")||definition==="mesiodistal_width"&&t.value.kind!=="tooth"
    ||definition==="arch_available_space"&&t.value.kind!=="arch"
    ||["dentition","overjet","overbite","growth_assessment"].includes(definition)&&t.value.kind!=="case")return fail("definition_unit_target_mismatch");
  if(!plain(raw.value))return fail("invalid_observation_value");const v=raw.value;let value:ObservationValueV2;
  if(v.state==="not_recorded"&&keys(v,["state"])){
    if(raw.occurredOn!==null||raw.provenance!==null)return fail("untouched_has_provenance");
    return {ok:true,value:{id:raw.id,definition,definitionVersion:1,label:raw.label,unit:numeric?"mm":"qualitative",target:t.value,value:{state:"not_recorded"},occurredOn:null,provenance:null}};
  }
  if(v.state==="measured"&&keys(v,["state","value"])&&numeric&&assessmentFinite(v.value)
    &&(["overjet","overbite"].includes(definition)||(definition==="arch_available_space"?v.value>=0:v.value>0)))value={state:"measured",value:v.value};
  else if(v.state==="recorded"&&keys(v,["state","text"])&&!numeric&&boundedText(v.text,4000)
    &&(definition!=="dentition"||["primary","mixed","permanent"].includes(v.text)))value={state:"recorded",text:v.text};
  else if(typeof v.state==="string"&&["unknown","not_measured","unavailable","not_applicable","tooth_absent","not_erupted"].includes(v.state)
    &&keys(v,["state","reason"])&&boundedText(v.reason,500)&&(!["tooth_absent","not_erupted"].includes(v.state)||t.value.kind==="tooth"))
    value={state:v.state as Extract<ObservationValueV2,{reason:string}>["state"],reason:v.reason};
  else return fail("invalid_observation_value");
  const d=date(raw.occurredOn),p=provenance(raw.provenance);if(!d.ok)return d;if(!p.ok)return p;
  return {ok:true,value:{id:raw.id,definition,definitionVersion:1,label:raw.label,unit:numeric?"mm":"qualitative",target:t.value,value,occurredOn:d.value,provenance:p.value}};
}
export function checkAssessmentObservationSetV2(raw:unknown):Checked<AssessmentObservationSetV2>{
  if(!plain(raw)||!keys(raw,["schemaVersion","dentitionObservationId","observations"])||raw.schemaVersion!==2
    ||!(raw.dentitionObservationId===null||observationIdV2(raw.dentitionObservationId))||!Array.isArray(raw.observations)||raw.observations.length>256)return fail("invalid_observation_set");
  const observations:AssessmentObservationV2[]=[];
  for(const r of raw.observations){const c=checkAssessmentObservationV2(r);if(!c.ok)return c;if(observations.some(o=>o.id===c.value.id))return fail("duplicate_observation_id");observations.push(c.value);}
  if(raw.dentitionObservationId!==null&&!observations.some(o=>o.id===raw.dentitionObservationId&&o.definition==="dentition"))return fail("invalid_dentition_reference");
  return {ok:true,value:{schemaVersion:2,dentitionObservationId:raw.dentitionObservationId,observations}};
}
// Browser editor names retained as explicit aliases of this single validation policy.
export const checkObservationV2=checkAssessmentObservationV2;
export const validFdi=isTooth;
export type ObservationProvenance=ObservationProvenanceV2;
export type ObservationValue=ObservationValueV2;
