import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {CEPH_ENGINE_VERSION,CEPH_ENGINE_SOURCE_SHA256} from "../lib/ceph-engine-identity";
import {describe,it,expect} from 'vitest';
import {measure,computeAll,enrichWithRefs,getClinicalInterpretation,MEASUREMENTS,type LandmarkMap} from '../lib/ceph';
const CODE='L1_APOG';
const fixture=():LandmarkMap=>({S:{x:0,y:0},N:{x:10,y:0},Me:{x:10,y:20},A:{x:0,y:2},Pog:{x:6,y:10},L1:{x:7,y:3},U1:{x:1,y:5}});
describe('descriptive lower incisor to A-Pog',()=>{
 it('computes independent perpendicular distance to tilted A-Pog',()=>{
  // A-Pog vector(6,8); L1-A(7,1); determinant56-6=50,
  // line length10:5px *0.2mm/px =1mm. Horizontal offset is NOT5px.
  expect(measure(CODE,fixture(),0.2)).toBeCloseTo(1,12);
 });
});

describe('L1_APOG independent geometry and refusal contract',()=>{
 it.each([[7,3,1],[-1,9,-1],[3,6,0],[11,0,2]])('signed perpendicular at (%s,%s) =%smm',(x,y,expected)=>{
  expect(measure(CODE,{...fixture(),L1:{x,y}},0.2)).toBeCloseTo(expected,12);
 });
 it('measures incisal tip not apex, upper incisor or horizontal projection',()=>{
  const points={...fixture(),L1A:{x:300,y:400},U1:{x:-50,y:200}};
  expect(measure(CODE,points,0.2)).toBeCloseTo(1,12);
  expect(measure('U1_APOG',points,0.2)).not.toBeCloseTo(1,8);
  expect(measure(CODE,{...points,L1:{x:11,y:0}},0.2)).toBeCloseTo(2,12);
 });
 it('uses the infinite line, including projections outside the reference segment',()=>{
  // A+(6,8)*3+(4,-3)=(22,23), still5px perpendicular.
  expect(measure(CODE,{...fixture(),L1:{x:22,y:23}},0.2)).toBeCloseTo(1,12);
 });
 it.each(['A','Pog','L1','S','N','Me'] as const)('requires actual finite %s',code=>{
  const missing=fixture();delete missing[code];expect(Number.isNaN(measure(CODE,missing,0.2))).toBe(true);
  for(const invalid of [NaN,Infinity,-Infinity])expect(Number.isNaN(measure(CODE,{...fixture(),[code]:{x:invalid,y:0}},0.2))).toBe(true);
 });
 it('refuses coincident line and indeterminate sign frame, not valid zero',()=>{
  expect(Number.isNaN(measure(CODE,{...fixture(),Pog:fixture().A},0.2))).toBe(true);
  expect(Number.isNaN(measure(CODE,{...fixture(),Me:{x:20,y:0}},0.2))).toBe(true);
  expect(Number.isNaN(measure(CODE,{...fixture(),N:fixture().S},0.2))).toBe(true);
  expect(measure(CODE,{...fixture(),L1:{x:3,y:6}},0.2)).toBeCloseTo(0,12);
  expect(measure(CODE,{...fixture(),A:{x:0,y:2},Pog:{x:0,y:10},L1:{x:0,y:6}},0.2)).toBe(0);
 });
 it.each([0,-1,NaN,Infinity,-Infinity])('requires finite positive calibration %s',scale=>{
  expect(Number.isNaN(measure(CODE,fixture(),scale))).toBe(true);
  expect(computeAll(fixture(),scale).find(r=>r.code===CODE)?.value).toBeNull();
 });
 it('refuses nonrepresentable conversion rather than publish zero/infinity',()=>{
  expect(Number.isNaN(measure(CODE,fixture(),Number.MAX_VALUE))).toBe(true);
  const tiny={...fixture(),A:{x:0,y:0},Pog:{x:0,y:1},L1:{x:0.1,y:0.5}};
  expect(Number.isNaN(measure(CODE,tiny,Number.MIN_VALUE))).toBe(true);
 });
 it('is invariant under rigid motion/reflection and reciprocal calibration',()=>{
  for(const angle of [0,17,45,90,137,180,270,359])for(const mirror of [1,-1])for(const resize of [0.25,1,4]){
   const radians=angle*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);
   const transformed=Object.fromEntries(Object.entries(fixture()).map(([key,p])=>[key,{x:37+resize*(mirror*p!.x*c-p!.y*s),y:-29+resize*(mirror*p!.x*s+p!.y*c)}]));
   expect(measure(CODE,transformed,0.2/resize)).toBeCloseTo(1,10);
  }
 });
 it('retains source landmarks and performs no mutation',()=>{
  const points=fixture(),before=structuredClone(points);computeAll(points,0.2);expect(points).toEqual(before);
 });
 it('has a distinct calibrated millimetre identity and no population norm',()=>{
  const definition=MEASUREMENTS.find(d=>d.code===CODE)!;
  expect(definition).toMatchObject({unit:'mm',mean:null,tol:null,descriptiveOnly:true,requiresCalibration:true,calculationVersion:'l1-apog-perpendicular-snme-v1'});
  expect(definition.populationReference).toBeUndefined();expect(definition.needs).toEqual(['A','Pog','L1','S','N','Me']);
  const row=computeAll(fixture(),0.2).find(r=>r.code===CODE)!;
  expect(row).toMatchObject({value:1,unit:'mm',status:null,severityStars:''});
  expect(enrichWithRefs([row],{[CODE]:{mean:-100,sd:0.01}})[0]).toMatchObject({mean:null,tol:null,refMean:null,refSd:null,z:null,diff:null,refLabel:null,refSeverity:null});
  expect(getClinicalInterpretation(CODE,1).en).toBe('Descriptive measurement; treatment decisions require clinical assessment');
 });
 it('rounds only final display and serializes finite saved values',()=>{
  const points={...fixture(),L1:{x:7.123,y:3}},raw=measure(CODE,points,0.2);
  expect(raw).toBeCloseTo(1.01968,12);
  const row=computeAll(points,0.2).find(r=>r.code===CODE)!;
  expect(row.value).toBe(1);expect(JSON.parse(JSON.stringify(row))).toEqual(row);
 });
});

it('pins the explicit new engine identity to exact source bytes',()=>{
 expect(CEPH_ENGINE_VERSION).toBe('2026-11-06.5');
 expect(createHash('sha256').update(readFileSync(new URL('../lib/ceph.ts',import.meta.url))).digest('hex')).toBe(CEPH_ENGINE_SOURCE_SHA256);
});
