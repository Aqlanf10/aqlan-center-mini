import {describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {measure,computeAll,MEASUREMENTS,enrichWithRefs,getClinicalInterpretation,type LandmarkMap} from '../lib/ceph';
import {CEPH_ENGINE_SOURCE_SHA256,CEPH_ENGINE_VERSION} from '../lib/ceph-engine-identity';
const code='L1_APOG_ANGLE';
const points=(x=-1,y=Math.sqrt(3)):LandmarkMap=>({A:{x:0,y:0},Pog:{x:-2,y:0},L1:{x:3,y:4},L1A:{x:3+x,y:4+y}});
describe('acute lower incisor to A-Pog axis angle',()=>{
 it.each([[-1,Math.sqrt(3),60],[0,2,90],[1,Math.sqrt(3),60],[-2,0,0],[2,0,0]])('direct ray inclination (%s,%s) gives%s degrees',(x,y,angle)=>{
  expect(measure(code,points(x,y),NaN)).toBeCloseTo(angle,12);
 });
 it('folds supplementary axis angles without inferring direction',()=>{
  expect(measure(code,points(),0)).toBeCloseTo(60,12);
  expect(measure(code,points(1,Math.sqrt(3)),0)).toBeCloseTo(60,12);
  const p=points();
  expect(measure(code,{...p,A:p.Pog,Pog:p.A},0)).toBeCloseTo(60,12);
  expect(measure(code,{A:p.Pog,Pog:p.A,L1:p.L1A,L1A:p.L1},0)).toBeCloseTo(60,12);
 });
 it.each(['A','Pog','L1','L1A'] as const)('requires actual finite%s',key=>{
  const p=points();delete p[key];expect(measure(code,p,1)).toBeNaN();
  for(const bad of [NaN,Infinity,-Infinity])for(const axis of ['x','y'])expect(measure(code,{...points(),[key]:{x:1,y:2,[axis]:bad}},1)).toBeNaN();
 });
 it('refuses zero axes/nonrepresentable differences but not genuine parallel directions',()=>{
  const p=points();
  expect(measure(code,{...p,Pog:p.A},1)).toBeNaN();
  expect(measure(code,{...p,L1A:p.L1},1)).toBeNaN();
  expect(measure(code,{...p,A:{x:-Number.MAX_VALUE,y:0},Pog:{x:Number.MAX_VALUE,y:0}},1)).toBeNaN();
  expect(computeAll({},1).find(r=>r.code===code)?.value).toBeNull();
 });
 it('is scale-free with no calibration or unrelated orientation dependencies',()=>{
  for(const scale of [NaN,Infinity,-Infinity,0,-1,.01,100])expect(measure(code,{...points(),S:{x:NaN,y:NaN},N:{x:0,y:0},Me:{x:0,y:0}},scale)).toBeCloseTo(60,12);
  expect(computeAll(points(),0).find(r=>r.code===code)?.value).toBe(60);
  for(const k of [1e-200,1e200])expect(measure(code,{A:{x:0,y:0},Pog:{x:-2*k,y:0},L1:{x:0,y:0},L1A:{x:-k,y:Math.sqrt(3)*k}},0)).toBeCloseTo(60,12);
 });
 it('preserves inclination through rigid rotations, reflections, translations and scaling',()=>{
  for(const degrees of [0,17,45,90,137,180,270,359])for(const flip of [-1,1])for(const zoom of [.25,1,4]){
   const a=degrees*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
   const p=Object.fromEntries(Object.entries(points(1,Math.sqrt(3))).map(([k,v])=>[k,{x:19+zoom*(flip*v!.x*c-v!.y*s),y:-27+zoom*(flip*v!.x*s+v!.y*c)}]));
   expect(measure(code,p,NaN)).toBeCloseTo(60,10);
  }
 });
 it('is descriptive with no injectednorms and uses the two exact axes',()=>{
  expect(MEASUREMENTS.find(d=>d.code===code)).toMatchObject({needs:['A','Pog','L1','L1A'],unit:'°',mean:null,tol:null,descriptiveOnly:true,calculationVersion:'l1-apog-acute-axis-v1'});
  expect(MEASUREMENTS.find(d=>d.code===code)?.requiresCalibration).not.toBe(true);
  const p=points(),before=structuredClone(p),row=computeAll(p,0).find(r=>r.code===code)!;
  expect(enrichWithRefs([row],{[code]:{mean:99,sd:.01}})[0]).toMatchObject({mean:null,tol:null,status:null,refMean:null,refSd:null,z:null,diff:null});
  expect(getClinicalInterpretation(code,60).en).toMatch(/^Descriptive measurement;/);
  expect(JSON.parse(JSON.stringify(row))).toEqual(row);expect(p).toEqual(before);
 });
 it('is distinct from saved perpendicular distance and does not mutate historical arrays',()=>{
  const p:LandmarkMap={A:{x:0,y:0},Pog:{x:0,y:10},L1:{x:2,y:3},L1A:{x:2,y:8},S:{x:0,y:0},N:{x:10,y:0},Me:{x:10,y:20}};
  const q={...p,L1A:{x:7,y:8}};
  expect(measure('L1_APOG',q,1)).toBe(measure('L1_APOG',p,1));
  expect(measure(code,p,0)).toBe(0);expect(measure(code,q,0)).toBeCloseTo(45,12);
  const old=JSON.stringify([{code:'L1_APOG',value:2}]);computeAll(q,1);
  expect(JSON.parse(old)).toEqual([{code:'L1_APOG',value:2}]);
 });
 it('pins engine source and version',()=>{
  expect(CEPH_ENGINE_VERSION).toBe('2026-11-06.5');
  expect(createHash('sha256').update(readFileSync('lib/ceph.ts')).digest('hex')).toBe(CEPH_ENGINE_SOURCE_SHA256);
 });
});
