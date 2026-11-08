import { expect, it, vi } from "vitest";
import { prepareSpaceAssessmentSources } from "../lib/ortho-space-baselines";
import { createStudyAssessmentAccess } from "../lib/ortho-case-study-assessment-access";
import type { DbClient } from "../lib/db";
import type { JourneyAuthority, JourneyOwner } from "../lib/ortho-case-journey-authority";
const owner={patientId:1,orthoCaseId:2,clinicalCaseId:3} as JourneyOwner,actor={canViewPlans:true,canViewImages:true} as JourneyAuthority;
const ref=(id:number)=>({kind:"assessment_analysis" as const,id,member:"space_upper",version:`sha256:${"a".repeat(64)}`});
it.each(["1048577","invalid","-1"])("rejects metadata %s before fetching a payload",async bytes=>{
 const query=vi.fn().mockResolvedValueOnce({rows:[{id:1}]}).mockResolvedValueOnce({rows:[{bytes}]});
 await expect(prepareSpaceAssessmentSources({query} as unknown as DbClient,owner,actor,[],createStudyAssessmentAccess())).rejects.toMatchObject({code:"space_baseline_budget"});
 expect(query).toHaveBeenCalledTimes(2);expect(query.mock.calls.every(([sql])=>!String(sql).includes('SELECT id,patient_id'))).toBe(true);
});
it("rejects33 root revisions before any root payload fetch",async()=>{
 const query=vi.fn().mockResolvedValue({rows:[{id:33}]});
 await expect(prepareSpaceAssessmentSources({query} as unknown as DbClient,owner,actor,Array.from({length:33},(_,i)=>ref(i+1)),createStudyAssessmentAccess())).rejects.toMatchObject({code:"space_baseline_budget"});expect(query).toHaveBeenCalledTimes(1);
});
it("requires current plan visibility before database reads",async()=>{
 const query=vi.fn();await expect(prepareSpaceAssessmentSources({query} as unknown as DbClient,owner,{...actor,canViewPlans:false},[],createStudyAssessmentAccess())).rejects.toMatchObject({code:"space_plan_access"});expect(query).not.toHaveBeenCalled();
});
it("rejects callers that already locked their source union",async()=>{
 const query=vi.fn(),cache=createStudyAssessmentAccess();cache.current=Object.assign(new Map(),{historicallyReadable:new Set<string>()});
 await expect(prepareSpaceAssessmentSources({query} as unknown as DbClient,owner,actor,[],cache)).rejects.toMatchObject({code:"study_source_union_already_locked"});expect(query).not.toHaveBeenCalled();
});
import * as access from "../lib/ortho-case-study-assessment-access";
import { assessmentCommandV2 } from "./fixtures/ortho-assessment-schema2";
import { assessmentJsonHash, createPersistedAssessmentV2, type AnyAssessmentRevision } from "../lib/ortho-assessment-persisted-v2";
it("counts repeated retained closure payloads toward aggregate admission",async()=>{
 const payload=createPersistedAssessmentV2(assessmentCommandV2().content);if(!payload.ok)throw Error(payload.code);
 const row={id:1,patient_id:1,recorded_patient_id:1,ortho_case_id:2,clinical_case_id:3,schema_version:2,version:1,supersedes_revision_id:null,created_at:'2026-11-06T00:00:00.000Z',created_by:'Synthetic',reason:'Synthetic',recording_context:'current',content_sha256:assessmentJsonHash(payload.value),content:payload.value,actor_user_id:1,command_id:'synthetic_aggregate_001',request_fingerprint:'a'.repeat(64)};
 const query=vi.fn().mockResolvedValueOnce({rows:[{id:1}]}).mockResolvedValueOnce({rows:[{bytes:String(JSON.stringify(payload.value).length)}]}).mockResolvedValueOnce({rows:[row]});
 const cache=createStudyAssessmentAccess();
 // Dependency stub isolates accounting. Four retained2MiB closures represent
 // repeated immutable payload copies; each expansion is below its4MiB limit.
 const prepare=vi.spyOn(access,'prepareStudyAssessmentAccess').mockImplementation(async()=>{
  for(let i=0;i<4;i++)cache.closures.set(String(i),{revision:{} as AnyAssessmentRevision,closure:{external:[],revisions:new Map([[1,{content:{note:'x'.repeat(2097152)}} as unknown as AnyAssessmentRevision]])}});
 });
 try{await expect(prepareSpaceAssessmentSources({query} as unknown as DbClient,owner,actor,[],cache)).rejects.toMatchObject({code:'space_baseline_budget'});}finally{prepare.mockRestore();}
});
