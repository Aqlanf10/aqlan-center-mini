import type {RetentionLedgerRead} from './ortho-retention-client';
import {journeyId,journeyHash} from './ortho-case-journey-records';
import {canonicalJourneyJSON} from './ortho-case-journey-json';
import {projectRetentionEventHistory} from './ortho-retention-event-history';
const dense=(v:unknown,max:number):v is unknown[]=>Array.isArray(v)&&v.length<=max&&Object.keys(v).length===v.length&&Array.from({length:v.length},(_,i)=>Object.hasOwn(v,i)).every(Boolean);
/** Local consistency boundary shared by presentation adapters. Input must already
 * pass verifyRetentionRead/current authority. This is NOT fresh hash or access
 * verification; complete history and cached projections must remain coherent. */
export function readSavedRetentionLedgerContext(data:RetentionLedgerRead){
 try{
  if(!data||data.ok!==true||!data.scope||!journeyId(data.actorId)||![data.scope.patientId,data.scope.orthoCaseId,data.scope.clinicalCaseId].every(journeyId)||!dense(data.history,1000)||!dense(data.sourceMatches,30000))return null;
  const history=data.history;
  if(data.headId!==(history[0]?.id??null)||new Set(history.map(r=>r.id)).size!==history.length)return null;
  if(history.some((r,i)=>!journeyId(r.id)||!journeyHash(r.contentHash)||r.version!==history.length-i||r.predecessorId!==(history[i+1]?.id??null)||r.patientId!==data.scope.patientId||r.recordedPatientId!==data.scope.patientId||r.orthoCaseId!==data.scope.orthoCaseId||r.clinicalCaseId!==data.scope.clinicalCaseId))return null;
  const records=history.map(r=>({id:r.id,version:r.version,arch:r.content.arch,supersedesEntryId:r.content.supersedesEntryId,archCorrectionReason:r.content.archCorrectionReason,content:r.content.payload}));
  const reconstructed=projectRetentionEventHistory(records);
  if(!reconstructed.ok||canonicalJourneyJSON(reconstructed.value)!==canonicalJourneyJSON({devices:data.devices,currentEvents:data.currentEvents}))return null;
  const expectedSources=history.flatMap(r=>r.content.payload.documentIds.map(documentId=>({entryId:r.id,documentId,witnessed:'savedVersion' in r.content})));
  if(expectedSources.length!==data.sourceMatches.length||expectedSources.some((s,i)=>{const actual=data.sourceMatches[i];return !actual||actual.entryId!==s.entryId||actual.documentId!==s.documentId||(s.witnessed?typeof actual.identityMatch!=='boolean':actual.identityMatch!==null);}))return null;
  return {records,projection:reconstructed.value,binding:{scope:{...data.scope},actorId:data.actorId,headId:data.headId,headVersion:history[0]?.version??null,headHash:history[0]?.contentHash??null,sourceMatches:data.sourceMatches.map(s=>({entryId:s.entryId,documentId:s.documentId,identityMatch:s.identityMatch}))}};
 }catch{return null;}
}
