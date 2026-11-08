import {journeyContentHash} from '../../lib/ortho-case-journey-hash';
import {STUDY_TEMPLATE_HASH} from '../../lib/ortho-case-study-template';
import {CASE_TEMPLATE_VERSION} from '../../lib/ortho-case-template';
import type {StudyRevision} from '../../lib/ortho-case-study-history';
import type {StudySavedContent} from '../../lib/ortho-case-study-capture';
export function syntheticLongitudinalStudy():StudyRevision<StudySavedContent>{
 const scope={patientId:19,orthoCaseId:41,clinicalCaseId:51};
 const sources=[1,2,3,4].map(n=>{
  const payload={id:90+n,status:'completed',phase:'pretreatment',acquisitionDate:n===1?null:`2020-0${n}-01`,device:'Synthetic scanner',referenceSetKey:`synthetic_reference_${n}`,studyKind:'lateral',note:null,
   createdAt:'2026-09-01T00:00:00.000Z',createdBy:'Synthetic clinician',completedAt:'2026-09-02T00:00:00.000Z',completedBy:'Synthetic clinician',correctsStudyId:null,
   image:{documentId:70+n,contentHash:String(n).repeat(64),state:'available'},measurements:[{code:'SNA',value:85-n,unit:null,provenance:'stored_measurement_unit_not_versioned'},{code:'EXT_INDEX',value:99999994,unit:null,provenance:'stored_measurement_unit_not_versioned'}],
   diagnosis:null,interpretation:{state:'unavailable',reason:'review_and_reference_witness_not_versioned'},historicalCompletionMeaning:'stored_completion_not_new_clinical_validation'};
  const selection={key:`ceph${n}`,kind:'ceph_study' as const,id:payload.id,version:null,contentHash:journeyContentHash(payload)};
  return {selection,state:'available' as const,unavailableReason:null,access:{images:true,plans:false},payload};
 });
 const content:StudySavedContent={schemaVersion:1,capturedAt:'2026-10-01T00:00:00.000Z',recordedPatientId:scope.patientId,orthoCaseId:scope.orthoCaseId,clinicalCaseId:scope.clinicalCaseId,caseStatusAtCapture:'active',sources,
  authored:{template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:STUDY_TEMPLATE_HASH},identityDisclosure:'case_only',sources:sources.map(s=>s.selection),groups:sources.map((s,n)=>({id:`group${n+1}`,phase:`T${n+1}`,label:`Synthetic stage ${n+1}`,sourceKeys:[s.selection.key],occurrence:n===0?{occurredOn:null,dateProvenance:'unknown',sourceNote:'Synthetic unknown date'}:{occurredOn:`2020-0${n+1}-01`,dateProvenance:'historical_source',sourceNote:`Synthetic source ${n+1}`}})),
   mediaUses:[],panels:[{instanceId:'ceph_panel',layoutKey:'ceph-measurements',included:true,state:'available',sourceKeys:sources.map(s=>s.selection.key),images:[],comment:''}],comment:''}};
 return {...scope,id:101,actorId:7,version:1,recordedPatientId:scope.patientId,schemaVersion:1,predecessorId:null,kind:'documented',documentedFromId:100,baseDocumentedId:null,createdAt:content.capturedAt,reason:'Synthetic longitudinal review',contentHash:journeyContentHash(content),content};
}
export function rehashSyntheticLongitudinal(saved:StudyRevision<StudySavedContent>){
 for(const source of saved.content.sources)if(source.state==='available'){source.selection.contentHash=journeyContentHash(source.payload);const selection=saved.content.authored.sources.find(s=>s.key===source.selection.key);if(selection)selection.contentHash=source.selection.contentHash;}
 saved.contentHash=journeyContentHash(saved.content);return saved;
}
