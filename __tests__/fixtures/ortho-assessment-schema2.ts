import type { AssessmentCommandV2 } from "../../lib/ortho-assessment-command-v2";
import type { AssessmentObservationV2,ObservationProvenance } from "../../lib/ortho-assessment-v2";
export function assessmentCommandV2():AssessmentCommandV2{
  const provenance=():ObservationProvenance=>({performer:{state:"documented",attribution:"Synthetic examiner"},method:{version:1,kind:"direct_examination",description:"Synthetic measurement fixture"},sources:[],copiedFrom:null});
  const observations:AssessmentObservationV2[]=[];
  for(const quadrant of [1,2,3,4])for(let n=1;n<=8;n++){const tooth=quadrant*10+n;
    observations.push({id:`width_${tooth}`,definition:"mesiodistal_width",definitionVersion:1,label:`FDI ${tooth}`,unit:"mm",target:{kind:"tooth",tooth},
      value:{state:"measured",value:7},occurredOn:{state:"known",date:"2026-01-01"},provenance:provenance()});}
  for(const arch of ["upper","lower"] as const)observations.push({id:`available_${arch}`,definition:"arch_available_space",definitionVersion:1,label:arch,unit:"mm",target:{kind:"arch",arch},
    value:{state:"measured",value:70},occurredOn:{state:"known",date:"2026-01-01"},provenance:provenance()});
  observations.push({id:"dentition",definition:"dentition",definitionVersion:1,label:"Dentition",unit:"qualitative",target:{kind:"case"},
    value:{state:"recorded",text:"permanent"},occurredOn:{state:"known",date:"2026-01-01"},provenance:provenance()});
  return {schemaVersion:2,commandId:"synthetic_assessment_command",expectedRevisionId:null,reason:"Synthetic initial measurements",content:{schemaVersion:2,
    observations:{schemaVersion:2,dentitionObservationId:"dentition",observations},measurementSets:[{id:"current",toothWidthObservationIds:observations.filter(o=>o.definition==="mesiodistal_width").map(o=>o.id),upperAvailableObservationId:"available_upper",lowerAvailableObservationId:"available_lower"}],
    analyses:[{state:"draft",id:"space_upper",measurementSetId:"current",method:"arch_space",arch:"upper"},{state:"draft",id:"space_lower",measurementSetId:"current",method:"arch_space",arch:"lower"},
      {state:"draft",id:"bolton_anterior",measurementSetId:"current",method:"bolton_anterior"},{state:"draft",id:"bolton_overall",measurementSetId:"current",method:"bolton_overall"}]}};
}
