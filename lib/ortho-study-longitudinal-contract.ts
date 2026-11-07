/** Browser-safe eligibility contract. Policy v2 retains historical witness1
 * semantics; v3 explicitly describes identity-matched witness2 evidence. Neither
 * proves what was viewed or permits numeric comparisons. */
import {journeyHash,journeyId,type JourneyScope} from './ortho-case-journey-records';
import {readStudyTimepoints,type StudyTimepoint} from './ortho-case-study-timepoints';
import {readOccurrenceEvidence,type OccurrenceEvidence} from './ortho-case-occurrence';
import {parseCephSourceIdentity,type CephSourceIdentity} from './ceph-source-review';
import type {StudyDraftContent} from './ortho-case-study';
export const STUDY_LONGITUDINAL_POLICY='ortho-ceph-eligibility-v2' as const;
export const STUDY_LONGITUDINAL_SOURCE_BOUND_POLICY='ortho-ceph-eligibility-v3-source-bound' as const;
export type StudyLongitudinalPolicy=typeof STUDY_LONGITUDINAL_POLICY|typeof STUDY_LONGITUDINAL_SOURCE_BOUND_POLICY;
export const STUDY_LONGITUDINAL_REASONS=['source_unavailable','not_completed','image_unavailable','legacy_completion_witness_missing','measurement_unit_unversioned','formula_version_unversioned','reference_version_unversioned','calibration_not_captured','no_ceph_source','multiple_ceph_sources','source_identity_not_view_bound','clinical_comparability_not_validated'] as const;
export type StudyLongitudinalReason=typeof STUDY_LONGITUDINAL_REASONS[number];
export interface StudyLongitudinalCompletionV1 {
 schemaVersion:1;witnessSha256:string;sealedAt:string;
 sourceIdentityMeaning:'server_captured_at_completion_not_confirmed_as_viewed';
 algorithms:{id:string;version:string;sourceSha256:string;calculationVersion:string|null;rounding:'one_decimal_math_round'}[];
 referenceSet:{key:string;version:string;sha256:string};
 calibration:{x1:number;y1:number;x2:number;y2:number;mm:number;mmPerPixel:number};
}
export interface StudyLongitudinalCompletionV2 extends Omit<StudyLongitudinalCompletionV1,'schemaVersion'|'sourceIdentityMeaning'> {
 schemaVersion:2;sourceIdentityMeaning:'submitted_source_identity_matches_server_capture';
 sourceReview:{schemaVersion:1;identity:CephSourceIdentity};
}
export type StudyLongitudinalCompletion=StudyLongitudinalCompletionV1|StudyLongitudinalCompletionV2;
export interface StudyLongitudinalSource {
 key:string;id:number;contentHash:string;captureState:'available'|'unavailable';
 status:'draft'|'completed'|'discarded'|null;acquisitionDate:string|null;referenceSetKey:string|null;
 image:{documentId:number;contentHash:string;state:'available'|'removed'}|null;
 witness:'legacy_unversioned'|'versioned_unconfirmed_view'|'versioned_source_identity_matched'|'unavailable';completion:StudyLongitudinalCompletion|null;reasons:StudyLongitudinalReason[];
}
export interface StudyLongitudinalStage {stage:StudyTimepoint;groupId:string;label:string;occurrence:OccurrenceEvidence;sources:StudyLongitudinalSource[];state:'unavailable';reasons:StudyLongitudinalReason[]}
export interface StudyLongitudinalPair {from:StudyTimepoint;to:StudyTimepoint;state:'unavailable';delta:null;reasons:StudyLongitudinalReason[]}
export interface StudyLongitudinalReview extends JourneyScope {ok:true;revisionId:number;revisionHash:string;kind:'draft'|'documented';capturedAt:string;policyVersion:StudyLongitudinalPolicy;stages:StudyLongitudinalStage[];pairs:StudyLongitudinalPair[]}
export interface StudyLongitudinalExpected extends JourneyScope {revisionId:number;revisionHash:string;kind:'draft'|'documented';authored:StudyDraftContent}
function fail():never{throw Error('invalid_study_longitudinal_review');}
function object(raw:unknown,keys:string[]):Record<string,unknown>{if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail();const r=raw as Record<string,unknown>;if(Object.keys(r).length!==keys.length||keys.some(k=>!Object.hasOwn(r,k)))return fail();return r;}
function text(raw:unknown,max:number):string{
 if(typeof raw!=='string'||raw.length>max)return fail();
 if(Array.from(raw).some(char=>{const code=char.charCodeAt(0);return code<32&&code!==9&&code!==10&&code!==13;}))return fail();
 return raw;
}
function reasons(raw:unknown):StudyLongitudinalReason[]{if(!Array.isArray(raw)||!raw.length||raw.length>STUDY_LONGITUDINAL_REASONS.length||new Set(raw).size!==raw.length||raw.some(r=>!STUDY_LONGITUDINAL_REASONS.includes(r)))return fail();return [...raw];}
export function legacyCephReasons(source:Pick<StudyLongitudinalSource,'captureState'|'status'|'image'>):StudyLongitudinalReason[]{
 if(source.captureState==='unavailable')return ['source_unavailable'];
 return [...source.status==='completed'?[]:['not_completed' as const],...source.image?.state==='available'?[]:['image_unavailable' as const],
 'legacy_completion_witness_missing','measurement_unit_unversioned','formula_version_unversioned','reference_version_unversioned','calibration_not_captured'];
}
export function longitudinalSourceReasons(source:StudyLongitudinalSource):StudyLongitudinalReason[]{
 if(source.witness==='versioned_source_identity_matched')return ['clinical_comparability_not_validated'];
 return source.witness==='versioned_unconfirmed_view'?['source_identity_not_view_bound']:legacyCephReasons(source);
}
function completionMetadata(raw:unknown,witness:'versioned_unconfirmed_view'|'versioned_source_identity_matched'):StudyLongitudinalCompletion{
 const matched=witness==='versioned_source_identity_matched';
 const r=object(raw,['schemaVersion','witnessSha256','sealedAt','sourceIdentityMeaning','algorithms','referenceSet','calibration',...matched?['sourceReview']:[]]);
 if(r.schemaVersion!==(matched?2:1)||!journeyHash(r.witnessSha256)||r.sourceIdentityMeaning!==(matched?'submitted_source_identity_matches_server_capture':'server_captured_at_completion_not_confirmed_as_viewed'))fail();
 const sealedAt=text(r.sealedAt,30);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(sealedAt)||!Number.isFinite(Date.parse(sealedAt)))fail();
 if(!Array.isArray(r.algorithms)||r.algorithms.length>256)fail();
 const algorithms=(r.algorithms as unknown[]).map(value=>{
  const a=object(value,['id','version','sourceSha256','calculationVersion','rounding']);
  const id=text(a.id,4011),version=text(a.version,4000),calculationVersion=a.calculationVersion===null?null:text(a.calculationVersion,4000);
  if(!/^aqlan-ceph:.+/.test(id)||id==='aqlan-ceph:EXT_INDEX'||!version||calculationVersion===''||!journeyHash(a.sourceSha256)||a.rounding!=='one_decimal_math_round')fail();
  return {id,version,sourceSha256:a.sourceSha256,calculationVersion,rounding:'one_decimal_math_round' as const};
 });
 const identities=algorithms.map(a=>JSON.stringify(a));
 if(new Set(identities).size!==identities.length||identities.some((value,index)=>index>0&&value<=identities[index-1]))fail();
 const reference=object(r.referenceSet,['key','version','sha256']),key=text(reference.key,4000),version=text(reference.version,4000);
 if(!key||!version||!journeyHash(reference.sha256))fail();
 const c=object(r.calibration,['x1','y1','x2','y2','mm','mmPerPixel']);
 if(Object.values(c).some(value=>typeof value!=='number'||!Number.isFinite(value)))fail();
 const calibration=c as StudyLongitudinalCompletion['calibration'];
 if(calibration.mm<=0||calibration.mmPerPixel<=0||calibration.mm/Math.hypot(calibration.x2-calibration.x1,calibration.y2-calibration.y1)!==calibration.mmPerPixel)fail();
 const common={witnessSha256:r.witnessSha256,sealedAt,algorithms,referenceSet:{key,version,sha256:reference.sha256},calibration:{...calibration}};
 if(!matched)return {schemaVersion:1,sourceIdentityMeaning:'server_captured_at_completion_not_confirmed_as_viewed',...common};
 const review=object(r.sourceReview,['schemaVersion','identity']),identity=parseCephSourceIdentity(review.identity);
 if(review.schemaVersion!==1||!identity||identity.referenceSetKey!==key||identity.referenceSetSha256!==reference.sha256
  ||algorithms.some(a=>a.version!==identity.engineVersion||a.sourceSha256!==identity.engineSourceSha256))fail();
 text(identity.referenceSetKey,200);text(identity.engineVersion,200);
 return {schemaVersion:2,sourceIdentityMeaning:'submitted_source_identity_matches_server_capture',sourceReview:{schemaVersion:1,identity},...common};
}
export function longitudinalPolicy(stages:Pick<StudyLongitudinalStage,'sources'>[]):StudyLongitudinalPolicy {
 return stages.some(stage=>stage.sources.some(source=>source.witness==='versioned_source_identity_matched'))?STUDY_LONGITUDINAL_SOURCE_BOUND_POLICY:STUDY_LONGITUDINAL_POLICY;
}
export function longitudinalStageReasons(sources:StudyLongitudinalSource[]):StudyLongitudinalReason[]{
 if(!sources.length)return ['no_ceph_source'];
 return [...new Set<StudyLongitudinalReason>([...new Set(sources.map(s=>`${s.id}:${s.contentHash}`)).size>1?['multiple_ceph_sources' as const]:[],...sources.flatMap(s=>s.reasons)])];
}
export function longitudinalPairs(stages:StudyLongitudinalStage[]):StudyLongitudinalPair[]{return stages.flatMap((from,index)=>stages.slice(index+1).map(to=>({from:from.stage,to:to.stage,state:'unavailable' as const,delta:null,reasons:[...new Set([...from.reasons,...to.reasons])]})));}
export function readStudyLongitudinalReview(raw:unknown,expected:StudyLongitudinalExpected):StudyLongitudinalReview{
 const v=object(raw,['ok','patientId','orthoCaseId','clinicalCaseId','revisionId','revisionHash','kind','capturedAt','policyVersion','stages','pairs']);
 for(const key of ['patientId','orthoCaseId','clinicalCaseId','revisionId'] as const)if(!journeyId(expected[key])||v[key]!==expected[key])fail();
 if(v.ok!==true||!journeyHash(expected.revisionHash)||v.revisionHash!==expected.revisionHash||!['draft','documented'].includes(expected.kind)||v.kind!==expected.kind||(v.policyVersion!==STUDY_LONGITUDINAL_POLICY&&v.policyVersion!==STUDY_LONGITUDINAL_SOURCE_BOUND_POLICY))fail();
 const capturedAt=text(v.capturedAt,30);if(!Number.isFinite(Date.parse(capturedAt))||new Date(capturedAt).toISOString()!==capturedAt)fail();
 const points=readStudyTimepoints(expected.authored);if(!Array.isArray(v.stages)||v.stages.length!==points.length)fail();
 const stages=(v.stages as unknown[]).map((rawStage,index):StudyLongitudinalStage=>{
  const s=object(rawStage,['stage','groupId','label','occurrence','sources','state','reasons']),point=points[index];
  if(s.stage!==point.stage||s.groupId!==point.groupId||s.label!==point.label||s.state!=='unavailable')fail();
  const occurrence=readOccurrenceEvidence(s.occurrence);if(JSON.stringify(occurrence)!==JSON.stringify(point.occurrence))fail();
  const selected=point.sources.filter(source=>source.kind==='ceph_study');if(!Array.isArray(s.sources)||s.sources.length!==selected.length)fail();
  const sources=(s.sources as unknown[]).map((rawSource,n):StudyLongitudinalSource=>{
   const r=object(rawSource,['key','id','contentHash','captureState','status','acquisitionDate','referenceSetKey','image','witness','completion','reasons']),selection=selected[n];
   if(typeof selection.key!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(selection.key)||!journeyId(selection.id)||!journeyHash(selection.contentHash)||r.key!==selection.key||r.id!==selection.id||r.contentHash!==selection.contentHash||r.captureState!=='available'&&r.captureState!=='unavailable')fail();
   const result:StudyLongitudinalSource={key:selection.key,id:selection.id,contentHash:selection.contentHash,captureState:r.captureState as 'available'|'unavailable',status:null,acquisitionDate:null,referenceSetKey:null,image:null,witness:'unavailable',completion:null,reasons:reasons(r.reasons)};
   if(r.captureState==='unavailable') {if(r.status!==null||r.acquisitionDate!==null||r.referenceSetKey!==null||r.image!==null||r.witness!=='unavailable'||r.completion!==null)fail();}
   else {if((r.status!=='draft'&&r.status!=='completed'&&r.status!=='discarded')||(r.witness!=='legacy_unversioned'&&r.witness!=='versioned_unconfirmed_view'&&r.witness!=='versioned_source_identity_matched'))fail();result.status=r.status as StudyLongitudinalSource['status'];result.acquisitionDate=r.acquisitionDate===null?null:text(r.acquisitionDate,20);result.referenceSetKey=text(r.referenceSetKey,200);result.witness=r.witness;
    if(r.witness==='legacy_unversioned'){if(r.completion!==null)fail();}else{result.completion=completionMetadata(r.completion,r.witness);if(result.status!=='completed'||result.referenceSetKey!==result.completion.referenceSet.key)fail();}
    const image=object(r.image,['documentId','contentHash','state']);if(!journeyId(image.documentId)||!journeyHash(image.contentHash)||(image.state!=='available'&&image.state!=='removed'))fail();result.image={documentId:image.documentId,contentHash:image.contentHash,state:image.state as 'available'|'removed'};if(result.completion&&result.image.state!=='available')fail();
    if(result.completion?.schemaVersion===2){const identity=result.completion.sourceReview.identity;if(identity.documentId!==image.documentId||identity.imageSha256!==image.contentHash)fail();}
   }
   if(JSON.stringify(result.reasons)!==JSON.stringify(longitudinalSourceReasons(result)))fail();return result;
  });
  const result={stage:point.stage,groupId:point.groupId,label:point.label,occurrence,sources,state:'unavailable' as const,reasons:reasons(s.reasons)};
  if(JSON.stringify(result.reasons)!==JSON.stringify(longitudinalStageReasons(sources)))fail();return result;
 });
 const policyVersion=longitudinalPolicy(stages);
 if(v.policyVersion!==policyVersion||JSON.stringify(v.pairs)!==JSON.stringify(longitudinalPairs(stages)))fail();
 return {ok:true,patientId:expected.patientId,orthoCaseId:expected.orthoCaseId,clinicalCaseId:expected.clinicalCaseId,revisionId:expected.revisionId,revisionHash:expected.revisionHash,kind:expected.kind,capturedAt,policyVersion,stages,pairs:longitudinalPairs(stages)};
}
