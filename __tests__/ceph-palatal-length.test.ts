import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {measure,computeAll,MEASUREMENTS,enrichWithRefs,getClinicalInterpretation,type LandmarkMap} from '../lib/ceph';
import {CEPH_ENGINE_SOURCE_SHA256,CEPH_ENGINE_VERSION} from '../lib/ceph-engine-identity';
const code='PALATAL_ANS_PNS';
const points=():LandmarkMap=>({ANS:{x:2,y:1},PNS:{x:5,y:5}});
describe('direct descriptive palatal length',()=>{
 it('measures independent3-4-5 length, not horizontal/vertical projection or Co-A',()=>{
  expect(measure(code,points(),2)).toBe(10);
  expect(measure(code,{...points(),Co:{x:900,y:200},A:{x:900,y:300}},2)).toBe(10);
 });
 it.each(['ANS','PNS'] as const)('requires actual finite %s',key=>{
  const p=points();delete p[key];expect(measure(code,p,2)).toBeNaN();
  for(const bad of [NaN,Infinity,-Infinity])for(const axis of ['x','y']){
   expect(measure(code,{...points(),[key]:{x:1,y:2,[axis]:bad}},2)).toBeNaN();
  }
 });
 it('refuses exact coincidence but preserves arbitrarily small representable positive length',()=>{
  expect(measure(code,{ANS:{x:2,y:1},PNS:{x:2,y:1}},2)).toBeNaN();
  const p={ANS:{x:0,y:0},PNS:{x:1e-10,y:0}};
  expect(measure(code,p,1)).toBe(1e-10);
  expect(computeAll(p,1).find(r=>r.code===code)?.value).toBe(0);
 });
 it('refuses invalid calibration and nonrepresentable outputs',()=>{
  for(const scale of [0,-1,NaN,Infinity,-Infinity])expect(measure(code,points(),scale)).toBeNaN();
  expect(measure(code,points(),Number.MAX_VALUE)).toBeNaN();
  expect(measure(code,{ANS:{x:0,y:0},PNS:{x:.1,y:0}},Number.MIN_VALUE)).toBeNaN();
  expect(measure(code,{ANS:{x:-Number.MAX_VALUE,y:0},PNS:{x:Number.MAX_VALUE,y:0}},1)).toBeNaN();
  expect(computeAll({},1).find(r=>r.code===code)?.value).toBeNull();
 });
 it('uses robust hypot at large and small coordinate scales',()=>{
  expect(measure(code,{ANS:{x:0,y:0},PNS:{x:3e200,y:4e200}},1e-200)).toBeCloseTo(5,12);
  expect(measure(code,{ANS:{x:0,y:0},PNS:{x:3e-200,y:4e-200}},1e200)).toBeCloseTo(5,12);
 });
 it('is invariant under rigid transforms, endpoint reversal and reciprocal calibration',()=>{
  for(const degrees of [0,17,45,90,137,180,270,359])for(const flip of [-1,1])for(const zoom of [.25,1,4]){
   const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
   const p=Object.fromEntries(Object.entries(points()).map(([k,v])=>[k,{x:19+zoom*(flip*v!.x*c-v!.y*s),y:-27+zoom*(flip*v!.x*s+v!.y*c)}]));
   expect(measure(code,p,2/zoom)).toBeCloseTo(10,10);
   expect(measure(code,{ANS:p.PNS,PNS:p.ANS},2/zoom)).toBeCloseTo(10,10);
  }
 });
 it('ignores unrelated orientation points and retains descriptive neutral provenance',()=>{
  const p={...points(),S:{x:NaN,y:Infinity},Me:{x:0,y:0}};
  expect(measure(code,p,2)).toBe(10);
  expect(MEASUREMENTS.find(d=>d.code===code)).toMatchObject({needs:['ANS','PNS'],unit:'mm',mean:null,tol:null,requiresCalibration:true,descriptiveOnly:true,calculationVersion:'palatal-direct-length-v1'});
  const row=computeAll(p,2).find(r=>r.code===code)!;
  expect(enrichWithRefs([row],{[code]:{mean:99,sd:.01}})[0]).toMatchObject({mean:null,tol:null,status:null,refMean:null,refSd:null,z:null,diff:null});
  expect(getClinicalInterpretation(code,10).en).toMatch(/^Descriptive measurement;/);
  expect(JSON.parse(JSON.stringify(row))).toEqual(row);
 });
 it('does not mutate inputs or change existing palatal plane angle with segment length',()=>{
  const p:LandmarkMap={ANS:{x:4,y:2},PNS:{x:0,y:2},Po:{x:0,y:0},Or:{x:4,y:0},S:{x:0,y:0},N:{x:4,y:0},Me:{x:4,y:8}};
  const before=structuredClone(p);
  expect(measure('PP_FH',p,1)).toBe(0);
  expect(measure('PP_FH',{...p,ANS:{x:8,y:2}},1)).toBe(0);
  expect(measure(code,p,1)).toBe(4);expect(measure(code,{...p,ANS:{x:8,y:2}},1)).toBe(8);
  computeAll(p,1);expect(p).toEqual(before);
 });
 it('pins versioned engine source',()=>{
  expect(CEPH_ENGINE_VERSION).toBe('2026-11-06.5');
  expect(createHash('sha256').update(readFileSync('lib/ceph.ts')).digest('hex')).toBe(CEPH_ENGINE_SOURCE_SHA256);
 });
});
