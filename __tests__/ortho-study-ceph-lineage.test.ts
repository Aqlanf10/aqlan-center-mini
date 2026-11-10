import {describe,it,expect} from 'vitest';
import {syntheticLongitudinalStudy,rehashSyntheticLongitudinal} from './fixtures/ortho-study-longitudinal';
import {syntheticWitnessedStudyCephCapture,syntheticSourceBoundStudyCephCapture} from './fixtures/ortho-study-ceph-witness';
import {decodeStudySavedContent} from '../lib/ortho-case-study-capture';
import {withStudyCephLineage} from '../lib/ortho-study-ceph-lineage';
import {projectStudyLongitudinalEligibility} from '../lib/ortho-study-longitudinal';
import {projectStudyRecordedFacts} from '../lib/ortho-case-study-recorded-facts';
import {journeyContentHash} from '../lib/ortho-case-journey-hash';
import type {CephCorrectionOrigin} from '../lib/ceph-correction-origin';
const scope={patientId:19,orthoCaseId:41,clinicalCaseId:51};
function fixture(version:1|2|3=1){
 const study=syntheticLongitudinalStudy(),s=study.content.sources[0];
 const base=version===1?{...(s.payload as Record<string,unknown>),id:s.selection.id,correctsStudyId:5}:version===2?syntheticWitnessedStudyCephCapture():syntheticSourceBoundStudyCephCapture();
 const documentId=version===1?71:(base as ReturnType<typeof syntheticWitnessedStudyCephCapture>).completion.witness.image.documentId;
 const origin:CephCorrectionOrigin={schemaVersion:1,parentAnalysisId:5,recordedPatientId:9,orthoCaseId:41,documentId,parentCompletion:{state:'unversioned',reason:'historical_completion_without_witness'},sourceSnapshotSha256:'a'.repeat(64)};
 s.selection.id=Number(base.id);s.payload=withStudyCephLineage(base,origin);rehashSyntheticLongitudinal(study);return {study,base,origin};
}
describe('additive ceph correction capture4',()=>{
 it.each([1,2,3] as const)('retains exact base bytes and evidence strength for base %s',version=>{
  const {study,base}=fixture(version),hash=journeyContentHash(base),decoded=decodeStudySavedContent(study.content,scope);
  expect(decoded.ok).toBe(true);expect(journeyContentHash(base)).toBe(hash);
  const projected=projectStudyLongitudinalEligibility(study,scope);
  expect(projected.stages[0].sources[0].witness).toBe(version===1?'legacy_unversioned':version===2?'versioned_unconfirmed_view':'versioned_source_identity_matched');
  const facts=JSON.stringify(projectStudyRecordedFacts(study.content,scope,'ceph_panel','documented'));
  expect(facts).toContain('الدراسة الأصلية للتصحيح');expect(facts).toContain('إكمال تاريخي دون شاهد محفوظ');
 });
 it.each(['parent','case','image','extra','nested','witness'] as const)('refuses contradictory %s even after rehash',kind=>{
  const {study}=fixture(2),p=study.content.sources[0].payload as {base:Record<string,unknown>;correctionOrigin:CephCorrectionOrigin};
  if(kind==='parent')p.correctionOrigin.parentAnalysisId=Number(p.base.id);
  if(kind==='case')p.correctionOrigin.orthoCaseId=99;
  if(kind==='image')p.correctionOrigin.documentId=999;
  if(kind==='extra')Object.assign(p,{approved:true});
  if(kind==='nested')p.base={captureVersion:4,base:p.base,correctionOrigin:p.correctionOrigin};
  if(kind==='witness')(p.base.completion as {witnessSha256:string}).witnessSha256='b'.repeat(64);
  rehashSyntheticLongitudinal(study);expect(decodeStudySavedContent(study.content,scope).ok).toBe(false);
 });
 it('leaves original legacy snapshots and source hashes untouched without origin',()=>{
  const s=syntheticLongitudinalStudy(),before=journeyContentHash(s.content);expect(decodeStudySavedContent(s.content,scope).ok).toBe(true);
  expect(withStudyCephLineage(s.content.sources[0].payload,null)).toBe(s.content.sources[0].payload);expect(journeyContentHash(s.content)).toBe(before);
 });
});
