import {describe,it,expect} from 'vitest';
import {computeAll,MEASUREMENTS,REQUIRED_LANDMARKS,type LandmarkMap} from '../lib/ceph';
import {assessCephCalculationReadiness as assess} from '../lib/ceph-calculation-readiness';
const valid:LandmarkMap={
  S: { x: 100, y: 100 }, N: { x: 169, y: 92 }, A: { x: 167.57, y: 151.98 },
  B: { x: 163.84, y: 179.85 }, Pog: { x: 164.03, y: 186.87 }, Me: { x: 160, y: 205 },
  Go: { x: 82.97, y: 169.08 }, Or: { x: 160, y: 125 }, Po: { x: 100, y: 125 },
  U1A: { x: 160, y: 134 }, U1: { x: 174.08, y: 171.44 },
  L1A: { x: 149, y: 199.2 }, L1: { x: 168, y: 164 },
  OcclA: { x: 170, y: 148 }, OcclP: { x: 100, y: 135.3 }, Gn: { x: 161.5, y: 195.5 },
};
const coincident=():LandmarkMap=>Object.fromEntries(REQUIRED_LANDMARKS.map(code=>[code,{x:100,y:100}]));
describe('shared current-draft computational readiness',()=>{
 it('accepts real valid required geometry and reports optional absence without blocking',()=>{
  const result=assess(valid,1,computeAll(valid,1));
  expect(result.ready).toBe(true);expect(result.optionalMissing.length).toBeGreaterThan(0);
  expect(result.unavailable).toEqual([]);
 });
 it('blocks a supplied degenerate optional axis while allowing its absence',()=>{
  const map={...valid,ANS:{x:50,y:50},PNS:{x:50,y:50}};
  const result=assess(map,1,computeAll(map,1));
  expect(result.ready).toBe(false);expect(result.unavailable).toContain('PALATAL_ANS_PNS');
  expect(result.unavailable).toContain('U1_PP');expect(result.missingRequired).toEqual([]);
 });
 it('does not mistake all-present coincident geometry for completion readiness',()=>{
  const map=coincident();expect(REQUIRED_LANDMARKS.every(code=>map[code]!=null)).toBe(true);
  const result=assess(map,1,computeAll(map,1));
  expect(result.missingRequired).toEqual([]);expect(result.ready).toBe(false);expect(result.unavailable).toContain('SNA');
 });
 it('distinguishes absent required inputs, missing optional inputs, and invalid supplied points',()=>{
  const map=coincident();delete map.N;map.S={x:NaN,y:0};
  const result=assess(map,1,computeAll(map,1));
  expect(result.missingRequired).toEqual(['N']);expect(result.invalidLandmarks).toEqual(['S']);
  expect(result.optionalMissing.some(r=>r.landmarks.includes('ANS'))).toBe(true);
  expect(result.unavailable).not.toContain('SNA');
 });
 it('accepts finite zero, null or omitted optional results, without requiring optional landmarks',()=>{
  const map=coincident();const results=MEASUREMENTS.filter(d=>d.needs.every(k=>map[k]!=null)).map(d=>({code:d.code,value:0}));
  expect(assess(map,1,results).ready).toBe(true);
  expect(assess(map,1,[...results,{code:'PALATAL_ANS_PNS',value:null}]).ready).toBe(true);
 });
 it('refuses duplicate, unknown, nonfinite, and populated results without required inputs',()=>{
  const map=coincident();const results=MEASUREMENTS.filter(d=>d.needs.every(k=>map[k]!=null)).map(d=>({code:d.code,value:0}));
  for(const extra of [results[0],{code:'unknown',value:null},{code:'PALATAL_ANS_PNS',value:1}])expect(assess(map,1,[...results,extra]).invalidResults).toBe(true);
  for(const value of [NaN,Infinity,-Infinity])expect(assess(map,1,[{code:'SNA',value}]).invalidResults).toBe(true);
  expect(assess(map,1,results.filter(r=>r.code!=='SNA')).unavailable).toContain('SNA');
 });
 it.each([0,-1,NaN,Infinity,-Infinity])('reports invalid completion calibration %s separately',scale=>{
  const result=assess({},scale,[]);expect(result.calibrationValid).toBe(false);expect(result.ready).toBe(false);
 });
 it('does not mutate points or results and reports deterministic canonical ordering',()=>{
  const map=coincident(),results=computeAll(map,1),before=structuredClone({map,results});
  const a=assess(map,1,results),b=assess(map,1,[...results].reverse());
  expect(a).toEqual(b);expect({map,results}).toEqual(before);
 });
});

// Frozen former server predicate: parity, not a second clinical algorithm.
function priorGate(map:LandmarkMap,results:{code:string;value:number|null}[]){
 const definitions=new Map(MEASUREMENTS.map(d=>[d.code,d])),seen=new Set<string>();
 for(const result of results){const d=definitions.get(result.code);
  if(!d||seen.has(result.code)||(result.value!=null&&(!Number.isFinite(result.value)||!d.needs.every(c=>map[c]!=null))))return false;
  seen.add(result.code);
 }
 return !MEASUREMENTS.some(d=>d.needs.every(c=>map[c]!=null)&&!Number.isFinite(results.find(r=>r.code===d.code)?.value));
}
it('preserves the former server result gate across optional subsets and result faults',()=>{
 const keys=[...new Set(MEASUREMENTS.flatMap(d=>d.needs))];let comparisons=0;
 for(let offset=0;offset<keys.length;offset++){
  const map:LandmarkMap=Object.fromEntries(keys.filter((_,i)=>(i+offset)%4!==0).map(k=>[k,{x:1,y:2}]));
  const valid=MEASUREMENTS.map(d=>({code:d.code,value:d.needs.every(k=>map[k]!=null)?0:null}));
  const cases=[valid,valid.slice(1),[...valid,valid[0]],[...valid,{code:'unknown',value:null}],
   valid.map((r,i)=>i===offset%valid.length?{...r,value:Infinity}:r),
   valid.map((r,i)=>i===offset%valid.length?{...r,value:1}:r)];
  for(const rows of cases){const result=assess(map,1,rows);
   expect(!result.invalidResults&&!result.unavailable.length).toBe(priorGate(map,rows));comparisons++;
  }
 }
 expect(comparisons).toBeGreaterThan(100);
});
