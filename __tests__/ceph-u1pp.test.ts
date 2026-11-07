import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {measure,computeAll,MEASUREMENTS,enrichWithRefs,getClinicalInterpretation,type LandmarkMap} from '../lib/ceph';
import {CEPH_ENGINE_SOURCE_SHA256,CEPH_ENGINE_VERSION} from '../lib/ceph-engine-identity';
const code='U1_PP';
const points=(x=-1,y=Math.sqrt(3)):LandmarkMap=>({ANS:{x:0,y:0},PNS:{x:-2,y:0},U1A:{x:3,y:4},U1:{x:3+x,y:4+y}});
describe('posterior upper incisor to palatal plane angle',()=>{
 it.each([[-1,Math.sqrt(3),60],[0,2,90],[1,Math.sqrt(3),120],[-2,0,0],[2,0,180]])('direct ray inclination (%s,%s) gives%s degrees',(x,y,angle)=>{
  expect(measure(code,points(x,y),NaN)).toBeCloseTo(angle,12);
 });
 it('does not fold the supplementary60 and120 angles or force an obtuse result',()=>{
  expect(measure(code,points(),0)).toBeCloseTo(60,12);
  expect(measure(code,points(1,Math.sqrt(3)),0)).toBeCloseTo(120,12);
  const p=points();
  expect(measure(code,{...p,ANS:p.PNS,PNS:p.ANS},0)).toBeCloseTo(120,12);
  expect(measure(code,{ANS:p.PNS,PNS:p.ANS,U1A:p.U1,U1:p.U1A},0)).toBeCloseTo(60,12);
 });
 it.each(['ANS','PNS','U1A','U1'] as const)('requires actual finite%s',key=>{
  const p=points();delete p[key];expect(measure(code,p,1)).toBeNaN();
  for(const bad of [NaN,Infinity,-Infinity])for(const axis of ['x','y'])expect(measure(code,{...points(),[key]:{x:1,y:2,[axis]:bad}},1)).toBeNaN();
 });
 it('refuses zero axes/nonrepresentable differences but not genuine parallel directions',()=>{
  const p=points();
  expect(measure(code,{...p,PNS:p.ANS},1)).toBeNaN();
  expect(measure(code,{...p,U1:p.U1A},1)).toBeNaN();
  expect(measure(code,{...p,ANS:{x:-Number.MAX_VALUE,y:0},PNS:{x:Number.MAX_VALUE,y:0}},1)).toBeNaN();
  expect(computeAll({},1).find(r=>r.code===code)?.value).toBeNull();
 });
 it('is scale-free with no calibration or unrelated orientation dependencies',()=>{
  for(const scale of [NaN,Infinity,-Infinity,0,-1,.01,100])expect(measure(code,{...points(),S:{x:NaN,y:NaN},N:{x:0,y:0},Me:{x:0,y:0}},scale)).toBeCloseTo(60,12);
  expect(computeAll(points(),0).find(r=>r.code===code)?.value).toBe(60);
  for(const k of [1e-200,1e200])expect(measure(code,{ANS:{x:0,y:0},PNS:{x:-2*k,y:0},U1A:{x:0,y:0},U1:{x:-k,y:Math.sqrt(3)*k}},0)).toBeCloseTo(60,12);
 });
 it('preserves inclination through rigid rotations, reflections, translations and scaling',()=>{
  for(const degrees of [0,17,45,90,137,180,270,359])for(const flip of [-1,1])for(const zoom of [.25,1,4]){
   const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
   const p=Object.fromEntries(Object.entries(points(1,Math.sqrt(3))).map(([k,v])=>[k,{x:19+zoom*(flip*v!.x*c-v!.y*s),y:-27+zoom*(flip*v!.x*s+v!.y*c)}]));
   expect(measure(code,p,NaN)).toBeCloseTo(120,10);
  }
 });
 it('is descriptive with no injectednorms and uses the two exact axes',()=>{
  expect(MEASUREMENTS.find(d=>d.code===code)).toMatchObject({needs:['ANS','PNS','U1A','U1'],unit:'°',mean:null,tol:null,descriptiveOnly:true,calculationVersion:'u1-pp-posterior-v1'});
  expect(MEASUREMENTS.find(d=>d.code===code)?.requiresCalibration).not.toBe(true);
  const p=points(),before=structuredClone(p),row=computeAll(p,0).find(r=>r.code===code)!;
  expect(enrichWithRefs([row],{[code]:{mean:99,sd:.01}})[0]).toMatchObject({mean:null,tol:null,status:null,refMean:null,refSd:null,z:null,diff:null});
  expect(getClinicalInterpretation(code,60).en).toMatch(/^Descriptive measurement;/);
  expect(JSON.parse(JSON.stringify(row))).toEqual(row);expect(p).toEqual(before);
 });
 it('does not replace cranial or NA inclinations when palatal landmarks move',()=>{
  const p={...points(),S:{x:0,y:0},N:{x:2,y:0},A:{x:2,y:3}};
  const q={...p,PNS:{x:0,y:2}};
  for(const old of ['U1SN','U1NA_A'])expect(measure(old,q,1)).toBe(measure(old,p,1));
  expect(measure(code,q,1)).not.toBe(measure(code,p,1));
 });
 it('pins engine source and version',()=>{
  expect(CEPH_ENGINE_VERSION).toBe('2026-11-06.5');
  expect(createHash('sha256').update(readFileSync('lib/ceph.ts')).digest('hex')).toBe(CEPH_ENGINE_SOURCE_SHA256);
 });
});
