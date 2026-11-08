/** Internal transaction primitive only. Public writes must use the durable journal. */
import {insertAuditRow,type DbClient} from './db';
import {authorizeJourney,assertJourneyCurrent,discoverJourneyOwner,lockJourneyOwner,journeyFail,journeyTransaction,type JourneyOwnerInput} from './ortho-case-journey-authority';
import {replayJourney} from './ortho-case-journey-history';
import {journeyContentHash} from './ortho-case-journey-hash';
import {journeyClinicalSources} from './ortho-case-journey-clinical-sources';
import {createStudyAssessmentAccess,addStudyPlanTargets,addStudySessionVisitTargets,lockStudySourceUnion} from './ortho-case-study-assessment-access';
import {prepareSpaceAssessmentSources,requireSpaceBaseline,spaceBaselineChoices} from './ortho-space-baselines';
import {spaceHistory,insertSpaceEntry,lockSpaceHistoryTables} from './ortho-space-history';
import {projectIpr,contactKey,iprReviewNeeded,type SpacePlan} from './ortho-space-ledger';
import {selectSpaceBaselineRefs} from './ortho-space-source-selection';
import type {SpacePersistenceCommand} from './ortho-space-command';
import {journeyId,journeyHash} from './ortho-case-journey-records';
import type {SpaceSavedContent} from './ortho-space-saved';
type Adjustment={id:number;visit_id:number|null;done_on:string;recorded_by:string};
async function prepare(client:DbClient,input:JourneyOwnerInput,write:boolean,command?:SpacePersistenceCommand,historicalOnly=false){
 const authority=await authorizeJourney(client,input,write);
 if(!authority.canViewPlans||write&&!authority.canEditPlans)journeyFail(403,'space_plan_access');
 const discovered=await discoverJourneyOwner(client,input),history=await spaceHistory(client,discovered),cache=createStudyAssessmentAccess();
 const plans=history.revisions.flatMap(r=>r.content.authored.kind==='plan'?[r.content.authored]:[]);
 if(command?.content.kind==='plan')plans.push(command.content);
 const selectedRefs=selectSpaceBaselineRefs(plans);
 const assessments=await prepareSpaceAssessmentSources(client,discovered,authority,selectedRefs,cache,{includeLatest:!historicalOnly});
 const sources=await journeyClinicalSources(client,discovered,authority,['strategy'],cache);
 const wantedStrategies=new Set(plans.map(p=>p.strategyRevisionId));
 if(!historicalOnly&&sources.strategies[0])wantedStrategies.add(sources.strategies[0].id);
 const strategies=sources.strategies.filter(s=>wantedStrategies.has(s.id));
 if(strategies.length!==wantedStrategies.size)journeyFail(403,'space_strategy_missing');
 const itemIds=[...new Set(strategies.flatMap(s=>s.rows.flatMap(r=>r.planItems.map(i=>i.id))))].sort((a,b)=>a-b);
 const problemIds=[...new Set(strategies.flatMap(s=>s.rows.map(r=>r.problem.id)))].sort((a,b)=>a-b);
 // Discover parent plans before acquiring the complete external-source union.
 const links=itemIds.length?(await client.query<{id:number;plan_id:number}>(`SELECT i.id,i.plan_id FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id
  WHERE i.id=ANY($1::int[]) AND p.patient_id=$2 AND i.case_id=$3 ORDER BY i.id`,[itemIds,discovered.patientId,discovered.clinicalCaseId])).rows:[];
 if(links.length!==itemIds.length)journeyFail(403,'space_strategy_links_unavailable');
 addStudyPlanTargets(cache,links.map(l=>l.plan_id));
 const adjustments=(await client.query<Adjustment>('SELECT id,visit_id,done_on::text,recorded_by FROM ortho_adjustments WHERE case_id=$1 ORDER BY id LIMIT 129',[discovered.orthoCaseId])).rows;
 if(adjustments.length>128)journeyFail(409,'space_session_reference_limit');
 addStudySessionVisitTargets(cache,adjustments.flatMap(a=>a.visit_id===null?[]:[a.visit_id]));
 await lockStudySourceUnion(client,discovered,authority,cache);
 const owner=await lockJourneyOwner(client,input,write);
 if(owner.clinicalCaseId!==discovered.clinicalCaseId||owner.patientId!==discovered.patientId||owner.status!==discovered.status)journeyFail(409,'space_owner_changed');
 const locked=(await client.query<Adjustment>('SELECT id,visit_id,done_on::text,recorded_by FROM ortho_adjustments WHERE case_id=$1 ORDER BY id FOR SHARE',[owner.orthoCaseId])).rows;
 if(journeyContentHash(locked)!==journeyContentHash(adjustments))journeyFail(409,'space_sessions_changed');
 const currentLinks=itemIds.length?(await client.query<{id:number;plan_id:number}>(`SELECT i.id,i.plan_id FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id
 WHERE i.id=ANY($1::int[]) AND p.patient_id=$2 AND i.case_id=$3 ORDER BY i.id FOR SHARE OF i`,[itemIds,owner.patientId,owner.clinicalCaseId])).rows:[];
 if(journeyContentHash(currentLinks)!==journeyContentHash(links)||links.some(l=>!cache.currentPlanIds.has(l.plan_id)))journeyFail(403,'space_strategy_links_unavailable');
 if(problemIds.length){const {rows}=await client.query<{id:number}>("SELECT id FROM patient_problems WHERE id=ANY($1::int[]) AND patient_id=$2 AND case_id=$3 AND specialty='orthodontics' ORDER BY id FOR SHARE",[problemIds,owner.patientId,owner.clinicalCaseId]);if(rows.length!==problemIds.length)journeyFail(403,'space_strategy_problem_unavailable');}
 for(const p of plans)requireSpaceBaseline(assessments,p.baseline,p.arch,authority,{requireLatest:false,exactCurrentSources:false});
 const readableAdjustments=locked.filter(a=>a.visit_id!==null&&cache.currentSessionVisitIds.has(a.visit_id));
 for(const revision of history.revisions){const p=revision.content.authored;
  if(p.kind==='plan'){const b=requireSpaceBaseline(assessments,p.baseline,p.arch,authority,{requireLatest:false,exactCurrentSources:false});
   if(journeyContentHash(revision.content.baseline)!==journeyContentHash({discrepancyMm:b.discrepancyMm,estimated:b.estimated}))journeyFail(500,'space_baseline_proof_mismatch');
  }else{const adjustment=readableAdjustments.find(a=>a.id===p.adjustmentId);if(!adjustment||adjustment.visit_id!==revision.content.adjustment?.visitId)journeyFail(403,'space_session_unavailable');}
 }
 assertJourneyCurrent(authority);
 return {authority,owner,history,assessments,strategies:sources.strategies,adjustments:readableAdjustments};
}
export async function runSpaceCommand(client:DbClient,input:JourneyOwnerInput,command:SpacePersistenceCommand,dryRun=false,historicalOnly=false,readOnly=false){
 if(readOnly&&!dryRun)journeyFail(500,'space_read_only_execution');
 const p=await prepare(client,input,!readOnly,command,historicalOnly);
 const fingerprint=journeyContentHash(command),replay=replayJourney(p.history.rows,p.history.revisions,p.authority,command.clientRequestId,fingerprint);
 if(replay)return {receipt:{ok:true as const,actorId:p.authority.userId,scope:{patientId:p.owner.patientId,orthoCaseId:p.owner.orthoCaseId,clinicalCaseId:p.owner.clinicalCaseId},replayed:true,revision:replay,entryId:replay.id,commandId:command.clientRequestId,requestFingerprint:fingerprint}};
 if(historicalOnly)journeyFail(409,'space_receipt_missing');
 if(command.expectedHeadId!==(p.history.revisions[0]?.id??null))journeyFail(409,'head_changed');
 const authored=command.content;let content:SpaceSavedContent;
 if(authored.kind==='plan'){
  const baseline=requireSpaceBaseline(p.assessments,authored.baseline,authored.arch,p.authority,{requireLatest:true,exactCurrentSources:true});
  if(p.strategies[0]?.id!==authored.strategyRevisionId)journeyFail(409,'space_strategy_changed');
  content={authored,baseline:{discrepancyMm:baseline.discrepancyMm,estimated:baseline.estimated},adjustment:null};
 }else{
  if(p.owner.status==='assessment')journeyFail(409,'ipr_case_not_treatment');
  const a=p.adjustments.find(a=>a.id===authored.adjustmentId);
  if(!a?.visit_id)journeyFail(409,'ipr_session_missing');
  const plan=p.history.revisions.find(r=>r.id===authored.planEntryId);
  if(plan?.content.authored.kind!=='plan'||plan.content.authored.arch!==authored.arch)journeyFail(409,'ipr_plan_missing');
  const latestPlan=p.history.revisions.find(r=>r.content.authored.kind==='plan'&&r.content.authored.arch===authored.arch);
  if(authored.supersedesEntryId===null&&latestPlan?.id!==authored.planEntryId)journeyFail(409,'ipr_plan_changed');
  const snapshot={visitId:a.visit_id,occurredOn:a.done_on,recordedBy:a.recorded_by};
  if(command.schemaVersion!==2)journeyFail(400,'ipr_session_witness_required');
  if(journeyContentHash(command.expectedSession)!==journeyContentHash(snapshot))journeyFail(409,'ipr_session_changed');
  content={authored,baseline:null,adjustment:snapshot};
 }
 // Validate projected semantics before allocating an ID or settling reservation.
 const tentativeId=Math.max(0,...p.history.revisions.map(r=>r.id))+1;
 const projection=projectIpr([...p.history.events,{id:tentativeId,version:p.history.events.length+1,content:authored}]);
 if(!projection.ok)journeyFail(409,projection.code);
 if(authored.kind==='ipr'){
  const plan=p.history.revisions.find(r=>r.id===authored.planEntryId)!.content.authored as SpacePlan;
  const contact=plan.contacts.find(c=>contactKey(c.teeth)===contactKey(authored.teeth))!;
  const total=projection.value.totals.find(t=>t.arch===authored.arch&&t.contact===contactKey(authored.teeth))!;
  if(iprReviewNeeded(contact,total.performedUm).length&&!authored.reviewReason)journeyFail(409,'ipr_review_required');
 }
 if(dryRun)return {receipt:null};
 const revision=await insertSpaceEntry(client,p.owner,p.authority,p.history.revisions[0]??null,command,content);
 assertJourneyCurrent(p.authority);
 return {receipt:{ok:true as const,actorId:p.authority.userId,scope:{patientId:p.owner.patientId,orthoCaseId:p.owner.orthoCaseId,clinicalCaseId:p.owner.clinicalCaseId},replayed:false,revision,entryId:revision.id,commandId:command.clientRequestId,requestFingerprint:fingerprint}};
}
export interface SpacePrintBinding {clinicalCaseId:number;headId:number;headHash:string}
export async function getOrthoSpaceLedger(input:JourneyOwnerInput){return readSpaceLedger(input);}
export async function getOrthoSpaceLedgerForPrint(input:JourneyOwnerInput&SpacePrintBinding){return readSpaceLedger(input,input);}
async function readSpaceLedger(input:JourneyOwnerInput,print?:SpacePrintBinding){return journeyTransaction(false,async client=>{
 await lockSpaceHistoryTables(client);
 const p=await prepare(client,input,false);
 if(print){
  const head=p.history.revisions[0];
  if(!journeyId(print.clinicalCaseId)||!journeyId(print.headId)||!journeyHash(print.headHash)||p.owner.clinicalCaseId!==print.clinicalCaseId||head?.id!==print.headId||head.contentHash!==print.headHash)journeyFail(409,'space_print_head_changed');
  await insertAuditRow(client,{action:'ortho.space_print',entity:'ortho_space_entries',entityId:head.id,actor:p.authority.name,actorRole:p.authority.session.role,details:{patientId:p.owner.patientId,orthoCaseId:p.owner.orthoCaseId,clinicalCaseId:p.owner.clinicalCaseId,headId:head.id,headHash:head.contentHash,event:'prepared_saved_ledger_print'}});
  assertJourneyCurrent(p.authority);
 }
 return {ok:true as const,scope:{patientId:p.owner.patientId,orthoCaseId:p.owner.orthoCaseId,clinicalCaseId:p.owner.clinicalCaseId},actorId:p.authority.userId,
  writable:p.authority.canWrite&&p.authority.canEditPlans,headId:p.history.revisions[0]?.id??null,history:p.history.revisions,ipr:p.history.projection,
  baselines:spaceBaselineChoices(p.assessments,p.authority),strategy:p.strategies[0]??null,
  adjustments:p.adjustments.map(a=>({id:a.id,visitId:a.visit_id!,occurredOn:a.done_on,recordedBy:a.recorded_by}))};
 });}
