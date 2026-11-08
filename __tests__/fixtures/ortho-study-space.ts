import { journeyContentHash } from '../../lib/ortho-case-journey-hash';
import { CASE_TEMPLATE_VERSION } from '../../lib/ortho-case-template';
import { STUDY_TEMPLATE_HASH } from '../../lib/ortho-case-study-template';
import type { StudySpaceCapture } from '../../lib/ortho-study-space-capture';
import type { SpaceRevision } from '../../lib/ortho-space-client';
import type { SpaceContent } from '../../lib/ortho-space-ledger';
import type { StudySourceSelection } from '../../lib/ortho-case-study';
import type { StudySavedContent } from '../../lib/ortho-case-study-capture';
import type { StudyRevision } from '../../lib/ortho-case-study-history';
export const spaceStudyScope = { patientId: 19, orthoCaseId: 41, clinicalCaseId: 51 };
const plan = (rationale = 'SYNTHETIC_ORIGINAL_PLAN'): SpaceContent => ({ kind: 'plan', arch: 'upper', strategyRevisionId: 8,
  baseline: {kind:'assessment_analysis',id:9,member:'arch_space_upper',version:`sha256:${'a'.repeat(64)}`},
  gains:[{key:'gain1',method:'other',label:'Synthetic gain',estimateUm:null,overlapGroup:'synthetic',included:false,rationale:'Recorded uncertain estimate'}],
  uses:[{key:'use1',label:'Synthetic use',amountUm:0}],
  contacts:[{teeth:[11,12],plannedUm:300,budgetGainUm:100,clinicianLimitUm:null,note:'Synthetic contact'},
    {teeth:[21,22],plannedUm:null,budgetGainUm:null,clinicianLimitUm:null,note:'Synthetic unknown contact'}],rationale,alternatives:'Synthetic alternatives'});
export function spaceStudyFixture() {
 const history: SpaceRevision[]=[];
 const add=(content:SpaceContent,session?:{visitId:number;occurredOn:string;recordedBy:string})=>{
  const saved={authored:content,baseline:content.kind==='plan'?{discrepancyMm:-1.25,estimated:false}:null,adjustment:session??null};
  const r:SpaceRevision={...spaceStudyScope,id:101+history.length,recordedPatientId:19,schemaVersion:1,version:history.length+1,predecessorId:history.at(-1)?.id??null,
   createdBy:'Synthetic recorder',createdAt:'2026-11-06T00:00:00.000Z',reason:'Synthetic saved reason',recordingContext:'current',caseStatusAtCapture:'active',contentHash:journeyContentHash(saved),content:saved};history.push(r);
 };
 add(plan());
 const original:SpaceContent={kind:'ipr',arch:'upper',planEntryId:101,teeth:[11,12],adjustmentId:7,performedUm:100,measurementNote:'SYNTHETIC_ORIGINAL_MEASUREMENT',supersedesEntryId:null,reviewReason:null};
 const session={visitId:17,occurredOn:'2024-02-29',recordedBy:'SYNTHETIC_ORIGINAL_SESSION_ACTOR'};
 add(original,session);add(plan('SYNTHETIC_LATER_PLAN'));
 add({...original,performedUm:0,supersedesEntryId:102,measurementNote:'SYNTHETIC_CORRECTION',reviewReason:'Synthetic documented correction'},session);
 add({...original,teeth:[21,22],adjustmentId:8,performedUm:null,measurementNote:'SYNTHETIC_UNKNOWN_AMOUNT'},{visitId:18,occurredOn:'2024-03-01',recordedBy:'Synthetic session actor'});
 add({...original,planEntryId:103,adjustmentId:9,performedUm:200,measurementNote:'SYNTHETIC_LATER_PERFORMANCE'},{visitId:19,occurredOn:'2024-03-02',recordedBy:'Synthetic later actor'});
 const capture:StudySpaceCapture={captureVersion:1,...spaceStudyScope,headId:106,headVersion:6,history:[...history].reverse()};
 const selection:StudySourceSelection={key:'space_snapshot',kind:'space_ledger',id:106,version:6,contentHash:journeyContentHash(capture)};
 const content:StudySavedContent={schemaVersion:1,capturedAt:'2026-11-06T01:00:00.000Z',recordedPatientId:19,orthoCaseId:41,clinicalCaseId:51,caseStatusAtCapture:'active',
  authored:{template:{key:'full-orthodontic-case',version:CASE_TEMPLATE_VERSION,contentHash:STUDY_TEMPLATE_HASH},identityDisclosure:'case_only',sources:[selection],groups:[],mediaUses:[],comment:'',
   panels:[{instanceId:'space_panel',layoutKey:'model-measurements',included:true,state:'available',sourceKeys:[selection.key],images:[],comment:''}]},
  sources:[{selection,state:'available',unavailableReason:null,access:{images:false,plans:true},payload:capture}]};
 const revision:StudyRevision<StudySavedContent>={...spaceStudyScope,id:200,actorId:4,recordedPatientId:19,schemaVersion:1,version:1,predecessorId:null,kind:'draft',documentedFromId:null,baseDocumentedId:null,createdAt:content.capturedAt,reason:'Synthetic study',contentHash:journeyContentHash(content),content};
 return {capture,selection,content,revision};
}
