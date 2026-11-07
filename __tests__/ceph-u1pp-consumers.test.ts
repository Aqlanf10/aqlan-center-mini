import {describe,it,expect} from 'vitest';
import {computeAll,enrichWithRefs,measure,type LandmarkMap} from '../lib/ceph';
import {buildCephCompletionWitness,buildReviewedCephCompletionWitness,cephSourceIdentity,cephProvenanceHash,decodeCephCompletionWitness,type CephCompletionWitness,type CephProvenanceRead} from '../lib/ceph-completion-provenance';
import {presentCephMeasurements,enrichPresentedCephMeasurements} from '../lib/cephPresentation';
const codes=['U1_PP'] as const;
const points:LandmarkMap={ANS:{x:0,y:0},PNS:{x:2,y:0},U1A:{x:4,y:4},U1:{x:5,y:4+Math.sqrt(3)}};
function input(map=points,scale=.5){const rows=computeAll(map,scale);return {analysisId:7,actor:{userId:9,username:'Synthetic'},sealedAt:'2026-11-06T00:00:00.000Z',snapshot:{patientId:1,documentId:2,refSet:'synthetic',calibration:{x1:0,y1:0,x2:100,y2:0,mm:100*scale},mmPerPixel:scale,landmarks:Object.entries(map).filter(([,p])=>p!==undefined).map(([code,p])=>({code:code as keyof LandmarkMap,...p!,source:'manual' as const})),diagnosis:null},image:{documentId:2,sha256:'a'.repeat(64),width:1000,height:1000},landmarkReviews:Object.keys(map).filter(code=>map[code as keyof LandmarkMap]!==undefined).map(code=>({code,confirmedBy:'Synthetic',confirmedAt:'2026-11-06T00:00:00.000Z'})),referenceSet:{key:'synthetic',name:'Injected references',population:null,ageMin:null,ageMax:null,sex:null,version:'test',active:true,values:codes.map(code=>({code,mean:999,sd:1}))},measurements:codes.flatMap(code=>{const row=rows.find(r=>r.code===code);return row?.value==null?[]:[{code,value:row.value}];})};}
const provenance=(w:CephCompletionWitness):CephProvenanceRead=>({state:'versioned',witness:w,witnessSha256:cephProvenanceHash(w)});
const fixtures=[
 {x:2,y:0,expected:0},{x:1,y:Math.sqrt(3),expected:60},{x:0,y:2,expected:90},{x:-1,y:Math.sqrt(3),expected:120},{x:-2,y:0,expected:180},
];
describe('posterior upper incisor to palatal plane consumers',()=>{
 it.each(fixtures)('preserves directed-axis $expected degrees in both witness versions and saved presentation',({x,y,expected})=>{
  const map={...points,U1:{x:4+x,y:4+y}};const source=input(map);expect(source.measurements).toEqual([{code:codes[0],value:expected}]);
  const one=buildCephCompletionWitness(source),two=buildReviewedCephCompletionWitness(source,cephSourceIdentity(one.image,one.referenceSet));
  for(const w of [one,two]){const bytes=JSON.stringify(w),decoded=decodeCephCompletionWitness(JSON.parse(bytes),cephProvenanceHash(w));expect(decoded).toEqual(w);
   expect(decoded!.measurements[0]).toMatchObject({code:codes[0],value:expected,unit:'°',algorithm:{calculationVersion:'u1-pp-posterior-v1'},reference:{origin:'descriptive_measurement_only',mean:null,sd:null,populationReference:null}});
   const display=presentCephMeasurements(computeAll({...points,U1:{x:4,y:6}},99),source.measurements,provenance(decoded!));expect(display).toHaveLength(1);expect(display[0]).toMatchObject({value:expected,unit:'°',descriptiveOnly:true,status:null,severityStars:''});expect(display[0].note).not.toContain('عينة');expect(JSON.stringify(w)).toBe(bytes);
  }
 });
 it('does not backfill old U1SN-only snapshots or replace their original angle',()=>{
  const source={...input(),measurements:[{code:'U1SN',value:102}]},w=buildCephCompletionWitness(source);
  for(const p of [undefined,provenance(w)]){const display=presentCephMeasurements(computeAll(points,.5),source.measurements,p);expect(display).toHaveLength(1);expect(display[0]).toMatchObject({code:'U1SN',value:102});expect(display[0].unit).toBe(p?'°':' (الوحدة غير موثقة)');}
 });
 it('requires actual finite noncoincident axes but neither calibration nor S/N/Me orientation anchors',()=>{
  for(const scale of [NaN,0,-1,.5,99])expect(computeAll(points,scale).find(r=>r.code===codes[0])?.value).toBe(60);
  for(const map of [{...points,ANS:undefined},{...points,U1A:undefined},{...points,PNS:points.ANS},{...points,U1:points.U1A},{...points,U1:{x:NaN,y:6}}])expect(computeAll(map,.5).find(r=>r.code===codes[0])?.value).toBeNull();
  expect(measure(codes[0],points,NaN)).toBeCloseTo(60);
 });
 it('does not apply injected norms or a clinical/acute-only interpretation',()=>{
  const live=computeAll(points,.5),refs={[codes[0]]:{mean:999,sd:1}},result=live.find(r=>r.code===codes[0])!;expect(result).toBeDefined();
  expect(result.interpretationEn).not.toMatch(/composite|normal|abnormal|extraction|always obtuse/i);
  expect(enrichWithRefs(live,refs).find(r=>r.code===codes[0])).toMatchObject({refMean:null,refSd:null,z:null,refLabel:null,refSeverity:null});
  expect(enrichPresentedCephMeasurements(presentCephMeasurements(live,null),refs,false).find(r=>r.code===codes[0])).toMatchObject({mean:null,tol:null,status:null,severityStars:'',refMean:null,refSd:null});
 });
});
