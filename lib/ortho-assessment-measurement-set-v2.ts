import { keys, plain, type Checked } from "./ortho-assessment-model";
import { checkAssessmentObservationSetV2, observationIdV2, type AssessmentObservationSetV2 } from "./ortho-assessment-v2";
export interface AssessmentMeasurementSetV2 {
  id:string;toothWidthObservationIds:string[];upperAvailableObservationId:string|null;lowerAvailableObservationId:string|null;
}
export const DISABLED_ASSESSMENT_METHODS=["moyers","tanaka_johnston","huckaba","ashley_howe","stanley_kerber","pont","linder_harth","peck_peck"] as const;
export type DraftAnalysisSelectionV2={state:"draft";id:string;measurementSetId:string}&(
  {method:"arch_space";arch:"upper"|"lower"}|{method:"bolton_anterior"|"bolton_overall"}|{method:typeof DISABLED_ASSESSMENT_METHODS[number]}
);
export interface AssessmentDraftV2 {
  schemaVersion:2;observations:AssessmentObservationSetV2;measurementSets:AssessmentMeasurementSetV2[];analyses:DraftAnalysisSelectionV2[];
}
const fail=(code:string):Checked<never>=>({ok:false,code});
export function checkAssessmentDraftV2(raw:unknown):Checked<AssessmentDraftV2>{
  if(!plain(raw)||!keys(raw,["schemaVersion","observations","measurementSets","analyses"])||raw.schemaVersion!==2
    ||!Array.isArray(raw.measurementSets)||raw.measurementSets.length>12||!Array.isArray(raw.analyses)||raw.analyses.length>36)return fail("invalid_assessment_draft");
  const observations=checkAssessmentObservationSetV2(raw.observations);if(!observations.ok)return observations;
  const all=observations.value.observations,measurementSets:AssessmentMeasurementSetV2[]=[];
  const sourceVersions=new Map<string,string>();
  for(const observation of all)for(const source of observation.provenance?.sources??[]){
    const key=`${source.kind}:${source.id}`,prior=sourceVersions.get(key);
    if(prior!==undefined&&prior!==source.version)return fail("conflicting_source_versions");sourceVersions.set(key,source.version);
  }
  if(sourceVersions.size>128||[...sourceVersions.keys()].filter(k=>k.startsWith("assessment_revision:")).length>32)return fail("source_reference_limit");
  for(const s of raw.measurementSets){
    if(!plain(s)||!keys(s,["id","toothWidthObservationIds","upperAvailableObservationId","lowerAvailableObservationId"])
      ||!observationIdV2(s.id)||measurementSets.some(x=>x.id===s.id)||!Array.isArray(s.toothWidthObservationIds)||s.toothWidthObservationIds.length>52
      ||s.toothWidthObservationIds.some(x=>!observationIdV2(x))||new Set(s.toothWidthObservationIds).size!==s.toothWidthObservationIds.length)return fail("invalid_measurement_set");
    const toothWidthObservationIds=s.toothWidthObservationIds;
    const widths=all.filter(o=>toothWidthObservationIds.includes(o.id));
    if(widths.length!==s.toothWidthObservationIds.length||widths.some(o=>o.definition!=="mesiodistal_width"||o.target.kind!=="tooth")
      ||new Set(widths.map(o=>o.target.kind==="tooth"?o.target.tooth:0)).size!==widths.length)return fail("invalid_tooth_width_reference");
    for(const arch of ["upper","lower"] as const){const field=arch==="upper"?s.upperAvailableObservationId:s.lowerAvailableObservationId;
      if(field!==null&&(!observationIdV2(field)||!all.some(o=>o.id===field&&o.definition==="arch_available_space"&&o.target.kind==="arch"&&o.target.arch===arch)))return fail("invalid_available_reference");}
    measurementSets.push({id:s.id,toothWidthObservationIds:s.toothWidthObservationIds as string[],upperAvailableObservationId:s.upperAvailableObservationId as string|null,lowerAvailableObservationId:s.lowerAvailableObservationId as string|null});
  }
  const analyses:DraftAnalysisSelectionV2[]=[];
  for(const a of raw.analyses){
    if(!plain(a)||!observationIdV2(a.id)||!observationIdV2(a.measurementSetId)||a.state!=="draft"
      ||analyses.some(x=>x.id===a.id)||!measurementSets.some(s=>s.id===a.measurementSetId))return fail("invalid_analysis_selection");
    const common={state:"draft" as const,id:a.id,measurementSetId:a.measurementSetId};
    if(a.method==="arch_space"&&keys(a,["state","id","measurementSetId","method","arch"])&&(a.arch==="upper"||a.arch==="lower"))
      analyses.push({...common,method:"arch_space",arch:a.arch});
    else if((a.method==="bolton_anterior"||a.method==="bolton_overall")&&keys(a,["state","id","measurementSetId","method"]))analyses.push({...common,method:a.method});
    else if(typeof a.method==="string"&&DISABLED_ASSESSMENT_METHODS.some(m=>m===a.method)&&keys(a,["state","id","measurementSetId","method"]))
      analyses.push({...common,method:a.method as typeof DISABLED_ASSESSMENT_METHODS[number]});
    else return fail("unsupported_analysis_selection");
  }
  // Fresh arrays prevent mutation of the caller's raw command after normalization.
  return {ok:true,value:{schemaVersion:2,observations:observations.value,measurementSets:measurementSets.map(s=>({...s,toothWidthObservationIds:[...s.toothWidthObservationIds]})),analyses}};
}

export { deriveDraftAnalysisV2 } from "./ortho-assessment-engine-v2";
/** Explicit decimal mode; untouched and unfinished text never become zero. */
export type ClinicalNumberParseV2={state:"valid";value:number}|{state:"missing"|"partial"|"invalid"};
export function parseClinicalNumberV2(text:unknown,decimal:"."|","|"٫"):ClinicalNumberParseV2{
  if(typeof text!=="string"||text.length>80||![".",",","٫"].includes(decimal))return {state:"invalid"};
  const value=text.trim().replace(/[٠-٩]/g,c=>String(c.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,c=>String(c.charCodeAt(0)-0x6f0));
  if(value==="")return {state:"missing"};
  const separator=decimal==="."?"\\.":decimal;
  if(new RegExp(`^[+-]?(?:${separator}|\\d+${separator})?$`).test(value))return {state:"partial"};
  if(!new RegExp(`^[+-]?(?:\\d+(?:${separator}\\d+)?|${separator}\\d+)$`).test(value))return {state:"invalid"};
  const parsed=Number(value.replace(decimal,"."));
  return Number.isFinite(parsed)&&Math.abs(parsed)<=1_000_000?{state:"valid",value:parsed}:{state:"invalid"};
}
