/** Transaction-local prefix source proofs; no nested transactions or live-value substitution. */
import type {DbClient} from './db';
import {journeyFail,type JourneyOwner,type JourneyAuthority} from './ortho-case-journey-authority';
import {journeyContentHash} from './ortho-case-journey-hash';
import {spaceHistory} from './ortho-space-history';
import {prepareSpaceAssessmentSources,requireSpaceBaseline,type PreparedSpaceAssessmentSources} from './ortho-space-baselines';
import {selectSpaceBaselineRefs} from './ortho-space-source-selection';
import {journeyClinicalSources} from './ortho-case-journey-clinical-sources';
import {addStudyPlanTargets,addStudySessionVisitTargets,type StudyAssessmentAccess} from './ortho-case-study-assessment-access';
import {readStudySpaceCapture,type StudySpaceCapture} from './ortho-study-space-capture';
import type {StudySourceSelection} from './ortho-case-study';
interface Prepared {capture:StudySpaceCapture;assessments:PreparedSpaceAssessmentSources;links:{id:number;plan_id:number}[];problems:number[];images:boolean}
const prepared=new WeakMap<StudyAssessmentAccess,Map<number,Prepared>>();
export async function discoverStudySpacePrefix(client:DbClient,owner:JourneyOwner,headId:number,version:number|null){
 if(version===null)journeyFail(400,'invalid_space_prefix');
 const all=await spaceHistory(client,owner,version),head=all.revisions.find(r=>r.id===headId&&r.version===version);if(!head)return null;
 const history=all.revisions.filter(r=>r.version<=head.version);
 const capture:StudySpaceCapture={captureVersion:1,patientId:owner.patientId,orthoCaseId:owner.orthoCaseId,clinicalCaseId:owner.clinicalCaseId,headId,headVersion:head.version,history};
 if(Buffer.byteLength(JSON.stringify(capture))>2097152)journeyFail(409,'study_space_capture_limit');
 readStudySpaceCapture(capture,{key:'space',kind:'space_ledger',id:headId,version:head.version,contentHash:journeyContentHash(capture)});
 const latest=(await client.query<{id:number}>('SELECT id FROM ortho_space_entries WHERE ortho_case_id=$1 ORDER BY version DESC LIMIT 1',[owner.orthoCaseId])).rows[0];
 return {capture,current:head.id===latest?.id};
}
export async function prepareStudySpaceSource(client:DbClient,owner:JourneyOwner,authority:JourneyAuthority,cache:StudyAssessmentAccess,selection:StudySourceSelection,saved?:StudySpaceCapture){
 if(!authority.canViewPlans)journeyFail(403,'space_plan_access');
 const found=await discoverStudySpacePrefix(client,owner,selection.id,selection.version);if(!found){if(saved)journeyFail(403,'study_space_source_unavailable');return;}
 if(!saved&&!found.current)journeyFail(409,'study_space_head_changed');
 if(saved&&journeyContentHash(found.capture)!==journeyContentHash(saved))journeyFail(403,'study_space_source_changed');
 const capture=saved??found.capture;
 const existing=prepared.get(cache)?.get(selection.id);if(existing)return;
 const plans=capture.history.flatMap(r=>r.content.authored.kind==='plan'?[r.content.authored]:[]);
 const assessments=await prepareSpaceAssessmentSources(client,owner,authority,selectSpaceBaselineRefs(plans),cache,{includeLatest:false});
 const clinical=await journeyClinicalSources(client,owner,authority,['strategy'],cache);
 const ids=new Set(plans.map(p=>p.strategyRevisionId)),strategies=clinical.strategies.filter(s=>ids.has(s.id));
 if(strategies.length!==ids.size)journeyFail(403,'space_strategy_missing');
 const itemIds=[...new Set(strategies.flatMap(s=>s.rows.flatMap(r=>r.planItems.map(i=>i.id))))].sort((a,b)=>a-b);
 const problems=[...new Set(strategies.flatMap(s=>s.rows.map(r=>r.problem.id)))].sort((a,b)=>a-b);
 const links=itemIds.length?(await client.query<{id:number;plan_id:number}>(`SELECT i.id,i.plan_id FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE i.id=ANY($1::int[]) AND p.patient_id=$2 AND i.case_id=$3 ORDER BY i.id`,[itemIds,owner.patientId,owner.clinicalCaseId])).rows:[];
 if(links.length!==itemIds.length)journeyFail(403,'space_strategy_links_unavailable');
 addStudyPlanTargets(cache,links.map(l=>l.plan_id));
 addStudySessionVisitTargets(cache,capture.history.flatMap(r=>r.content.adjustment?[r.content.adjustment.visitId]:[]));
 const baselineIds=new Set(assessments.baselines.map(b=>b.revision.id));
 const images=[...cache.closures.values()].some(c=>baselineIds.has(c.revision.id)&&c.closure.external.some(s=>s.kind==='document'||s.kind==='ceph_study'));
 const map=prepared.get(cache)??new Map<number,Prepared>();map.set(selection.id,{capture,assessments,links,problems,images});prepared.set(cache,map);
}
export async function requireStudySpaceSource(client:DbClient,owner:JourneyOwner,authority:JourneyAuthority,cache:StudyAssessmentAccess,selection:StudySourceSelection){
 const p=prepared.get(cache)?.get(selection.id);if(!p)journeyFail(403,'study_space_source_unavailable');
 if(!authority.canViewPlans)journeyFail(403,'space_plan_access');
 const live=await discoverStudySpacePrefix(client,owner,selection.id,selection.version);
 if(!live||journeyContentHash(live.capture)!==journeyContentHash(p.capture))journeyFail(403,'study_space_source_changed');
 const ids=p.links.map(l=>l.id);
 const links=ids.length?(await client.query<{id:number;plan_id:number}>(`SELECT i.id,i.plan_id FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id WHERE i.id=ANY($1::int[]) AND t.patient_id=$2 AND i.case_id=$3 ORDER BY i.id FOR SHARE OF i`,[ids,owner.patientId,owner.clinicalCaseId])).rows:[];
 if(journeyContentHash(links)!==journeyContentHash(p.links)||links.some(l=>!cache.currentPlanIds.has(l.plan_id)))journeyFail(403,'space_strategy_links_unavailable');
 if(p.problems.length){const rows=(await client.query("SELECT id FROM patient_problems WHERE id=ANY($1::int[]) AND patient_id=$2 AND case_id=$3 AND specialty='orthodontics' ORDER BY id FOR SHARE",[p.problems,owner.patientId,owner.clinicalCaseId])).rows;if(rows.length!==p.problems.length)journeyFail(403,'space_strategy_problem_unavailable');}
 for(const r of p.capture.history){const c=r.content.authored;if(c.kind==='plan'){
   const b=requireSpaceBaseline(p.assessments,c.baseline,c.arch,authority,{requireLatest:false,exactCurrentSources:false});
   if(journeyContentHash(r.content.baseline)!==journeyContentHash({discrepancyMm:b.discrepancyMm,estimated:b.estimated}))journeyFail(500,'space_baseline_proof_mismatch');
  }else{const a=(await client.query<{visit_id:number|null}>('SELECT visit_id FROM ortho_adjustments WHERE id=$1 AND case_id=$2 FOR SHARE',[c.adjustmentId,owner.orthoCaseId])).rows[0];if(!a||a.visit_id!==r.content.adjustment!.visitId||!cache.currentSessionVisitIds.has(a.visit_id!))journeyFail(403,'space_session_unavailable');}
 }
 return p;
}
