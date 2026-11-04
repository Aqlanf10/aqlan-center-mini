import type {DbClient} from './db';
import {journeyContentHash,journeyHistory,type JourneyRevision} from './ortho-case-journey-history';
import {journeyFail,type JourneyAuthority,type JourneyOwner} from './ortho-case-journey-authority';
import {journeyClinicalSources} from './ortho-case-journey-clinical-sources';
import {readSpaceSavedContent,type SpaceSavedContent} from './ortho-space-saved';
import {spaceBaselines} from './ortho-space-baselines';
import {prepareStudyAssessmentAccess,requirePreparedAssessmentAccess,type StudyAssessmentAccess} from './ortho-case-study-assessment-access';
export type StudySpacePlan = JourneyRevision<SpaceSavedContent>;
export async function readStudySpacePlans(client:DbClient,owner:JourneyOwner,ids:readonly number[]){
 if(!ids.length)return new Map<number,StudySpacePlan>();
 const history=await journeyHistory(client,'ortho_space_entries',owner,readSpaceSavedContent);
 return new Map(history.revisions.filter(r=>ids.includes(r.id)&&r.content.authored.kind==='plan').map(r=>[r.id,r]));
}
/** Discovery only. Expand the assessment closure before the caller locks the
 * complete source union and the case. Never start a nested transaction. */
export async function prepareStudySpacePlanAccess(client:DbClient,owner:JourneyOwner,authority:JourneyAuthority,plans:readonly StudySpacePlan[],cache:StudyAssessmentAccess){
 if(!plans.length)return;
 if(!authority.canViewPlans)journeyFail(403,'study_space_plan_restricted');
 const clinical=await journeyClinicalSources(client,owner,authority,['assessment','strategy'],cache,true);
 const baselines=spaceBaselines(clinical.assessments);
 const selected=plans.map(entry=>{
  const p=entry.content.authored;
  if(entry.orthoCaseId!==owner.orthoCaseId||entry.clinicalCaseId!==owner.clinicalCaseId||p.kind!=='plan')journeyFail(403,'study_space_plan_scope');
  const source=baselines.find(b=>b.arch===p.arch&&journeyContentHash(b.ref)===journeyContentHash(p.baseline));
  if(!source||journeyContentHash(entry.content.baseline)!==journeyContentHash({discrepancyMm:source.discrepancyMm,estimated:source.estimated}))journeyFail(403,'study_space_baseline_unavailable');
  const strategy=clinical.strategies.find(s=>s.id===p.strategyRevisionId);
  if(!strategy||!clinical.readableStrategy(strategy))journeyFail(403,'study_space_strategy_unavailable');
  return source.revision;
 });
 await prepareStudyAssessmentAccess(client,owner,authority,selected,cache);
}
export async function requireStudySpacePlanRead(client:DbClient,owner:JourneyOwner,authority:JourneyAuthority,entry:StudySpacePlan,cache:StudyAssessmentAccess){
 if(!authority.canViewPlans)journeyFail(403,'study_space_plan_restricted');
 const live=(await readStudySpacePlans(client,owner,[entry.id])).get(entry.id),p=entry.content.authored;
 if(!live||p.kind!=='plan'||live.version!==entry.version||live.contentHash!==entry.contentHash||live.recordedPatientId!==entry.recordedPatientId)journeyFail(403,'study_space_plan_unavailable');
 const baseline=[...cache.closures.values()].find(({revision:r})=>r.id===p.baseline.id&&`sha256:${r.contentHash}`===p.baseline.version)?.revision;
 if(!baseline)journeyFail(403,'study_space_baseline_unavailable');
 return requirePreparedAssessmentAccess(cache,baseline,authority,false);
}
