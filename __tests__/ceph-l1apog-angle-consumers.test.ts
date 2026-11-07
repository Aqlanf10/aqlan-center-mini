import {describe,it,expect} from 'vitest';
import {computeAll,enrichWithRefs,measure,type LandmarkMap} from '../lib/ceph';
import {buildCephCompletionWitness,buildReviewedCephCompletionWitness,cephSourceIdentity,cephProvenanceHash,decodeCephCompletionWitness,type CephCompletionWitness,type CephProvenanceRead} from '../lib/ceph-completion-provenance';
import {presentCephMeasurements,enrichPresentedCephMeasurements} from '../lib/cephPresentation';
const codes=['L1_APOG_ANGLE'] as const;
const points:LandmarkMap={A:{x:0,y:0},Pog:{x:2,y:0},L1A:{x:4,y:4},L1:{x:5,y:4+Math.sqrt(3)}};
function input(map=points,scale=.5){const rows=computeAll(map,scale);return {analysisId:7,actor:{userId:9,username:'Synthetic'},sealedAt:'2026-11-06T00:00:00.000Z',snapshot:{patientId:1,documentId:2,refSet:'synthetic',calibration:{x1:0,y1:0,x2:100,y2:0,mm:100*scale},mmPerPixel:scale,landmarks:Object.entries(map).filter(([,p])=>p!==undefined).map(([code,p])=>({code:code as keyof LandmarkMap,...p!,source:'manual' as const})),diagnosis:null},image:{documentId:2,sha256:'a'.repeat(64),width:1000,height:1000},landmarkReviews:Object.keys(map).filter(code=>map[code as keyof LandmarkMap]!==undefined).map(code=>({code,confirmedBy:'Synthetic',confirmedAt:'2026-11-06T00:00:00.000Z'})),referenceSet:{key:'synthetic',name:'Injected references',population:null,ageMin:null,ageMax:null,sex:null,version:'test',active:true,values:codes.map(code=>({code,mean:999,sd:1}))},measurements:codes.flatMap(code=>{const row=rows.find(r=>r.code===code);return row?.value==null?[]:[{code,value:row.value}];})};}
const provenance=(w:CephCompletionWitness):CephProvenanceRead=>({state:'versioned',witness:w,witnessSha256:cephProvenanceHash(w)});
const fixtures=[{angle:20,expected:20},{angle:60,expected:60},{angle:120,expected:60},{angle:0,expected:0},{angle:90,expected:90},{angle:180,expected:0}];
function axis(angle:number):LandmarkMap{return {...points,L1:{x:4+2*Math.cos(angle*Math.PI/180),y:4+2*Math.sin(angle*Math.PI/180)}};}
describe('acute unoriented lower incisor A-Pog angle consumers',()=>{
 it.each(fixtures)('freezes angle $angle as acute $expected degrees in v1/v2',({angle,expected})=>{
  const map=axis(angle),source=input(map);expect(source.measurements).toEqual([{code:codes[0],value:expected}]);
  const one=buildCephCompletionWitness(source),two=buildReviewedCephCompletionWitness(source,cephSourceIdentity(one.image,one.referenceSet));
  for(const w of [one,two]){const bytes=JSON.stringify(w),decoded=decodeCephCompletionWitness(JSON.parse(bytes),cephProvenanceHash(w));expect(decoded).toEqual(w);
   expect(decoded!.measurements[0]).toMatchObject({code:codes[0],value:expected,unit:'°',algorithm:{calculationVersion:'l1-apog-acute-axis-v1'},reference:{origin:'descriptive_measurement_only',mean:null,sd:null,populationReference:null}});
   const display=presentCephMeasurements(computeAll(axis(90),99),source.measurements,provenance(decoded!));expect(display).toHaveLength(1);expect(display[0]).toMatchObject({value:expected,unit:'°',descriptiveOnly:true,status:null,severityStars:''});expect(JSON.stringify(w)).toBe(bytes);
  }
 });
 it.each(fixtures)('keeps $expected degrees when either or both axes reverse for input $angle',({angle,expected})=>{
  const map=axis(angle);for(const reversed of [map,{...map,A:map.Pog,Pog:map.A},{...map,L1:map.L1A,L1A:map.L1},{...map,A:map.Pog,Pog:map.A,L1:map.L1A,L1A:map.L1}]){
   expect(measure(codes[0],reversed,NaN)).toBeCloseTo(expected,8);expect(computeAll(reversed,NaN).find(r=>r.code===codes[0])?.value).toBe(expected);
  }
 });
 it('does not backfill the angle into old linear L1_APOG snapshots and preserves signed mm',()=>{
  const source={...input(),measurements:[{code:'L1_APOG',value:-2.5}]},w=buildCephCompletionWitness(source);
  for(const p of [undefined,provenance(w)]){const display=presentCephMeasurements(computeAll(points,.5),source.measurements,p);expect(display).toHaveLength(1);expect(display[0]).toMatchObject({code:'L1_APOG',value:-2.5});expect(display[0].unit).toBe(p?'mm':' (الوحدة غير موثقة)');}
 });
 it('keeps actual signed linear distance and acute angular result as distinct codes and units',()=>{
  const map:LandmarkMap={S:{x:-10,y:-10},N:{x:0,y:-10},Me:{x:0,y:20},A:{x:0,y:0},Pog:{x:0,y:10},L1:{x:5,y:5},L1A:{x:5+Math.sqrt(3),y:6}};
  const rows=computeAll(map,.5);expect(rows.find(r=>r.code==='L1_APOG')).toMatchObject({value:2.5,unit:'mm'});expect(rows.find(r=>r.code===codes[0])).toMatchObject({value:60,unit:'°'});
 });
 it('requires finite noncoincident axes but no calibration or orientation frame',()=>{
  for(const scale of [NaN,0,-1,.5,99])expect(computeAll(points,scale).find(r=>r.code===codes[0])?.value).toBe(60);
  for(const map of [{...points,A:undefined},{...points,L1A:undefined},{...points,Pog:points.A},{...points,L1:points.L1A},{...points,L1:{x:NaN,y:6}},{...points,Pog:{x:Infinity,y:0}}])expect(computeAll(map,.5).find(r=>r.code===codes[0])?.value).toBeNull();
 });
 it('keeps descriptive noncohort neutrality under injected references',()=>{
  const live=computeAll(points,.5),refs={[codes[0]]:{mean:999,sd:1}},result=live.find(r=>r.code===codes[0])!;expect(result).toBeDefined();
  expect(result.interpretationEn).not.toMatch(/composite|normal|abnormal|extraction/i);
  expect(enrichWithRefs(live,refs).find(r=>r.code===codes[0])).toMatchObject({refMean:null,refSd:null,z:null,refLabel:null,refSeverity:null});
  expect(enrichPresentedCephMeasurements(presentCephMeasurements(live,null),refs,false).find(r=>r.code===codes[0])).toMatchObject({mean:null,tol:null,status:null,severityStars:'',refMean:null,refSd:null});
 });
});
