import {describe,expect,it} from 'vitest';
import {projectStudyLongitudinalEligibility} from '../lib/ortho-study-longitudinal';
import {readStudyLongitudinalReview} from '../lib/ortho-study-longitudinal-contract';
import {syntheticLongitudinalStudy,rehashSyntheticLongitudinal} from './fixtures/ortho-study-longitudinal';
const expected=(s:ReturnType<typeof syntheticLongitudinalStudy>)=>({...s,revisionId:s.id,revisionHash:s.contentHash,authored:s.content.authored});
describe('legacy ceph longitudinal eligibility',()=>{
 it('preserves four explicit stages and six signed-order pair labels, but withholds every numeric delta',()=>{
  const saved=syntheticLongitudinalStudy(),before=JSON.stringify(saved),result=projectStudyLongitudinalEligibility(saved,saved);
  expect(result.stages.map(p=>p.stage)).toEqual(['T1','T2','T3','T4']);expect(result.pairs.map(p=>[p.from,p.to])).toEqual([['T1','T2'],['T1','T3'],['T1','T4'],['T2','T3'],['T2','T4'],['T3','T4']]);
  expect(result.pairs.every(p=>p.delta===null&&p.state==='unavailable')).toBe(true);
  for(const stage of result.stages){expect(stage.reasons).toEqual(['legacy_completion_witness_missing','measurement_unit_unversioned','formula_version_unversioned','reference_version_unversioned','calibration_not_captured']);expect(stage.sources[0].referenceSetKey).toBe(`synthetic_reference_${stage.stage.slice(1)}`);expect(stage.sources[0].contentHash).toBe(saved.content.sources[Number(stage.stage.slice(1))-1].selection.contentHash);}
  expect(result.stages[0].occurrence).toEqual({occurredOn:null,dateProvenance:'unknown',sourceNote:'Synthetic unknown date'});
  expect(JSON.stringify(result)).not.toContain('99999994');expect(JSON.stringify(result)).not.toContain('EXT_INDEX');expect(JSON.stringify(result)).not.toContain('improved');expect(JSON.stringify(saved)).toBe(before);
 });
 it('does not infer dates/order from phase, creation or acquisition dates',()=>{
  const saved=syntheticLongitudinalStudy();saved.content.authored.groups.reverse();saved.content.authored.groups[0].occurrence={occurredOn:'1900-01-01',dateProvenance:'retrospective_record',sourceNote:'Explicit reversed date'};
  const result=projectStudyLongitudinalEligibility(rehashSyntheticLongitudinal(saved),saved);expect(result.stages.map(s=>s.stage)).toEqual(['T1','T2','T3','T4']);expect(result.stages[3].occurrence.occurredOn).toBe('1900-01-01');expect(result.stages[0].occurrence.occurredOn).toBeNull();
 });
 it('shows missing, multiple, non-completed and removed-image limitations without selecting a source',()=>{
  const saved=syntheticLongitudinalStudy();saved.content.authored.groups[0].sourceKeys=[];saved.content.authored.groups[1].sourceKeys=['ceph1','ceph2'];
  saved.content.sources[2]={...saved.content.sources[2],state:'unavailable',unavailableReason:'ceph_review_projection_unavailable',payload:null};
  const last=saved.content.sources[3].payload as {status:string;image:{state:string}};last.status='draft';last.image.state='removed';
  const result=projectStudyLongitudinalEligibility(rehashSyntheticLongitudinal(saved),saved);
  expect(result.stages[0].reasons).toEqual(['no_ceph_source']);expect(result.stages[1].reasons).toContain('multiple_ceph_sources');expect(result.stages[1].sources).toHaveLength(2);
  expect(result.stages[2].sources[0]).toMatchObject({captureState:'unavailable',status:null,image:null,witness:'unavailable',reasons:['source_unavailable']});expect(result.stages[3].reasons).toEqual(expect.arrayContaining(['not_completed','image_unavailable']));
 });
 it('refuses tampered bytes, foreign scopes and fabricated current-unit/witness upgrades',()=>{
  const saved=syntheticLongitudinalStudy();expect(()=>projectStudyLongitudinalEligibility(saved,{...saved,patientId:20})).toThrow();expect(()=>projectStudyLongitudinalEligibility(saved,{...saved,orthoCaseId:42})).toThrow();
  saved.content.authored.comment='Changed after hash';expect(()=>projectStudyLongitudinalEligibility(saved,saved)).toThrow('revision_changed');
  const forged=syntheticLongitudinalStudy();(forged.content.sources[0].payload as {measurements:{unit:unknown}[]}).measurements[0].unit='degree';expect(()=>projectStudyLongitudinalEligibility(rehashSyntheticLongitudinal(forged),forged)).toThrow();
  const future=syntheticLongitudinalStudy();Object.assign(future.content.sources[0].payload as object,{completionWitness:{version:1}});expect(()=>projectStudyLongitudinalEligibility(rehashSyntheticLongitudinal(future),future)).toThrow();
 });
 it('preserves canonical patient merge display without treating recorded patient identity as authority',()=>{
  const saved=syntheticLongitudinalStudy();saved.patientId=20;expect(projectStudyLongitudinalEligibility(saved,saved).patientId).toBe(20);expect(saved.content.recordedPatientId).toBe(19);
 });
 it('strictly rejects forged numeric results, wrong revision/source/date and unsupported policy versions',()=>{
  const saved=syntheticLongitudinalStudy(),result=projectStudyLongitudinalEligibility(saved,saved);expect(readStudyLongitudinalReview(result,expected(saved))).toEqual(result);
  for(const mutate of [(r:typeof result)=>{r.pairs[0].delta=5 as never;},(r:typeof result)=>{r.revisionId++;},(r:typeof result)=>{r.stages[0].sources[0].id++;},(r:typeof result)=>{r.stages[0].occurrence.occurredOn='2026-01-01';},(r:typeof result)=>{r.policyVersion='future' as never;},(r:typeof result)=>{r.stages[0].reasons=[];}]){const changed=structuredClone(result);mutate(changed);expect(()=>readStudyLongitudinalReview(changed,expected(saved))).toThrow();}
 });
});

it('rejects coerced enum arrays and nonliteral source states',()=>{
 const saved=syntheticLongitudinalStudy(),value=projectStudyLongitudinalEligibility(saved,saved);
 for(const field of ['captureState','status','image.state'])for(const wrong of [['available'],['completed'],{toString:'available'},true,null,7]){
  const changed=structuredClone(value),source=changed.stages[0].sources[0] as unknown as Record<string,unknown>;
  if(field==='image.state')(source.image as Record<string,unknown>).state=wrong;else source[field]=wrong;
  expect(()=>readStudyLongitudinalReview(changed,expected(saved))).toThrow();
 }
});
