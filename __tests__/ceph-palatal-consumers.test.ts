import {describe,it,expect} from 'vitest';
import {computeAll,enrichWithRefs,measure,type LandmarkMap} from '../lib/ceph';
import {buildCephCompletionWitness,buildReviewedCephCompletionWitness,cephSourceIdentity,cephProvenanceHash,decodeCephCompletionWitness,type CephCompletionWitness,type CephProvenanceRead} from '../lib/ceph-completion-provenance';
import {presentCephMeasurements,enrichPresentedCephMeasurements} from '../lib/cephPresentation';
const codes=['PALATAL_ANS_PNS'] as const;
const points:LandmarkMap={ANS:{x:1,y:2},PNS:{x:7,y:10}};
function input(map=points,scale=.5){const rows=computeAll(map,scale);return {analysisId:7,actor:{userId:9,username:'Synthetic'},sealedAt:'2026-11-06T00:00:00.000Z',snapshot:{patientId:1,documentId:2,refSet:'synthetic',calibration:{x1:0,y1:0,x2:100,y2:0,mm:100*scale},mmPerPixel:scale,landmarks:Object.entries(map).filter(([,p])=>p!==undefined).map(([code,p])=>({code:code as keyof LandmarkMap,...p!,source:'manual' as const})),diagnosis:null},image:{documentId:2,sha256:'a'.repeat(64),width:1000,height:1000},landmarkReviews:Object.keys(map).filter(code=>map[code as keyof LandmarkMap]!==undefined).map(code=>({code,confirmedBy:'Synthetic',confirmedAt:'2026-11-06T00:00:00.000Z'})),referenceSet:{key:'synthetic',name:'Injected references',population:null,ageMin:null,ageMax:null,sex:null,version:'test',active:true,values:codes.map(code=>({code,mean:999,sd:1}))},measurements:codes.flatMap(code=>{const row=rows.find(r=>r.code===code);return row?.value==null?[]:[{code,value:row.value}];})};}
const provenance=(w:CephCompletionWitness):CephProvenanceRead=>({state:'versioned',witness:w,witnessSha256:cephProvenanceHash(w)});
describe('direct palatal length consumer boundaries',()=>{
 it('freezes independently specified tilted 5mm in v1/v2 without recalculation or norms',()=>{
  const source=input();expect(source.measurements).toEqual([{code:codes[0],value:5}]);
  const one=buildCephCompletionWitness(source),two=buildReviewedCephCompletionWitness(source,cephSourceIdentity(one.image,one.referenceSet));
  for(const w of [one,two]){const bytes=JSON.stringify(w),decoded=decodeCephCompletionWitness(JSON.parse(bytes),cephProvenanceHash(w));expect(decoded).toEqual(w);
   expect(decoded!.measurements[0]).toMatchObject({code:codes[0],value:5,unit:'mm',algorithm:{calculationVersion:'palatal-direct-length-v1'},reference:{origin:'descriptive_measurement_only',mean:null,sd:null,populationReference:null}});
   const display=presentCephMeasurements(computeAll(points,99),source.measurements,provenance(decoded!));expect(display).toHaveLength(1);expect(display[0]).toMatchObject({value:5,unit:'mm',descriptiveOnly:true,status:null,severityStars:''});expect(display[0].note).not.toContain('عينة');expect(JSON.stringify(w)).toBe(bytes);
  }
 });
 it('does not backfill the length into old angle-only snapshots or relabel an angle as mm',()=>{
  const source={...input(),measurements:[{code:'PP_FH',value:23}]},w=buildCephCompletionWitness(source);
  for(const p of [undefined,provenance(w)]){const display=presentCephMeasurements(computeAll(points,.5),source.measurements,p);expect(display).toHaveLength(1);expect(display[0]).toMatchObject({code:'PP_FH',value:23});expect(display[0].unit).toBe(p?'°':' (الوحدة غير موثقة)');}
 });
 it('distinguishes exact-coincidence refusal, tiny positive rounded zero and missing source/calibration',()=>{
  const coincident={ANS:points.ANS,PNS:points.ANS};expect(computeAll(coincident,.5).find(r=>r.code===codes[0])?.value).toBeNull();
  const tiny={ANS:{x:0,y:0},PNS:{x:.0006,y:.0008}};expect(measure(codes[0],tiny,.5)).toBeGreaterThan(0);expect(computeAll(tiny,.5).find(r=>r.code===codes[0])?.value).toBe(0);
  const w=buildCephCompletionWitness(input(tiny));expect(decodeCephCompletionWitness(JSON.parse(JSON.stringify(w)),cephProvenanceHash(w))?.measurements[0].value).toBe(0);
  for(const map of [{ANS:points.ANS},{PNS:points.PNS},{}])expect(computeAll(map,.5).find(r=>r.code===codes[0])?.value).toBeNull();
  expect(computeAll(points,NaN).find(r=>r.code===codes[0])?.value).toBeNull();
 });
 it('remains descriptive under injected norms, not a dental arch/space or composite-index result',()=>{
  const live=computeAll(points,.5),refs={[codes[0]]:{mean:999,sd:1}},result=live.find(r=>r.code===codes[0])!;expect(result).toBeDefined();
  expect(result.interpretationEn).not.toMatch(/composite|normal|abnormal|extraction|available space|dental arch/i);
  expect(enrichWithRefs(live,refs).find(r=>r.code===codes[0])).toMatchObject({refMean:null,refSd:null,z:null,refLabel:null,refSeverity:null});
  expect(enrichPresentedCephMeasurements(presentCephMeasurements(live,null),refs,false).find(r=>r.code===codes[0])).toMatchObject({mean:null,tol:null,status:null,severityStars:'',refMean:null,refSd:null});
 });
});
