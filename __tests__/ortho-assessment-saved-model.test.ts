import {it,expect,vi} from 'vitest';
import {build} from 'esbuild';
import {buildSavedModelReview} from '../lib/ortho-assessment-saved-model';
import {assessmentCommandV2} from './fixtures/ortho-assessment-schema2';
import {tanakaCommandV2} from './fixtures/ortho-assessment-tanaka';
import {assessmentJsonHash} from '../lib/ortho-assessment-persisted-v2';
import {verifyAnyAssessmentRevisionBrowser} from '../lib/ortho-assessment-read-v2';
import {deriveDraftAnalysisV2 as derive21} from '../lib/ortho-assessment-engine-2_1_0';
import {deriveDraftAnalysisV2 as derive220} from '../lib/ortho-assessment-engine-2_2_0';
import {deriveDraftAnalysisV2 as derive221} from '../lib/ortho-assessment-engine-2_2_1';
import * as currentEngine from '../lib/ortho-assessment-engine-v2';
import type {AssessmentReadResponseV2} from '../lib/ortho-assessment-response-v2';
import type {AssessmentDraftV2} from '../lib/ortho-assessment-measurement-set-v2';
const expected={patientId:1,orthoCaseId:2,clinicalCaseId:3,revisionId:4};
async function fixture(version:'2.1.0'|'2.2.0'|'2.2.1'='2.2.1',draft:AssessmentDraftV2=assessmentCommandV2().content){draft=structuredClone(draft);draft.observations.observations[0].provenance!.sources=[{kind:'clinical_visit',id:10,version:'synthetic-v1'}];const derive=version==='2.1.0'?derive21:version==='2.2.0'?derive220:derive221;const results=draft.analyses.map(selection=>{const r=derive(draft,draft.measurementSets.find(s=>s.id===selection.measurementSetId),selection);if(!r.ok)throw Error(r.code);return {analysisId:selection.id,result:r.value,resultHash:assessmentJsonHash(r.value)};});const content={schemaVersion:2,verifierVersion:`ortho-assessment-payload-${version}`,draft,results};const raw={patientId:1,orthoCaseId:2,clinicalCaseId:3,id:4,recordedPatientId:1,schemaVersion:2,version:1,supersedesRevisionId:null,createdAt:'2026-01-01T00:00:00.000Z',createdBy:'Synthetic',reason:'Synthetic model review',recordingContext:'current',contentHash:assessmentJsonHash(content),content};const decoded=await verifyAnyAssessmentRevisionBrowser(raw,expected);if(!decoded.ok)throw Error(decoded.code);const sources=[...new Map(draft.observations.observations.flatMap(o=>o.provenance?.sources??[]).map(s=>[`${s.kind}:${s.id}`,s])).values()];const revision=decoded.value;const data:AssessmentReadResponseV2={ok:true,representation:2,state:'ready',patientId:1,orthoCaseId:2,clinicalCaseId:3,recordingContext:'current',clinicalWritable:true,revision,history:[{id:4,version:1,schemaVersion:2,recordedPatientId:1,supersedesRevisionId:null,createdAt:revision.createdAt,createdBy:revision.createdBy,reason:revision.reason,recordingContext:'current'}],sources:{items:[],truncated:false,imaging:'allowed'},sourceStates:sources.map(source=>({source,state:'available'}))};return data;}
it.each(['2.1.0','2.2.0','2.2.1'] as const)('preserves exact saved %s results hashes and input provenance',async v=>{const data=await fixture(v),result=buildSavedModelReview(data,expected);expect(result.ok).toBe(true);if(!result.ok||data.revision?.schemaVersion!==2)throw Error('fixture');expect(result.verifierVersion).toBe(data.revision.content.verifierVersion);expect(result.analyses.map(a=>a.stored)).toEqual(data.revision.content.results);expect(result.cast.measurementSets).toEqual(data.revision.content.draft.measurementSets);for(const o of result.cast.observations)expect(o).toEqual(data.revision.content.draft.observations.observations.find(x=>x.id===o.id));});
it.each(['2.2.0','2.2.1'] as const)('retains Tanaka stored formula/reference %s without current derivation',async v=>{const data=await fixture(v,tanakaCommandV2().content);const spy=vi.spyOn(currentEngine,'deriveDraftAnalysisV2').mockImplementation(()=>{throw Error('No recalculation allowed');});try{const r=buildSavedModelReview(data,expected);expect(r.ok).toBe(true);if(r.ok&&data.revision?.schemaVersion===2)expect(r.analyses[0].stored).toEqual(data.revision.content.results[0]);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}});
it('refuses conflicting scope selected revision IDs and missing stored entries',async()=>{const data=await fixture();for(const expectedPatch of [{patientId:99},{orthoCaseId:99},{clinicalCaseId:99},{revisionId:99}])expect(buildSavedModelReview(data,{...expected,...expectedPatch})).toMatchObject({ok:false});const bad=structuredClone(data);if(bad.revision?.schemaVersion!==2)throw Error('fixture');bad.revision.content.results.pop();expect(buildSavedModelReview(bad,expected)).toMatchObject({ok:false});});
it('preserves current source warnings separately and refuses missing/conflicting source entries',async()=>{const data=await fixture();expect(data.sourceStates.length).toBeGreaterThan(0);data.sourceStates[0].state='changed';const r=buildSavedModelReview(data,expected);expect(r.ok&&r.sourceStates[0].state).toBe('changed');expect(buildSavedModelReview({...data,sourceStates:[]},expected)).toMatchObject({ok:false});expect(buildSavedModelReview({...data,sourceStates:[...data.sourceStates,data.sourceStates[0]]},expected)).toMatchObject({ok:false});});
it('preserves no selected analyses distinctly from nonready results',async()=>{const draft=assessmentCommandV2().content;draft.analyses=[];const r=buildSavedModelReview(await fixture('2.2.1',draft),expected);expect(r).toMatchObject({ok:true,analyses:[]});});
it('has no runtime engine or server dependencies in a browser bundle',async()=>{const result=await build({entryPoints:['lib/ortho-assessment-saved-model.ts'],bundle:true,platform:'browser',write:false,metafile:true,logLevel:'silent'});expect(Object.keys(result.metafile!.inputs).join('\n')).not.toMatch(/engine|arithmetic|persisted-v2|read-v2|measurement-editor|db\.ts|node:/);});
it('does not mutate the verified input and detaches output',async()=>{const data=await fixture(),before=structuredClone(data),r=buildSavedModelReview(data,expected);expect(data).toEqual(before);if(!r.ok)throw Error(r.code);r.cast.observations[0].label='changed';r.sourceStates[0].state='unavailable';r.analyses[0].stored.resultHash='changed';expect(data).toEqual(before);});
it.each(['unknown','unavailable','not_measured'] as const)('preserves %s inputs and incomplete stored result without filling gaps',async state=>{
 const draft=tanakaCommandV2().content;draft.observations.observations.find(o=>o.id==='width_12')!.value={state,reason:'Synthetic missing measurement'};
 const data=await fixture('2.2.1',draft),r=buildSavedModelReview(data,expected);expect(r.ok).toBe(true);if(!r.ok)throw Error(r.code);
 expect(r.analyses[0].stored.result.state).toBe('incomplete');expect(r.cast.observations.find(o=>o.id==='width_12')!.value).toEqual({state,reason:'Synthetic missing measurement'});
});
it.each(['unsupported_dentition','inapplicable','outside_supported_predictor_domain'] as const)('retains saved refusal %s',async state=>{
 const draft=tanakaCommandV2().content;
 if(state==='unsupported_dentition')draft.observations.observations.find(o=>o.id==='dentition')!.value={state:'recorded',text:'primary'};
 if(state==='inapplicable')draft.observations.observations.find(o=>o.id==='width_31')!.value={state:'tooth_absent',reason:'Synthetic absent'};
 if(state==='outside_supported_predictor_domain')for(const o of draft.observations.observations)if(['width_31','width_32','width_41','width_42'].includes(o.id))o.value={state:'measured',value:7};
 const data=await fixture('2.2.1',draft),r=buildSavedModelReview(data,expected);expect(r.ok).toBe(true);if(!r.ok||data.revision?.schemaVersion!==2)throw Error('fixture');expect(r.analyses[0].stored.result.state).toBe(state);expect(r.analyses[0].stored).toEqual(data.revision.content.results[0]);
});
it('preserves disabled method unavailable witness and absence of approval',async()=>{
 const draft=assessmentCommandV2().content;draft.analyses=[{state:'draft',id:'disabled',measurementSetId:'current',method:'moyers'}];
 const r=buildSavedModelReview(await fixture('2.1.0',draft),expected);expect(r).toMatchObject({ok:true,clinicalApproval:'unapproved',analyses:[{clinicalApproval:'unapproved',stored:{result:{state:'ready',witness:{result:{state:'unavailable'}}}}}]});
});
it('rejects duplicate or missing relationship identities without recomputing hashes',async()=>{
 const data=await fixture();
 for(const mutate of [
  (d:AssessmentDraftV2)=>d.observations.observations.push(d.observations.observations[0]),
  (d:AssessmentDraftV2)=>d.observations.observations.shift(),
  (d:AssessmentDraftV2)=>d.measurementSets.push(d.measurementSets[0]),
  (d:AssessmentDraftV2)=>d.analyses.push(d.analyses[0]),
  (d:AssessmentDraftV2)=>{d.analyses[0].measurementSetId='missing';},
 ]){const bad=structuredClone(data);if(bad.revision?.schemaVersion!==2)throw Error('fixture');mutate(bad.revision.content.draft);expect(buildSavedModelReview(bad,expected)).toEqual({ok:false,code:'saved_model_invalid'});}
 const bad=structuredClone(data);bad.sourceStates[0].source.version='changed-version';expect(buildSavedModelReview(bad,expected)).toMatchObject({ok:false});
});
it('distinguishes unavailable revision from valid empty selection and preserves historical recorded owner',async()=>{
 const data=await fixture();expect(buildSavedModelReview({...data,revision:null},expected)).toEqual({ok:false,code:'saved_model_unavailable'});
 if(!data.revision)throw Error('fixture');data.revision.recordedPatientId=90;expect(buildSavedModelReview(data,expected)).toMatchObject({ok:true,revision:{patientId:1,recordedPatientId:90}});
});
it('uses the explicitly selected historical revision even when history lists a newer head',async()=>{
 const data=await fixture();data.history.unshift({...data.history[0],id:44,version:2,supersedesRevisionId:4});
 expect(buildSavedModelReview(data,expected)).toMatchObject({ok:true,revision:{id:4,version:1}});
 expect(buildSavedModelReview(data,{...expected,revisionId:44})).toEqual({ok:false,code:'saved_model_invalid'});
});
it('does not substitute current source picker metadata for saved values',async()=>{
 const data=await fixture(),before=buildSavedModelReview(data,expected);data.sources.imaging='restricted';data.sources.truncated=true;
 expect(buildSavedModelReview(data,expected)).toEqual(before);
});
