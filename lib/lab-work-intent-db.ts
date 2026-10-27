import { createHash } from "node:crypto";
import type { DbClient } from "./db";
import type { SessionPayload } from "./auth";
import { revalidateSessionInTransaction } from "./session";
import { canAccessPatient } from "./patient-access";
import { PENDING_LAB_NAME } from "./lab";
import { validateLabPrescription, type LabPrescriptionInput } from "./lab-prescription-input";
import { normalizeLabWorkGroups, parseLabWorkDraft, type LabWorkCommand, type LabWorkDraft,  type LabWorkMember, type LabWorkSourceRow } from "./lab-work-intent-contract";

type QueryDb = Pick<DbClient,"query">;
export class LabWorkIntentError extends Error {
  readonly status:number;
  constructor(readonly code:string,messageOrStatus:string|number=409,status=409){
    super(typeof messageOrStatus === "string" ? messageOrStatus : "تغيّر ارتباط عمل المختبر؛ حدّث البيانات وراجع المصدر دون إنشاء طلب مكرر.");
    this.status=typeof messageOrStatus === "number" ? messageOrStatus : status;
  }
}
function fail(code:string,status=409):never{throw new LabWorkIntentError(code,status);}
const positive=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>0;
export type MaterializedLabWorkReceipt = Omit<LabWorkReceipt,"orderId"> & {orderId:number};
/** Draft-save memberIds are current active members; materialized receipts identify only touched source members. */
export interface LabWorkReceipt {intentId:string;orderId:number|null;revision:number;memberIds:string[];}
export type LabWorkCommandResult = {outcome:"applied";labWork:LabWorkReceipt[]} | {outcome:"rejected";code:string};
export function assertLabWorkCommandApplied(result:LabWorkCommandResult):asserts result is Extract<LabWorkCommandResult,{outcome:"applied"}>{
  if(result.outcome==="rejected")throw new LabWorkIntentError(result.code,"عملية المختبر مرفوضة نهائيًا؛ استخدم طلبًا جديدًا بعد التصحيح.",409);
}
export interface LabWorkCommandContext {
  patientId:number;sourceKind:"visit"|"invoice";sourceId:number;session:SessionPayload;requestKey:string;requestHash:string;
}
interface IntentRow {id:string;patient_id:number;origin_kind:"visit"|"invoice";origin_visit_id:number|null;origin_invoice_id:number|null;group_kind:"single"|"bridge";revision:number;state:"draft"|"materialized"|"cancelled";prescription:LabPrescriptionInput;initial_order_id:number|null;}
interface MemberRow {id:string;intent_id:string;patient_id:number;service_id:number;source_category:string;tooth_code:number;quantity:number;plan_item_id:number|null;doctor_id:number|null;created_revision:number;retired_revision:number|null;}
export type InvoiceLabSourceRow=LabWorkSourceRow&{invoiceItemId:number};
export type VisitLabSourceRow=LabWorkSourceRow&{procedureId:number};
export type LabWorkRead={labWork:LabWorkDraft;labWorkOrderId:number|null};

/** Read-only and default-off; never installs or repairs schema. */
export async function labWorkIntentSupported(db:QueryDb):Promise<boolean>{
  const {rows}=await db.query<{name:string|null}>("SELECT to_regclass('public.lab_work_intent_schema')::text AS name");
  if(!rows[0]?.name)return false;
  const marker=await db.query<{version:number}>("SELECT version FROM lab_work_intent_schema WHERE singleton=TRUE");
  return marker.rows.length===1&&marker.rows[0].version===1;
}
async function authorize(client:DbClient,session:SessionPayload,patientId:number){
  const active=await revalidateSessionInTransaction(session,client);
  if(!active||!["admin","doctor"].includes(active.role)||!positive(active.userId)
    ||!await canAccessPatient(active,patientId,undefined,client,"nowait"))return fail("unauthorized",403);
  return active;
}
function checkContext(input:LabWorkCommandContext){
  if(!positive(input.patientId)||!positive(input.sourceId)||!/[\s\S]/.test(input.requestHash)
    ||! /^[A-Za-z0-9._:-]{8,128}$/.test(input.requestKey))fail("invalid_command",400);
}
const hash=(raw:string)=>createHash("sha256").update(raw).digest("hex");
/** Caller owns patient/source lock. Same actor/key serialized before stale revision checks. */
export async function readLabWorkCommandInTransaction(client:DbClient,input:LabWorkCommandContext):Promise<LabWorkCommandResult|null>{
  checkContext(input);const active=await authorize(client,input.session,input.patientId);
  const lock=await client.query<{locked:boolean}>("SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked",[`lab-work:${active.userId}`,input.requestKey]);
  if(lock.rows[0]?.locked!==true)fail("command_busy");
  const {rows}=await client.query<{patient_id:number;source_kind:string;source_id:number;request_hash:string;result:{outcome?:string;code?:string;labWork?:LabWorkReceipt[]}}>(
    "SELECT patient_id,source_kind,source_id,request_hash,result FROM lab_work_commands WHERE actor_user_id=$1 AND request_key=$2",[active.userId,input.requestKey]);
  const saved=rows[0];if(!saved)return null;
  if(saved.patient_id!==input.patientId||saved.source_kind!==input.sourceKind||saved.source_id!==input.sourceId||saved.request_hash!==hash(input.requestHash))fail("idempotency_conflict");
  if(saved.result?.outcome==="rejected"){
    if(typeof saved.result.code!=="string"||! /^[a-z][a-z0-9_]{0,95}$/.test(saved.result.code))fail("invalid_receipt");
    return {outcome:"rejected",code:saved.result.code};
  }
  if(!saved.result||![undefined,"applied"].includes(saved.result.outcome)||!Array.isArray(saved.result.labWork))fail("invalid_receipt");
  return {outcome:"applied",labWork:saved.result.labWork};
}
export async function recordVisitLabWorkCommandInTransaction(client:DbClient,input:LabWorkCommandContext,revisions:LabWorkReceipt[]):Promise<void>{
  const active=await authorize(client,input.session,input.patientId);checkContext(input);
  await client.query(`INSERT INTO lab_work_commands(actor_user_id,request_key,patient_id,source_kind,source_id,request_hash,result)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[active.userId,input.requestKey,input.patientId,input.sourceKind,input.sourceId,hash(input.requestHash),JSON.stringify({outcome:"applied",labWork:revisions})]);
}
/** Caller holds patient then source lock; settlement is append-only and cannot replace success. */
export async function recordRejectedLabWorkCommandInTransaction(client:DbClient,input:LabWorkCommandContext,code:string):Promise<LabWorkCommandResult>{
  if(! /^[a-z][a-z0-9_]{0,95}$/.test(code))fail("invalid_rejection_code",400);
  await requireCapability(client);
  const prior=await readLabWorkCommandInTransaction(client,input);if(prior)return prior;
  await validateOrigin(client,input.patientId,input.sourceKind,input.sourceId);
  const result:LabWorkCommandResult={outcome:"rejected",code};
  await client.query(`INSERT INTO lab_work_commands(actor_user_id,request_key,patient_id,source_kind,source_id,request_hash,result)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,[input.session.userId,input.requestKey,input.patientId,input.sourceKind,input.sourceId,hash(input.requestHash),JSON.stringify(result)]);
  return result;
}
async function requireCapability(client:DbClient){if(!await labWorkIntentSupported(client))fail("schema_unavailable",503);}
async function lockIntents(client:DbClient,ids:string[]){
  if(!ids.length)return;
  // Serialize absent UUID creation too, in deterministic order. No patient/source identity is inferred.
  for(const id of [...new Set(ids)].sort()){
    const lock=await client.query<{locked:boolean}>("SELECT pg_try_advisory_xact_lock(hashtext('lab-intent'),hashtext($1)) AS locked",[id]);
    if(lock.rows[0]?.locked!==true)fail("intent_busy");
  }
  await client.query("SELECT id FROM lab_work_intents WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",[ids]);
  await client.query("SELECT id FROM lab_work_members WHERE intent_id=ANY($1::uuid[]) ORDER BY id FOR UPDATE",[ids]);
}
async function getIntent(client:QueryDb,id:string){return (await client.query<IntentRow>("SELECT * FROM lab_work_intents WHERE id=$1",[id])).rows[0]??null;}
async function getMembers(client:QueryDb,id:string){return (await client.query<MemberRow>("SELECT * FROM lab_work_members WHERE intent_id=$1 ORDER BY id",[id])).rows;}
function specification(value:LabPrescriptionInput){return validateLabPrescription(value,false);}
function specKey(value:LabPrescriptionInput){const p=specification(value);return JSON.stringify([p.partyId,p.shade,p.stumpShade,p.toothNumbers,p.dueDate,p.impressionType,p.priority]);}
function sameMember(saved:MemberRow,wanted:LabWorkMember,plannedAlias:boolean){
  return saved.service_id===wanted.serviceId&&saved.source_category===wanted.category&&saved.tooth_code===wanted.toothCode
    &&saved.plan_item_id===wanted.planItemId&&(plannedAlias||(saved.quantity===wanted.quantity&&saved.doctor_id===wanted.doctorId));
}
async function exactPlanAlias(client:QueryDb,planItemId:number|null,intentId:string,memberId:string){
  if(!planItemId)return false;
  return (await client.query("SELECT 1 FROM lab_prescription_source_memberships WHERE plan_item_id=$1 AND intent_id=$2 AND member_id=$3",[planItemId,intentId,memberId])).rows.length===1;
}
async function validateProvider(client:QueryDb,p:LabPrescriptionInput){
  if(p.partyId===null)return {name:PENDING_LAB_NAME,phone:null as string|null};
  const found=(await client.query<{name:string;phone:string|null}>("SELECT name,phone FROM parties WHERE id=$1 AND kind='lab' AND is_active=TRUE FOR SHARE",[p.partyId])).rows[0];
  if(!found)fail("inactive_lab");return found;
}
async function validateOrigin(client:QueryDb,patientId:number,kind:"visit"|"invoice",id:number){
  const table=kind==="visit"?"visits":"invoices";
  const row=(await client.query<{patient_id:number|null}>(`SELECT patient_id FROM ${table} WHERE id=$1`,[id])).rows[0];
  if(row?.patient_id!==patientId)fail("source_patient_mismatch");
}
function receipt(intent:IntentRow,members:MemberRow[]):LabWorkReceipt{return {intentId:intent.id,orderId:intent.initial_order_id,revision:intent.revision,memberIds:members.filter(m=>m.retired_revision===null).map(m=>m.id).sort()};}

async function prepareGroups(client:DbClient,input:LabWorkCommandContext,command:LabWorkCommand){
  const active=await authorize(client,input.session,input.patientId);
  await validateOrigin(client,input.patientId,input.sourceKind,input.sourceId);
  await lockIntents(client,[...command.groups.map(g=>g.intentId),...command.retirements.map(r=>r.intentId)]);
  const results:LabWorkReceipt[]=[];
  const groups=new Map(command.groups.map(g=>[g.intentId,g]));
  const retirements=new Map(command.retirements.map(r=>[r.intentId,r]));
  for(const id of [...new Set([...groups.keys(),...retirements.keys()])].sort()){
    const group=groups.get(id),retirement=retirements.get(id);
    let intent=await getIntent(client,id);const current=intent?await getMembers(client,id):[];
    const expected=group?.expectedRevision??retirement?.expectedRevision;
    if(!intent){
      if(!group||expected!==0||retirement)fail("unknown_intent");
      await validateProvider(client,group.prescription);
      intent=(await client.query<IntentRow>(`INSERT INTO lab_work_intents(id,patient_id,origin_kind,origin_visit_id,origin_invoice_id,group_kind,prescription,created_by_user_id)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *`,[id,input.patientId,input.sourceKind,input.sourceKind==="visit"?input.sourceId:null,input.sourceKind==="invoice"?input.sourceId:null,group.groupKind,JSON.stringify(group.prescription),active.userId])).rows[0];
    }else{
      if(intent.patient_id!==input.patientId||intent.state==="cancelled"||intent.revision!==expected)fail("stale_intent");
      if(group&&intent.group_kind!==group.groupKind)fail("intent_repurposed");
      if(intent.state==="materialized"||intent.initial_order_id!==null){
        if(retirement||!group||specKey(intent.prescription)!==specKey(group.prescription))fail("materialized_immutable");
        for(const member of group.members){
          const saved=current.find(m=>m.id===member.memberId&&m.retired_revision===null);
          const planned=await exactPlanAlias(client,member.planItemId,id,member.memberId);
          if(!saved||!planned||!sameMember(saved,member,true))fail("exact_plan_alias_required");
        }
        results.push({...receipt(intent,current),memberIds:group.members.map(member=>member.memberId).sort()});continue;
      }
      const sameOrigin=input.sourceKind===intent.origin_kind&&(input.sourceKind==="visit"?intent.origin_visit_id:intent.origin_invoice_id)===input.sourceId;
      if(!sameOrigin){
        if(!group||retirement)fail("draft_origin_mismatch");
        for(const member of group.members){
          const saved=current.find(m=>m.id===member.memberId&&m.retired_revision===null);
          if(!saved||!await exactPlanAlias(client,member.planItemId,id,member.memberId)||!sameMember(saved,member,true))fail("draft_origin_mismatch");
        }
      }
      if(group)await validateProvider(client,group.prescription);
      intent=(await client.query<IntentRow>("UPDATE lab_work_intents SET revision=revision+1,prescription=$2::jsonb,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[id,JSON.stringify(group?.prescription??intent.prescription)])).rows[0];
    }
    for(const memberId of retirement?.memberIds??[]){
      const saved=current.find(m=>m.id===memberId&&m.retired_revision===null);
      if(!saved)fail("unknown_retirement");
      await client.query("UPDATE lab_work_members SET retired_revision=$2 WHERE id=$1",[memberId,intent.revision]);
    }
    const wanted=new Set(group?.members.map(m=>m.memberId)??[]),retired=new Set(retirement?.memberIds??[]);
    if(current.some(m=>m.retired_revision===null&&!wanted.has(m.id)&&!retired.has(m.id)))fail("omitted_member");
    for(const member of group?.members??[]){
      const saved=current.find(m=>m.id===member.memberId);
      if(saved){if(saved.retired_revision!==null||!sameMember(saved,member,await exactPlanAlias(client,member.planItemId,id,member.memberId)))fail("member_repurposed");continue;}
      const elsewhere=(await client.query("SELECT id FROM lab_work_members WHERE id=$1",[member.memberId])).rows;
      if(elsewhere.length)fail("member_identity_conflict");
      await client.query(`INSERT INTO lab_work_members(id,intent_id,patient_id,service_id,source_category,tooth_code,quantity,plan_item_id,doctor_id,created_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[member.memberId,id,input.patientId,member.serviceId,member.category,member.toothCode,member.quantity,member.planItemId,member.doctorId,intent.revision]);
    }
    for(const member of group?.members??[])if(member.planItemId)await linkSource(client,{patientId:input.patientId,intentId:id,memberId:member.memberId,kind:"plan",sourceId:member.planItemId,actorId:active.userId!});
    results.push(receipt(intent,await getMembers(client,id)));
  }
  return results;
}
export async function prepareVisitLabWorkInTransaction(client:DbClient,input:Omit<LabWorkCommandContext,"sourceKind"|"sourceId">&{visitId:number;rows:readonly LabWorkSourceRow[];retirements?:unknown}){
  await requireCapability(client);const context={...input,sourceKind:"visit" as const,sourceId:input.visitId};
  const prior=await readLabWorkCommandInTransaction(client,context);
  const command=normalizeLabWorkGroups(input.rows,input.retirements);
  if(prior){assertLabWorkCommandApplied(prior);return {replayed:true,command,revisions:prior.labWork};}
  const current=(await client.query<{intent_id:string;member_id:string}>(`SELECT lab_work_intent_id AS intent_id,lab_work_member_id AS member_id FROM visit_procedures
    WHERE visit_id=$1 AND lab_work_member_id IS NOT NULL
    UNION SELECT m.intent_id,m.id AS member_id FROM lab_work_members m JOIN lab_work_intents i ON i.id=m.intent_id
    WHERE i.origin_visit_id=$1 AND m.retired_revision IS NULL`,[input.visitId])).rows;
  const included=new Set(command.groups.flatMap(g=>g.members.map(m=>m.memberId)));
  const retired=new Set(command.retirements.flatMap(r=>r.memberIds));
  if(current.some(m=>!included.has(m.member_id)&&!retired.has(m.member_id)))fail("stripped_lab_identity");
  const revisions=await prepareGroups(client,context,command);
  return {replayed:false,command,revisions};
}

async function linkSource(client:DbClient,input:{patientId:number;intentId:string;memberId:string;kind:"plan"|"visit"|"invoice";sourceId:number;actorId:number}){
  if(input.kind==="plan"){
    const proof=(await client.query<{patient_id:number;service_id:number|null;tooth_code:number|null;member_service:number;member_tooth:number;member_plan:number|null}>(`SELECT p.patient_id,i.service_id,i.tooth_code,m.service_id AS member_service,m.tooth_code AS member_tooth,m.plan_item_id AS member_plan
      FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id JOIN lab_work_members m ON m.id=$2 AND m.intent_id=$3 WHERE i.id=$1`,[input.sourceId,input.memberId,input.intentId])).rows[0];
    if(!proof||proof.patient_id!==input.patientId||proof.service_id!==proof.member_service||proof.tooth_code!==proof.member_tooth||proof.member_plan!==input.sourceId)fail("plan_source_mismatch");
  }
  const column={plan:"plan_item_id",visit:"visit_procedure_id",invoice:"invoice_item_id"}[input.kind];
  const old=(await client.query<{intent_id:string;member_id:string;patient_id:number}>(`SELECT intent_id,member_id,patient_id FROM lab_prescription_source_memberships WHERE ${column}=$1`,[input.sourceId])).rows[0];
  if(old){if(old.intent_id!==input.intentId||old.member_id!==input.memberId||old.patient_id!==input.patientId)fail("competing_prescription");return;}
  await client.query(`INSERT INTO lab_prescription_source_memberships(intent_id,member_id,patient_id,${column},linked_by_user_id) VALUES($1,$2,$3,$4,$5)`,[input.intentId,input.memberId,input.patientId,input.sourceId,input.actorId]);
}
async function ensureOrder(client:DbClient,intent:IntentRow,actor:SessionPayload,actualDoctors:(number|null)[]){
  if(intent.state==="cancelled")fail("cancelled_intent");
  try{await client.query("LOCK TABLE lab_orders IN ROW EXCLUSIVE MODE NOWAIT");}catch(error){if((error as {code?:string}).code==="55P03")fail("clinical_boundary_busy");throw error;}
  if(intent.initial_order_id!==null){
    const order=(await client.query<{patient_id:number;status:string;lab_work_intent_id:string}>("SELECT patient_id,status,lab_work_intent_id FROM lab_orders WHERE id=$1 FOR UPDATE",[intent.initial_order_id])).rows[0];
    if(!order||order.patient_id!==intent.patient_id||order.lab_work_intent_id!==intent.id)fail("order_identity_mismatch");
    if(order.status==="cancelled")fail("cancelled_order");
    return {orderId:intent.initial_order_id,created:false,intent};
  }
  const members=(await getMembers(client,intent.id)).filter(m=>m.retired_revision===null);
  if(!members.length)fail("empty_intent");
  const doctors=[...new Set(actualDoctors.filter((id):id is number=>id!==null))];
  if(doctors.length>1)fail("ambiguous_source_doctor");
  const p=specification(intent.prescription),lab=await validateProvider(client,p);
  // NOWAIT before touching lab rows avoids reversing the clinical authorization boundary.
  try{await client.query("LOCK TABLE lab_orders IN ROW EXCLUSIVE MODE NOWAIT");}catch(error){if((error as {code?:string}).code==="55P03")fail("clinical_boundary_busy");throw error;}
  const workType=intent.group_kind==="bridge"?"جسر":members[0].source_category==="veneer"?"قشرة (فينير)":"تاج";
  const order=(await client.query<{id:number}>(`INSERT INTO lab_orders(patient_id,lab_name,lab_phone,party_id,work_type,tooth_numbers,shade,stump_shade,priority,impression_type,
      sent_date,due_date,status,visit_id,tooth_code,source,doctor_id,note,lab_work_intent_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_DATE,$11::date,'needed',$12,$13,$14,$15,$16,$17) RETURNING id`,
    [intent.patient_id,lab.name,lab.phone,p.partyId,workType,p.toothNumbers||[...new Set(members.map(member=>member.tooth_code))].sort((a,b)=>a-b).join(", "),p.shade||null,p.stumpShade||null,p.priority,p.impressionType,p.dueDate,
      intent.origin_visit_id,members.length===1?members[0].tooth_code:null,intent.origin_kind==="visit"?"auto":"manual",doctors[0]??null,"مسوّدة إرسالية من هوية عمل صريحة — لم تُرسل للمختبر",intent.id])).rows[0];
  const updated=(await client.query<IntentRow>("UPDATE lab_work_intents SET initial_order_id=$2,state='materialized',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",[intent.id,order.id])).rows[0];
  await client.query("INSERT INTO lab_order_tracking(lab_order_id,action,to_status,notes,actor,actor_role) VALUES($1,'work_intent_materialized','needed',$2,$3,$4)",[order.id,`هوية العمل ${intent.id}`,actor.username,actor.role]);
  return {orderId:order.id,created:true,intent:updated};
}

export async function materializeInvoiceLabWorkInTransaction(client:DbClient,input:{patientId:number;invoiceId:number;visitId?:number|null;session:SessionPayload;requestKey:string;requestHash:string;rows:readonly InvoiceLabSourceRow[];retirements?:unknown}):Promise<MaterializedLabWorkReceipt[]>{
  const hasPayload=input.rows.some(row=>row.labWork!==undefined&&row.labWork!==null)||(Array.isArray(input.retirements)&&input.retirements.length>0);
  const supported=await labWorkIntentSupported(client);
  if(!supported){if(hasPayload)fail("schema_unavailable",503);return [];}
  if(!hasPayload){
    const planIds=input.rows.map(row=>row.planItemId).filter((id):id is number=>id!==null);
    const known=planIds.length?(await client.query("SELECT 1 FROM lab_prescription_source_memberships WHERE plan_item_id=ANY($1::int[]) LIMIT 1",[planIds])).rows.length>0:false;
    if(known)fail("stripped_plan_lab_identity");return [];
  }
  const context={...input,sourceKind:"invoice" as const,sourceId:input.invoiceId};
  const replay=await readLabWorkCommandInTransaction(client,context);if(replay){assertLabWorkCommandApplied(replay);if(replay.labWork.some(r=>r.orderId===null))fail("invalid_receipt");return replay.labWork as MaterializedLabWorkReceipt[];}
  for(const row of input.rows){
    if(!row.planItemId)continue;
    const alias=(await client.query<{intent_id:string;member_id:string}>("SELECT intent_id,member_id FROM lab_prescription_source_memberships WHERE plan_item_id=$1",[row.planItemId])).rows[0];
    const draft=parseLabWorkDraft(row.labWork);
    if(alias&&(!draft||draft.intentId!==alias.intent_id||draft.memberId!==alias.member_id))fail("stripped_plan_lab_identity");
  }
  const command=normalizeLabWorkGroups(input.rows,input.retirements);
  await prepareGroups(client,context,command);const actor=await authorize(client,input.session,input.patientId);
  const results:MaterializedLabWorkReceipt[]=[];
  for(const group of command.groups){
    let intent=(await getIntent(client,group.intentId))!;
    for(const row of input.rows){const draft=parseLabWorkDraft(row.labWork);if(draft?.intentId!==intent.id)continue;
      const saved=(await client.query<{patient_id:number;service_id:number|null;tooth_code:number|null;plan_item_id:number|null;quantity:number;doctor_id:number|null}>(`SELECT i.patient_id,item.service_id,p.tooth_code,item.plan_item_id,item.quantity,item.doctor_id FROM invoice_items item JOIN invoices i ON i.id=item.invoice_id LEFT JOIN plan_items p ON p.id=item.plan_item_id WHERE item.id=$1 AND item.invoice_id=$2`,[row.invoiceItemId,input.invoiceId])).rows[0];
      if(!saved||saved.plan_item_id===null||saved.patient_id!==input.patientId||saved.service_id!==row.serviceId||saved.tooth_code!==row.toothCode||saved.plan_item_id!==row.planItemId||Number(saved.quantity)!==row.quantity||saved.doctor_id!==row.doctorId)fail("invoice_source_mismatch");
      if(row.planItemId)await linkSource(client,{patientId:input.patientId,intentId:intent.id,memberId:draft.memberId,kind:"plan",sourceId:row.planItemId,actorId:actor.userId!});
      await linkSource(client,{patientId:input.patientId,intentId:intent.id,memberId:draft.memberId,kind:"invoice",sourceId:row.invoiceItemId,actorId:actor.userId!});
    }
    const created=await ensureOrder(client,intent,actor,group.members.map(m=>m.doctorId));intent=created.intent;
    results.push({...receipt(intent,await getMembers(client,intent.id)),orderId:created.orderId,memberIds:group.members.map(member=>member.memberId).sort()});
  }
  await recordVisitLabWorkCommandInTransaction(client,context,results);return results;
}

export async function materializeVisitLabWorkInTransaction(client:DbClient,input:{patientId:number;visitId:number;invoiceId:number|null;session:SessionPayload;rows:readonly VisitLabSourceRow[]}){
  await requireCapability(client);const actor=await authorize(client,input.session,input.patientId);
  await validateOrigin(client,input.patientId,"visit",input.visitId);
  const command=normalizeLabWorkGroups(input.rows);await lockIntents(client,command.groups.map(g=>g.intentId));
  const stored=(await client.query<{id:number;lab_work_intent_id:string|null;lab_work_member_id:string|null;service_id:number;tooth_code:number|null;quantity:number;plan_item_id:number|null;doctor_id:number|null}>("SELECT id,lab_work_intent_id,lab_work_member_id,service_id,tooth_code,quantity,plan_item_id,doctor_id FROM visit_procedures WHERE visit_id=$1 ORDER BY id",[input.visitId])).rows;
  const owned=(await client.query<{id:string}>("SELECT m.id FROM lab_work_members m JOIN lab_work_intents i ON i.id=m.intent_id WHERE i.origin_visit_id=$1 AND m.retired_revision IS NULL",[input.visitId])).rows;
  const declared=new Set(command.groups.flatMap(g=>g.members.map(m=>m.memberId)));
  const hasIntent=command.groups.length>0||owned.length>0||stored.some(s=>s.lab_work_member_id!==null);
  if(hasIntent&&input.rows.some(row=>["crown","bridge","veneer"].includes(row.category??"")&&!parseLabWorkDraft(row.labWork)))fail("unkeyed_lab_sign_source");
  if(owned.some(m=>!declared.has(m.id)))fail("stripped_lab_identity");
  const handledProcedureIds:number[]=[];const labWork:LabWorkReceipt[]=[];let createdCount=0;
  for(const row of input.rows){const draft=parseLabWorkDraft(row.labWork);const source=stored.find(s=>Number(s.id)===row.procedureId);
    if(!source||source.lab_work_intent_id!==(draft?.intentId??null)||source.lab_work_member_id!==(draft?.memberId??null))fail("stripped_lab_identity");
    if(!draft&&row.planItemId&&(await client.query("SELECT 1 FROM lab_prescription_source_memberships WHERE plan_item_id=$1",[row.planItemId])).rows.length)fail("stripped_plan_lab_identity");
    if(draft&&(source.service_id!==row.serviceId||source.tooth_code!==row.toothCode||Number(source.quantity)!==row.quantity||source.plan_item_id!==row.planItemId||(source.doctor_id!==null&&source.doctor_id!==row.doctorId)))fail("sign_source_mismatch");}
  if(stored.some(s=>s.lab_work_member_id&&!input.rows.some(r=>r.procedureId===Number(s.id))))fail("omitted_sign_source");
  for(const group of command.groups){
    let intent=await getIntent(client,group.intentId);if(!intent||intent.patient_id!==input.patientId||intent.state==="cancelled"||intent.revision!==group.expectedRevision||specKey(intent.prescription)!==specKey(group.prescription))fail("invalid_sign_intent");
    const members=await getMembers(client,intent.id);
    const sourceRows=input.rows.filter(r=>parseLabWorkDraft(r.labWork)?.intentId===intent!.id);
    for(const row of sourceRows){const draft=parseLabWorkDraft(row.labWork)!;const member=members.find(m=>m.id===draft.memberId&&m.retired_revision===null);
      const planned=await exactPlanAlias(client,row.planItemId,intent.id,draft.memberId);
      if(intent.origin_visit_id!==input.visitId&&!planned)fail("explicit_execution_link_required");
      if(!member||member.service_id!==row.serviceId||member.tooth_code!==row.toothCode||member.source_category!==row.category
        ||member.plan_item_id!==row.planItemId||(!planned&&(member.quantity!==row.quantity||(member.doctor_id!==null&&member.doctor_id!==row.doctorId))))fail("sign_member_mismatch");
      const exactLines=input.invoiceId===null?[]:(await client.query<{id:number}>(`SELECT id FROM invoice_items WHERE invoice_id=$1 AND
        ((source_type='visit_procedure' AND source_id=$2) OR ($3::int IS NOT NULL AND (plan_item_id=$3 OR (source_type='plan_item' AND source_id=$3))))`,[input.invoiceId,row.procedureId,row.planItemId])).rows;
      const earlierInvoice=(await client.query("SELECT 1 FROM lab_prescription_source_memberships WHERE intent_id=$1 AND member_id=$2 AND invoice_item_id IS NOT NULL",[intent.id,draft.memberId])).rows.length>0;
      if(input.invoiceId!==null&&!exactLines.length&&!earlierInvoice)fail("ambiguous_attached_invoice");
      if(row.planItemId)await linkSource(client,{patientId:input.patientId,intentId:intent.id,memberId:draft.memberId,kind:"plan",sourceId:row.planItemId,actorId:actor.userId!});
      await linkSource(client,{patientId:input.patientId,intentId:intent.id,memberId:draft.memberId,kind:"visit",sourceId:row.procedureId,actorId:actor.userId!});
      for(const line of exactLines)await linkSource(client,{patientId:input.patientId,intentId:intent.id,memberId:draft.memberId,kind:"invoice",sourceId:line.id,actorId:actor.userId!});
      handledProcedureIds.push(row.procedureId);
    }
    const order=await ensureOrder(client,intent,actor,sourceRows.map(r=>r.doctorId));intent=order.intent;if(order.created)createdCount++;
    labWork.push({...receipt(intent,await getMembers(client,intent.id)),memberIds:sourceRows.map(row=>parseLabWorkDraft(row.labWork)!.memberId).sort()});
  }
  return {handledProcedureIds,createdCount,labWork};
}

function readDraft(intent:IntentRow,member:MemberRow):LabWorkRead{return {labWork:{intentId:intent.id,memberId:member.id,expectedRevision:intent.revision,groupKind:intent.group_kind,prescription:specification(intent.prescription)},labWorkOrderId:intent.initial_order_id};}
export async function readLabWorkForPlanItems(db:QueryDb,patientId:number,planItemIds:readonly number[]):Promise<Map<number,LabWorkRead>>{
  const result=new Map<number,LabWorkRead>();if(!planItemIds.length||!await labWorkIntentSupported(db))return result;
  const links=(await db.query<{plan_item_id:number;intent_id:string;member_id:string}>("SELECT plan_item_id,intent_id,member_id FROM lab_prescription_source_memberships WHERE patient_id=$1 AND plan_item_id=ANY($2::int[])",[patientId,planItemIds])).rows;
  for(const link of links){const intent=await getIntent(db,link.intent_id),member=(await getMembers(db,link.intent_id)).find(m=>m.id===link.member_id);
    if(intent?.patient_id===patientId&&member&&member.retired_revision===null)result.set(link.plan_item_id,readDraft(intent,member));}
  return result;
}
export async function readLabWorkForVisitProcedures(db:QueryDb,patientId:number,visitId:number):Promise<Map<number,LabWorkRead>>{
  const result=new Map<number,LabWorkRead>();if(!await labWorkIntentSupported(db))return result;
  const links=(await db.query<{id:number;lab_work_intent_id:string;lab_work_member_id:string}>(`SELECT p.id,p.lab_work_intent_id,p.lab_work_member_id FROM visit_procedures p JOIN visits v ON v.id=p.visit_id
    WHERE p.visit_id=$1 AND v.patient_id=$2 AND p.lab_work_member_id IS NOT NULL`,[visitId,patientId])).rows;
  for(const link of links){const intent=await getIntent(db,link.lab_work_intent_id),member=(await getMembers(db,link.lab_work_intent_id)).find(m=>m.id===link.lab_work_member_id);
    if(intent?.patient_id===patientId&&member&&member.retired_revision===null)result.set(Number(link.id),readDraft(intent,member));}
  return result;
}
