import { expect, it } from 'vitest';
import { tanakaArchSpace } from '../lib/ortho-assessment-tanaka-1974-v1';
import { tanakaArchSpaceWithDecimalDomainV2 } from '../lib/ortho-assessment-tanaka-domain-v2';
import { deriveDraftAnalysisV2 as current } from '../lib/ortho-assessment-engine-2_2_1';
import { deriveDraftAnalysisV2 as historical } from '../lib/ortho-assessment-engine-2_2_0';
import { tanakaCommandV2 } from './fixtures/ortho-assessment-tanaka';

// Independent integer units: one unit = 0.005mm. Never import production tooth
// lists, constants, domain comparators or formula helpers to produce expectations.
const lower=(cents:number[])=>[31,32,41,42].map((tooth,i)=>({tooth,value:cents[i]/100}));
const upper=()=>[11,12,21,22].map((tooth,i)=>({tooth,value:[801,702,803,704][i]/100}));
function calculated<T>(value:{ok:true;value:T}|{ok:false;code:string}):T {if(!value.ok)throw Error(value.code);return value.value;}

it('checks every centi-mm predictor sum20.00..27.50 using an integer oracle for both arches',()=>{
 for(let sum=2000;sum<=2750;sum++) {
  // Three uneven fixed widths and varying fourth, all explicit synthetic inputs.
  const rows=lower([401,506,607,sum-1514]);
  for(const arch of ['upper','lower'] as const){
   const actual=calculated(tanakaArchSpaceWithDecimalDomainV2(arch,rows,arch==='upper'?upper():rows,80.03));
   const targetCents=arch==='upper'?3010:sum;
   const quadrantHalfCents=sum+(arch==='upper'?2200:2100);
   const requiredHalfCents=2*targetCents+2*quadrantHalfCents;
   expect(actual.withinPublishedTablePredictorDomain).toBe(sum>=2050&&sum<=2700);
   expect(actual.measuredLowerIncisorSumMm).toBeCloseTo(sum/100,11);
   expect(actual.measuredTargetIncisorSumMm).toBeCloseTo(targetCents/100,11);
   expect(actual.predictedCaninePremolarPerQuadrantMm).toBeCloseTo(quadrantHalfCents/200,11);
   expect(actual.predictedBothQuadrantsMm).toBeCloseTo(quadrantHalfCents/100,11);
   expect(actual.estimatedRequiredMm).toBeCloseTo(requiredHalfCents/200,11);
   expect(actual.availableMinusEstimatedRequiredMm).toBeCloseTo((16006-requiredHalfCents)/200,11);
   // The new policy does not alter any numerical field from historical v1.
   const old=calculated(tanakaArchSpace(arch,rows,arch==='upper'?upper():rows,80.03));
   expect({...actual,withinPublishedTablePredictorDomain:old.withinPublishedTablePredictorDomain}).toEqual(old);
  }
 }
});

it('each measured predictor affects both predicted segments, without substituting upper target incisors',()=>{
 const rows=lower([501,502,503,604]),target=upper();
 const base=calculated(tanakaArchSpaceWithDecimalDomainV2('upper',rows,target,80));
 for(let i=0;i<4;i++){
  const changed=rows.map((r,j)=>({...r,value:r.value+(i===j?0.2:0)}));
  const next=calculated(tanakaArchSpaceWithDecimalDomainV2('upper',changed,target,80));
  expect(next.predictedCaninePremolarPerQuadrantMm-base.predictedCaninePremolarPerQuadrantMm).toBeCloseTo(0.1,12);
  expect(next.estimatedRequiredMm-base.estimatedRequiredMm).toBeCloseTo(0.2,12);
  expect(next.measuredTargetIncisorSumMm).toBe(base.measuredTargetIncisorSumMm);
  const changedTarget=target.map((r,j)=>({...r,value:r.value+(i===j?0.3:0)}));
  const withTarget=calculated(tanakaArchSpaceWithDecimalDomainV2('upper',rows,changedTarget,80));
  expect(withTarget.predictedBothQuadrantsMm).toBe(base.predictedBothQuadrantsMm);
  expect(withTarget.estimatedRequiredMm-base.estimatedRequiredMm).toBeCloseTo(0.3,12);
 }
 const available=calculated(tanakaArchSpaceWithDecimalDomainV2('upper',rows,target,82.5));
 expect(available.estimatedRequiredMm).toBe(base.estimatedRequiredMm);
 expect(available.availableMinusEstimatedRequiredMm-base.availableMinusEstimatedRequiredMm).toBeCloseTo(2.5,12);
 const low=calculated(tanakaArchSpaceWithDecimalDomainV2('lower',rows,rows,80));
 const changed=rows.map((r,i)=>({...r,value:r.value+(i===0?0.2:0)}));
 const lowChanged=calculated(tanakaArchSpaceWithDecimalDomainV2('lower',changed,changed,80));
 expect(lowChanged.estimatedRequiredMm-low.estimatedRequiredMm).toBeCloseTo(0.4,12);
 expect(base.predictedBothQuadrantsMm-low.predictedBothQuadrantsMm).toBe(1);
});

it('all24 width permutations retain exact outputs without changing input arrays',()=>{
 const rows=lower([401,506,607,686]),before=structuredClone(rows),target=upper();
 const baseline=tanakaArchSpaceWithDecimalDomainV2('upper',rows,target,80);
 for(let a=0;a<4;a++)for(let b=0;b<4;b++)for(let c=0;c<4;c++)for(let d=0;d<4;d++){
  if(new Set([a,b,c,d]).size!==4)continue;
  expect(tanakaArchSpaceWithDecimalDomainV2('upper',[rows[a],rows[b],rows[c],rows[d]],[target[d],target[c],target[b],target[a]],80)).toEqual(baseline);
 }
 expect(rows).toEqual(before);
});

it('engine target-arch dependencies remain separate and off-target recorded teeth do not affect the result',()=>{
 for(const derive of [historical,current]){
  const draft=tanakaCommandV2().content;
  const first=calculated(derive(draft,draft.measurementSets[0],draft.analyses[0]));
  const lowerFirst=calculated(derive(draft,draft.measurementSets[0],draft.analyses[1]));
  draft.observations.observations.find(o=>o.id==='available_upper')!.value={state:'measured',value:77};
  draft.observations.observations.find(o=>o.id==='width_18')!.value={state:'unknown',reason:'Synthetic nondependency'};
  expect(derive(draft,draft.measurementSets[0],draft.analyses[1])).toEqual({ok:true,value:lowerFirst});
  const changed=calculated(derive(draft,draft.measurementSets[0],draft.analyses[0]));
  if(first.state!=='ready'||changed.state!=='ready')throw Error('Expected synthetic readiness');
  const a=first.witness.result,b=changed.witness.result;
  if(a.state!=='calculated'||b.state!=='calculated'||!('estimatedRequiredMm' in a)||!('estimatedRequiredMm' in b))throw Error('Expected Tanaka results');
  expect(b.estimatedRequiredMm).toBe(a.estimatedRequiredMm);
  expect(b.availableMinusEstimatedRequiredMm-a.availableMinusEstimatedRequiredMm).toBe(5);
  expect(changed.dependencyObservationIds).not.toContain('width_18');
 }
});
it('matches independently reviewed pencil cases at24mm predictor, with actual32mm upper target',()=>{
 const rows=lower([600,600,600,600]),target=[11,12,21,22].map(tooth=>({tooth,value:8}));
 expect(tanakaArchSpaceWithDecimalDomainV2('lower',rows,rows,68)).toMatchObject({ok:true,value:{predictedCaninePremolarPerQuadrantMm:22.5,predictedBothQuadrantsMm:45,estimatedRequiredMm:69,availableMinusEstimatedRequiredMm:-1}});
 expect(tanakaArchSpaceWithDecimalDomainV2('upper',rows,target,76)).toMatchObject({ok:true,value:{predictedCaninePremolarPerQuadrantMm:23,predictedBothQuadrantsMm:46,estimatedRequiredMm:78,availableMinusEstimatedRequiredMm:-2}});
});
