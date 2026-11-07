import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {measure,computeAll,MEASUREMENTS,enrichWithRefs,getClinicalInterpretation,type LandmarkMap} from '../lib/ceph';
import {CEPH_ENGINE_SOURCE_SHA256,CEPH_ENGINE_VERSION} from '../lib/ceph-engine-identity';
const codes=['AFH_N_ME','LAFH_ANS_ME'] as const;
const points=():LandmarkMap=>({N:{x:0,y:0},ANS:{x:6,y:0},Me:{x:6,y:8}});
describe('direct descriptive anterior facial lengths',()=>{
 it('uses independent 6-8-10 and 8-pixel endpoint lengths, not projections or percentages',()=>{
  expect(measure(codes[0],points(),0.5)).toBe(5);
  expect(measure(codes[1],points(),0.5)).toBe(4);
 });
 it.each(codes)('%s requires only its two actual endpoints',code=>{
  const start=code===codes[0]?'N':'ANS';
  const minimal:LandmarkMap={[start]:{x:0,y:0},Me:{x:3,y:4}};
  expect(measure(code,minimal,2)).toBe(10);
  for(const key of [start,'Me'] as const){
   const missing={...minimal};delete missing[key];expect(measure(code,missing,2)).toBeNaN();
   for(const invalid of [NaN,Infinity,-Infinity]){
    expect(measure(code,{...minimal,[key]:{x:invalid,y:0}},2)).toBeNaN();
    expect(measure(code,{...minimal,[key]:{x:0,y:invalid}},2)).toBeNaN();
   }
  }
  expect(measure(code,{...minimal,Me:minimal[start]},2)).toBeNaN();
 });
 it.each(codes)('%s refuses invalid calibration and unrepresentable results',code=>{
  for(const scale of [0,-1,NaN,Infinity,-Infinity]) expect(measure(code,points(),scale)).toBeNaN();
  expect(measure(code,points(),Number.MAX_VALUE)).toBeNaN();
  const start=code===codes[0]?'N':'ANS';
  expect(measure(code,{[start]:{x:0,y:0},Me:{x:.1,y:0}},Number.MIN_VALUE)).toBeNaN();
  expect(measure(code,{[start]:{x:-Number.MAX_VALUE,y:0},Me:{x:Number.MAX_VALUE,y:0}},1)).toBeNaN();
  expect(computeAll({},1).find(r=>r.code===code)?.value).toBeNull();
 });
 it('uses robust hypot rather than squared lengths',()=>{
  expect(measure(codes[0],{N:{x:0,y:0},Me:{x:3e200,y:4e200}},1e-200)).toBeCloseTo(5,12);
  expect(measure(codes[1],{ANS:{x:0,y:0},Me:{x:3e-200,y:4e-200}},1e200)).toBeCloseTo(5,12);
 });
 it('does not impose lower <= total or depend on unrelated orientation anchors',()=>{
  const p={N:{x:0,y:1},Me:{x:0,y:0},ANS:{x:3,y:4},S:{x:NaN,y:NaN}};
  expect(measure(codes[0],p,1)).toBe(1);expect(measure(codes[1],p,1)).toBe(5);
  expect(measure(codes[1],{...p,N:{x:100,y:100}},1)).toBe(5);
  expect(measure(codes[0],{...p,ANS:{x:100,y:100}},1)).toBe(1);
 });
 it('preserves lengths under translations, rotations, reflections and reciprocal calibration',()=>{
  for(const degrees of [0,17,45,90,137,180,270,359])for(const flip of [-1,1])for(const zoom of [.25,1,4]){
   const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
   const transformed=Object.fromEntries(Object.entries(points()).map(([k,p])=>[k,{x:19+zoom*(flip*p!.x*c-p!.y*s),y:-27+zoom*(flip*p!.x*s+p!.y*c)}]));
   expect(measure(codes[0],transformed,.5/zoom)).toBeCloseTo(5,10);
   expect(measure(codes[1],transformed,.5/zoom)).toBeCloseTo(4,10);
  }
 });
 it.each(codes)('%s is calibrated, descriptive and rejects injected normative interpretation',code=>{
  const def=MEASUREMENTS.find(d=>d.code===code)!;
  expect(def).toMatchObject({unit:'mm',requiresCalibration:true,descriptiveOnly:true,mean:null,tol:null,calculationVersion:'anterior-direct-length-v1'});
  expect(def.populationReference).toBeUndefined();
  const raw=computeAll(points(),.5),before=structuredClone(points());
  const row=enrichWithRefs(raw,{[code]:{mean:99,sd:.01}}).find(r=>r.code===code)!;
  expect(row.status).toBeNull();expect(row.mean).toBeNull();expect(row.refSd).toBeNull();
  expect(getClinicalInterpretation(code,row.value).en).toMatch(/^Descriptive measurement;/);
  expect(JSON.parse(JSON.stringify(row))).toEqual(row);expect(points()).toEqual(before);
 });
 it('preserves existing ratios and leaves frozen historical arrays without new codes',()=>{
  const p={...points(),S:{x:0,y:0},Go:{x:0,y:6}};
  expect(measure('LAFH',p,.5)).toBe(80);expect(measure('JARABAK',p,.5)).toBe(60);
  expect(measure('LAFH',p,2)).toBe(80);expect(measure('JARABAK',p,2)).toBe(60);
  const saved=JSON.stringify([{code:'LAFH',value:80,unit:'%'}]);
  computeAll(p,.5);expect(JSON.parse(saved)).toEqual([{code:'LAFH',value:80,unit:'%'}]);
  const input=structuredClone(p);computeAll(p,.5);expect(p).toEqual(input);
 });
 it('pins explicit current source identity',()=>{
  expect(CEPH_ENGINE_VERSION).toBe('2026-11-06.5');
  expect(createHash('sha256').update(readFileSync('lib/ceph.ts')).digest('hex')).toBe(CEPH_ENGINE_SOURCE_SHA256);
 });
});
