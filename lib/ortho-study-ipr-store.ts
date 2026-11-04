import type {DbClient} from './db';
import {journeyContentHash,journeyHistory} from './ortho-case-journey-history';
import {journeyFail,type JourneyOwner,type JourneyAuthority} from './ortho-case-journey-authority';
import {readSpaceSavedContent} from './ortho-space-saved';
import {STUDY_IPR_LIMIT,makeStudyIprSnapshot,studyIprEntry,type StudyIprSnapshot} from './ortho-study-ipr';
import {prepareStudySpacePlanAccess,requirePreparedStudySpacePlanAccess} from './ortho-study-space-plan-store';
import {addStudySessionVisitTargets,type StudyAssessmentAccess} from './ortho-case-study-assessment-access';
async function history(client:DbClient,owner:JourneyOwner){
  return (await journeyHistory(client,'ortho_space_entries',owner,readSpaceSavedContent)).revisions;
}
export async function readStudyIprSnapshots(client:DbClient,owner:JourneyOwner,ids:readonly number[]){
  const out=new Map<number,StudyIprSnapshot>();if(!ids.length)return out;
  const rows=await history(client,owner);
  for(const id of ids){const head=rows.find(r=>r.id===id);if(!head)continue;
    const prefix=rows.filter(r=>r.version<=head.version).reverse();
    if(prefix.length>STUDY_IPR_LIMIT)journeyFail(409,'study_ipr_snapshot_limit');
    if(!prefix.some(r=>r.content.authored.kind==='ipr'))continue;
    out.set(id,makeStudyIprSnapshot(owner,prefix.map(studyIprEntry)));
  }
  return out;
}
export async function prepareStudyIprAccess(client:DbClient,owner:JourneyOwner,authority:JourneyAuthority,snapshots:readonly StudyIprSnapshot[],cache:StudyAssessmentAccess){
  if(!snapshots.length)return;
  if(!authority.canViewPlans)journeyFail(403,'study_ipr_restricted');
  const rows=await history(client,owner),ids=new Set(snapshots.flatMap(s=>s.entries.map(e=>e.id)));
  await prepareStudySpacePlanAccess(client,owner,authority,rows.filter(r=>ids.has(r.id)&&r.content.authored.kind==='plan'),cache);
  addStudySessionVisitTargets(cache,snapshots.flatMap(s=>s.entries.flatMap(e=>e.content.adjustment?[e.content.adjustment.visitId]:[])));
}
export async function requireStudyIprRead(client:DbClient,owner:JourneyOwner,authority:JourneyAuthority,snapshot:StudyIprSnapshot,cache:StudyAssessmentAccess){
  if(!authority.canViewPlans)journeyFail(403,'study_ipr_restricted');
  const live=(await readStudyIprSnapshots(client,owner,[snapshot.headId])).get(snapshot.headId);
  // Patient merges move current authority; recording provenance is immutable.
  if(!live||journeyContentHash({...live,patientId:snapshot.patientId})!==journeyContentHash(snapshot))journeyFail(403,'study_ipr_unavailable');
  const rows=await history(client,owner);let images=false;
  for(const e of snapshot.entries){
    const content=e.content.authored;
    if(content.kind==='plan'){
      const row=rows.find(r=>r.id===e.id);if(!row)journeyFail(403,'study_ipr_plan_unavailable');
      images=requirePreparedStudySpacePlanAccess(authority,row,cache)||images;
    }else{
      const visit=e.content.adjustment?.visitId;
      const row=(await client.query<{visit_id:number|null}>('SELECT visit_id FROM ortho_adjustments WHERE id=$1 AND case_id=$2 FOR SHARE',[content.adjustmentId,owner.orthoCaseId])).rows[0];
      if(!visit||row?.visit_id!==visit||!cache.currentSessionVisitIds.has(visit))journeyFail(403,'study_ipr_session_unavailable');
    }
  }
  return images;
}
