import {studyCephBase} from './ortho-study-ceph-lineage';
/** Read-only eligibility over immutable saved study bytes, never today's ceph
 * definitions/references, mutable landmarks, or inferred acquisition order. */
import {isWitnessedStudyCephCapture} from './ortho-study-ceph-capture';
import {decodeStudySavedContent} from './ortho-case-study-capture';
import {journeyContentHash} from './ortho-case-journey-hash';
import {projectStudyTimepoints} from './ortho-case-study-timepoints';
import {longitudinalPolicy,longitudinalSourceReasons,longitudinalStageReasons,longitudinalPairs,readStudyLongitudinalReview,type StudyLongitudinalSource,type StudyLongitudinalStage} from './ortho-study-longitudinal-contract';
import type {StudyRevision} from './ortho-case-study-history';
import type {StudySavedContent} from './ortho-case-study-capture';
import type {JourneyScope} from './ortho-case-journey-records';
export function projectStudyLongitudinalEligibility(revision:StudyRevision<StudySavedContent>,scope:JourneyScope){
 if(revision.patientId!==scope.patientId||revision.orthoCaseId!==scope.orthoCaseId||revision.clinicalCaseId!==scope.clinicalCaseId||journeyContentHash(revision.content)!==revision.contentHash)throw Error('study_longitudinal_revision_changed');
 const bound={patientId:scope.patientId,orthoCaseId:scope.orthoCaseId,clinicalCaseId:scope.clinicalCaseId};
 const parsed=decodeStudySavedContent(revision.content,scope);if(!parsed.ok)throw Error(parsed.code);const saved=parsed.value;
 const stages:StudyLongitudinalStage[]=projectStudyTimepoints(saved.authored).map(point=>{
  const sources=point.sources.filter(source=>source.kind==='ceph_study').map(selection=>{
   const capture=saved.sources.find(source=>source.selection.key===selection.key);if(!capture)throw Error('study_longitudinal_capture_missing');
   const result:StudyLongitudinalSource={key:selection.key,id:selection.id,contentHash:selection.contentHash,captureState:capture.state,status:null,acquisitionDate:null,referenceSetKey:null,image:null,witness:'unavailable',completion:null,reasons:[]};
   if(capture.state==='available'){
    const base=studyCephBase(capture.payload);
    if(isWitnessedStudyCephCapture(base)){
     const p=base,w=p.completion.witness;
     // Completed witnesses were checked by the saved-content decoder. Narrow
     // the nullable snapshot shape explicitly before copying its calibration.
     const {calibration,mmPerPixel}=w.snapshot;
     if(calibration===null||mmPerPixel===null)throw Error('study_longitudinal_calibration_missing');
     const algorithms=[...new Map(w.measurements.filter(m=>m.code!=='EXT_INDEX').map(m=>{
      const a=m.algorithm,algorithm={id:a.id,version:a.version,sourceSha256:a.sourceSha256,calculationVersion:a.calculationVersion,rounding:a.rounding};
      return [JSON.stringify(algorithm),algorithm] as const;
     })).entries()]
      .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,algorithm])=>({...algorithm}));
     const common={witnessSha256:p.completion.witnessSha256,sealedAt:w.sealedAt,algorithms,
      referenceSet:{key:w.referenceSet.key,version:w.referenceSet.version,sha256:w.referenceSetSha256},
      calibration:{...calibration,mmPerPixel}};
     Object.assign(result,{status:p.status,acquisitionDate:p.acquisitionDate,referenceSetKey:w.referenceSet.key,
      image:{documentId:w.image.documentId,contentHash:w.image.sha256,state:'available'}});
     if(p.captureVersion===3){const matched=p.completion.witness;
      result.witness='versioned_source_identity_matched';
      result.completion={schemaVersion:2,...common,sourceIdentityMeaning:matched.sourceIdentityMeaning,
       sourceReview:{schemaVersion:1,identity:{...matched.sourceReview.identity}}};
     }else{
      result.witness='versioned_unconfirmed_view';
      result.completion={schemaVersion:1,...common,sourceIdentityMeaning:p.completion.witness.sourceIdentityMeaning};
     }
    }else{
     const p=base as {status:StudyLongitudinalSource['status'];acquisitionDate:string|null;referenceSetKey:string;image:StudyLongitudinalSource['image']};
     Object.assign(result,{status:p.status,acquisitionDate:p.acquisitionDate,referenceSetKey:p.referenceSetKey,image:p.image,witness:'legacy_unversioned'});
    }
   }
   result.reasons=longitudinalSourceReasons(result);return result;
  });
  return {stage:point.stage,groupId:point.groupId,label:point.label,occurrence:point.occurrence,sources,state:'unavailable',reasons:longitudinalStageReasons(sources)};
 });
 return readStudyLongitudinalReview({ok:true,...bound,revisionId:revision.id,revisionHash:revision.contentHash,kind:revision.kind,capturedAt:saved.capturedAt,policyVersion:longitudinalPolicy(stages),stages,pairs:longitudinalPairs(stages)},
 {...bound,revisionId:revision.id,revisionHash:revision.contentHash,kind:revision.kind,authored:saved.authored});
}
