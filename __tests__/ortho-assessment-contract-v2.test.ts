import { describe,it,expect } from "vitest";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";
import { checkAnyAssessmentCommand } from "../lib/ortho-assessment-command-v2";
import { checkObservationV2 } from "../lib/ortho-assessment-v2";
import { checkAssessmentDraftV2,deriveDraftAnalysisV2,parseClinicalNumberV2 } from "../lib/ortho-assessment-measurement-set-v2";
import { createPersistedAssessmentV2,assessmentJsonHash,decodeAnyAssessmentRevision } from "../lib/ortho-assessment-persisted-v2";
import { verifyAnyAssessmentRevisionBrowser,sameAssessmentStructure } from "../lib/ortho-assessment-read-v2";
import { confirmAssessmentAppendV2 } from "../lib/ortho-assessment-response-v2";
const scope={patientId:1,orthoCaseId:2,clinicalCaseId:3};
function fixture(){const command=assessmentCommandV2(),content=createPersistedAssessmentV2(command.content);if(!content.ok)throw Error(content.code);
  const revision={...scope,id:4,recordedPatientId:1,schemaVersion:2,version:1,supersedesRevisionId:null,createdAt:"2026-01-01T00:00:00.000Z",createdBy:"Synthetic recorder",reason:command.reason,recordingContext:"current",content:content.value,contentHash:assessmentJsonHash(content.value)};
  return {command,revision};}
describe("new assessment contract preserves unknowns and exact source witnesses",()=>{
  it("does not confuse object properties with arrays of pairs",()=>{expect(sameAssessmentStructure({a:1},[["a",1]])).toBe(false);});
  it("refuses approved, forged and stale direct analysis selections",()=>{
    const d=assessmentCommandV2().content,set=d.measurementSets[0],selection=d.analyses[0];
    const derive=deriveDraftAnalysisV2 as (content:typeof d,measurementSet:typeof set,selection:unknown)=>unknown;
    for(const invalid of [{...selection,state:"approved"},{...selection,id:"foreign"},{...selection,method:"bolton_overall"},{...selection,arch:"lower"},{...selection,extra:true}])
      expect(derive(d,set,invalid)).toEqual({ok:false,code:"analysis_selection_changed"});
  });
  it("keeps blank, partial, invalid and valid localized numbers distinct",()=>{
    expect(parseClinicalNumberV2("", ".")).toEqual({state:"missing"});
    for(const text of ["-","+",".","-2."])expect(parseClinicalNumberV2(text,".")).toEqual({state:"partial"});
    expect(parseClinicalNumberV2("-٢٫٥","٫")).toEqual({state:"valid",value:-2.5});
    expect(parseClinicalNumberV2("۰",",")).toEqual({state:"valid",value:0});
    for(const text of ["1e2","1٬000","1,2","Infinity"])expect(parseClinicalNumberV2(text,".").state).toBe("invalid");
  });
  it("accepts explicit zero space but never zero tooth width or provenance on untouched fields",()=>{
    const d=assessmentCommandV2().content,space=d.observations.observations.find(o=>o.id==="available_upper")!;
    expect(checkObservationV2({...space,value:{state:"measured",value:0}}).ok).toBe(true);
    const width=d.observations.observations[0];expect(checkObservationV2({...width,value:{state:"measured",value:0}}).ok).toBe(false);
    expect(checkObservationV2({...width,value:{state:"not_recorded"}}).ok).toBe(false);
    expect(checkObservationV2({...width,value:{state:"not_recorded"},occurredOn:null,provenance:null}).ok).toBe(true);
    expect(checkObservationV2({...width,value:{state:"unknown",reason:"Not supplied"},occurredOn:null,provenance:null}).ok).toBe(false);
  });
  it("uses exact dependencies, keeps absent inapplicable and reports exact missing teeth",()=>{
    const d=assessmentCommandV2().content,s=d.measurementSets[0],a=d.analyses[3];
    const tooth=d.observations.observations.find(o=>o.id==="width_16")!;tooth.value={state:"not_recorded"};tooth.occurredOn=null;tooth.provenance=null;
    const missing=deriveDraftAnalysisV2(d,s,a);expect(missing).toMatchObject({ok:true,value:{state:"incomplete",missing:[{kind:"tooth_width",tooth:16,observationId:"width_16"}]}});
    tooth.value={state:"tooth_absent",reason:"Explicit synthetic missing tooth"};
    expect(deriveDraftAnalysisV2(d,s,a)).toMatchObject({ok:true,value:{state:"inapplicable",reason:"tooth_absent",tooth:16}});
    expect(deriveDraftAnalysisV2(d,s,d.analyses[2])).toMatchObject({ok:true,value:{state:"ready"}});
  });
  it("rejects duplicate tooth membership, injected results and conflicting source versions",()=>{
    const c=assessmentCommandV2();c.content.measurementSets[0].toothWidthObservationIds.push("width_11");expect(checkAnyAssessmentCommand(c).ok).toBe(false);
    expect(checkAnyAssessmentCommand({...assessmentCommandV2(),results:[]} ).ok).toBe(false);
    const d=assessmentCommandV2().content;
    d.observations.observations[0].provenance!.sources=[{kind:"document",id:1,version:"a"}];
    d.observations.observations[1].provenance!.sources=[{kind:"document",id:1,version:"b"}];
    expect(checkAssessmentDraftV2(d)).toEqual({ok:false,code:"conflicting_source_versions"});
  });
  it("refuses unknown legacy schemas without transforming their bytes",()=>{
    const f=fixture(),old={...f.revision,schemaVersion:1,content:{sources:[],unknownLegacyField:"preserve"}},before=JSON.stringify(old);
    expect(decodeAnyAssessmentRevision(old,scope)).toEqual({ok:false,code:"unsupported_schema"});expect(JSON.stringify(old)).toBe(before);
    expect(checkAnyAssessmentCommand({...f.command,schemaVersion:1})).toEqual({ok:false,code:"unsupported_schema"});
  });
  it("verifies server and browser hashes, exact command response and unapproved result status",async()=>{
    const f=fixture();expect(decodeAnyAssessmentRevision(f.revision,scope).ok).toBe(true);
    expect((await verifyAnyAssessmentRevisionBrowser(f.revision,scope)).ok).toBe(true);
    expect((await confirmAssessmentAppendV2({ok:true,revision:f.revision,replayed:false},{scope,command:f.command,previousVersion:0})).ok).toBe(true);
    expect((await confirmAssessmentAppendV2({ok:true,revision:f.revision,replayed:false},{scope,command:{...f.command,reason:"different"},previousVersion:0})).ok).toBe(false);
    const changed=structuredClone(f.revision);changed.content.results[0].resultHash="f".repeat(64);changed.contentHash=assessmentJsonHash(changed.content);
    expect(decodeAnyAssessmentRevision(changed,scope).ok).toBe(false);
    for(const r of f.revision.content.results)if(r.result.state==="ready")expect(r.result.witness.clinicalApproval).toBe("unapproved");
  });
});
