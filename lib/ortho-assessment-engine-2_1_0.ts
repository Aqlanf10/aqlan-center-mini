/** Historical engine2.1.0. Add a new versioned module for changed formulas/references; never edit this implementation in place. */
import { plain,keys,type Checked } from "./ortho-assessment-model";
import type { AssessmentDraftV2,AssessmentMeasurementSetV2,DraftAnalysisSelectionV2 } from "./ortho-assessment-measurement-set-v2";
import type { AssessmentObservationV2 } from "./ortho-assessment-v2";
import { BOLTON_TEETH,SPACE_TEETH,boltonArithmetic,permanentArchSpaceArithmetic,type ToothWidthMm } from "./ortho-assessment-arithmetic-2_1_0";
export const ASSESSMENT_ENGINE_VERSION="ortho-model-2.1.0" as const;
export interface AssessmentReferenceV2 {
  id:string;version:1;percent:number;source:string;sourceVerification:"primary_verified";review:"unapproved";
}
export type AssessmentArithmeticResultV2={state:"unavailable";reason:string}
  |{state:"calculated";method:"arch_space";arch:"upper"|"lower";requiredMm:number;availableMm:number;availableMinusRequiredMm:number}
  |{state:"calculated";method:"bolton_anterior"|"bolton_overall";upperMm:number;lowerMm:number;ratioPercent:number;
    upperReference:{lowerMinusExpectedMm:number};lowerReference:{upperMinusExpectedMm:number}};
export interface AssessmentResultWitnessV2 {
  formula:{engineVersion:typeof ASSESSMENT_ENGINE_VERSION;formulaVersion:string};
  result:AssessmentArithmeticResultV2;reference:AssessmentReferenceV2|null;clinicalApproval:"unapproved";
}
export type MissingAnalysisInputV2={kind:"tooth_width";tooth:number;observationId:string|null}
  |{kind:"available_space";arch:"upper"|"lower";observationId:string|null}|{kind:"dentition";observationId:string|null};
export type DraftAnalysisReadinessV2={state:"incomplete";dependencyObservationIds:string[];missing:MissingAnalysisInputV2[]}
  |{state:"unsupported_dentition";dependencyObservationIds:string[]}
  |{state:"inapplicable";dependencyObservationIds:string[];reason:"tooth_absent"|"not_erupted";tooth:number}
  |{state:"ready";dependencyObservationIds:string[];witness:AssessmentResultWitnessV2};
const result=(value:DraftAnalysisReadinessV2):Checked<DraftAnalysisReadinessV2>=>({ok:true,value});
/** Reads selected dependencies only. Canonical command parser separately validates the entire saved draft. */
export function deriveDraftAnalysisV2(content:AssessmentDraftV2,set:AssessmentMeasurementSetV2|undefined,selection:DraftAnalysisSelectionV2):Checked<DraftAnalysisReadinessV2>{
  if(!plain(selection)||!keys(selection,selection.method==="arch_space"?["state","id","measurementSetId","method","arch"]:["state","id","measurementSetId","method"]))return {ok:false,code:"analysis_selection_changed"};
  const chosen=content.analyses.find(a=>a.id===selection.id);
  if(selection.state!=="draft"||!chosen||chosen.state!=="draft"||chosen.method!==selection.method
    ||chosen.measurementSetId!==selection.measurementSetId
    ||(chosen.method==="arch_space"&&(selection.method!=="arch_space"||chosen.arch!==selection.arch)))return {ok:false,code:"analysis_selection_changed"};
  const owned=content.measurementSets.find(s=>s.id===selection.measurementSetId);
  if(!owned||!set||set.id!==owned.id)return {ok:false,code:"measurement_set_unavailable"};
  const rows=content.observations.observations,dependencies:string[]=[],missing:MissingAnalysisInputV2[]=[];
  const take=(id:string|null):AssessmentObservationV2|undefined=>{if(id!==null&&!dependencies.includes(id))dependencies.push(id);return rows.find(r=>r.id===id);};
  const d=take(content.observations.dentitionObservationId);
  if(!d||d.value.state!=="recorded")missing.push({kind:"dentition",observationId:content.observations.dentitionObservationId});
  else if(d.value.text!=="permanent")return result({state:"unsupported_dentition",dependencyObservationIds:dependencies});
  if(selection.method!=="arch_space"&&selection.method!=="bolton_anterior"&&selection.method!=="bolton_overall")return result({state:"ready",dependencyObservationIds:dependencies,
    witness:{formula:{engineVersion:ASSESSMENT_ENGINE_VERSION,formulaVersion:`${selection.method}_disabled_reference_pending`},result:{state:"unavailable",reason:"Exact protocol/reference and clinical activation review pending"},reference:null,clinicalApproval:"unapproved"}});
  const mode=selection.method==="bolton_anterior"?"anterior":"overall";
  const upperTeeth=selection.method==="arch_space"?(selection.arch==="upper"?SPACE_TEETH.upper:[]):BOLTON_TEETH[mode].upper;
  const lowerTeeth=selection.method==="arch_space"?(selection.arch==="lower"?SPACE_TEETH.lower:[]):BOLTON_TEETH[mode].lower;
  const upper:ToothWidthMm[]=[],lower:ToothWidthMm[]=[];
  for(const [teeth,destination] of [[upperTeeth,upper],[lowerTeeth,lower]] as const)for(const tooth of teeth){
    const row=rows.find(r=>owned.toothWidthObservationIds.includes(r.id)&&r.definition==="mesiodistal_width"&&r.target.kind==="tooth"&&r.target.tooth===tooth);
    if(row)take(row.id);
    if(row&&(row.value.state==="tooth_absent"||row.value.state==="not_erupted"))return result({state:"inapplicable",dependencyObservationIds:dependencies,reason:row.value.state,tooth});
    if(!row||row.value.state!=="measured")missing.push({kind:"tooth_width",tooth,observationId:row?.id??null});
    else destination.push({tooth,value:row.value.value});
  }
  let available:AssessmentObservationV2|undefined;
  if(selection.method==="arch_space"){
    const id=selection.arch==="upper"?owned.upperAvailableObservationId:owned.lowerAvailableObservationId;
    available=take(id);if(!available||available.value.state!=="measured")missing.push({kind:"available_space",arch:selection.arch,observationId:id});
  }
  if(missing.length)return result({state:"incomplete",dependencyObservationIds:dependencies,missing});
  if(selection.method==="arch_space"){
    if(!available||available.value.state!=="measured")return {ok:false,code:"available_space_unavailable"};
    const a=permanentArchSpaceArithmetic(selection.arch,selection.arch==="upper"?upper:lower,available.value.value);if(!a.ok)return a;
    return result({state:"ready",dependencyObservationIds:dependencies,witness:{formula:{engineVersion:ASSESSMENT_ENGINE_VERSION,formulaVersion:"available_minus_required_v2"},
      result:{state:"calculated",method:"arch_space",arch:selection.arch,requiredMm:a.value.requiredMm,availableMm:a.value.availableMm,availableMinusRequiredMm:a.value.discrepancyMm},reference:null,clinicalApproval:"unapproved"}});
  }
  const reference:AssessmentReferenceV2={id:mode==="anterior"?"bolton_1962_anterior":"bolton_1962_overall",version:1,percent:mode==="anterior"?77.2:91.3,
    source:"Bolton 1962, DOI 10.1016/0002-9416(62)90129-X, pp.506–508,517",sourceVerification:"primary_verified",review:"unapproved"};
  const b=boltonArithmetic(mode,upper,lower,reference.percent);if(!b.ok)return b;
  return result({state:"ready",dependencyObservationIds:dependencies,witness:{formula:{engineVersion:ASSESSMENT_ENGINE_VERSION,formulaVersion:"bolton_lower_over_upper_v1"},
    result:{state:"calculated",method:selection.method,upperMm:b.value.upperSumMm,lowerMm:b.value.lowerSumMm,ratioPercent:b.value.ratioPercent,
      upperReference:{lowerMinusExpectedMm:b.value.upperReferenceLowerResidualMm},lowerReference:{upperMinusExpectedMm:b.value.lowerReferenceUpperResidualMm}},reference,clinicalApproval:"unapproved"}});
}
