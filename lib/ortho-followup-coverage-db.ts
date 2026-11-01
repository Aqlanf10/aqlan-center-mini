import { caseSiteFits, validateLineSite } from "./invoice-clinical-linkage";
import { createHash } from "node:crypto";
import type { SessionPayload } from "./auth";
import { ensureSchema, getPool, insertAuditRow, PLAN_ITEM_PREBILLED_SQL, PLAN_ITEM_FINANCIAL_REVIEW_SQL,
  PLAN_ITEM_LEGACY_LINEAGE_SQL, usesSharedLocalDatabaseConnection, type DbClient } from "./db";
import { revalidateSessionInTransaction } from "./session";
import { canAccessPatient } from "./patient-access";
import { withFinancialReadSnapshot } from "./financial-read-snapshot";
import { parseFollowupCoverageCommand, type FollowupCoverageRead, type FollowupCoverageRevision, type FollowupCoverageCommand,
  type FollowupSourceChoice, type FollowupSourceIdentity } from "./ortho-followup-coverage";

type Runner = Pick<DbClient, "query">;
type SourceRow = FollowupSourceIdentity & { invoiceNumber:string;serviceName:string; snapshot:Record<string,unknown>; valid:boolean; arches:string;clinicalSite:string|null;toothCode:number|null };
type Stored = { id:string;version:number;supersedes_revision_id:string|null;patient_id:number;ortho_case_id:number;clinical_case_id:number;
  plan_id:number;plan_item_id:number;invoice_id:number;source_fingerprint:string;decision:"included"|"excluded";
  reason:string;created_at:Date|string;created_by:string;command_id:string;request_fingerprint:string };
export interface FollowupCoverageRejection {
  commandId:string;patientId:number;orthoCaseId:number;actorUserId:number;actor:string;terminal:true;requestFingerprint:string;
  code:"source_changed"|"stale_coverage"|"case_closed";message:string;rejectedAt:string;command:FollowupCoverageCommand;
}
type StoredRejection={command_id:string;patient_id:number;ortho_case_id:number;actor_user_id:number;request_fingerprint:string;
  actor:string;code:FollowupCoverageRejection["code"];message:string;rejected_at:Date|string;command:FollowupCoverageCommand};
const projectRejection=(r:StoredRejection):FollowupCoverageRejection=>({commandId:r.command_id,patientId:r.patient_id,orthoCaseId:r.ortho_case_id,
  actorUserId:r.actor_user_id,actor:r.actor,terminal:true,requestFingerprint:r.request_fingerprint,code:r.code,message:r.message,rejectedAt:new Date(r.rejected_at).toISOString(),command:r.command});
export class FollowupCoverageError extends Error {
  constructor(readonly status:number, readonly code:string, message:string, readonly rejection?:FollowupCoverageRejection) { super(message); }
}
function fail(status:number,code:string,message:string):never {throw new FollowupCoverageError(status,code,message);}
const hash=(v:unknown)=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const positive=(id:number)=>Number.isSafeInteger(id)&&id>0;
const sourceOf=(r:Stored):FollowupSourceIdentity=>({patientId:r.patient_id,orthoCaseId:r.ortho_case_id,clinicalCaseId:r.clinical_case_id,planId:r.plan_id,planItemId:r.plan_item_id,invoiceId:r.invoice_id});
const project=(r:Stored):FollowupCoverageRevision=>({id:String(r.id),version:r.version,supersedesRevisionId:r.supersedes_revision_id===null?null:String(r.supersedes_revision_id),source:sourceOf(r),sourceFingerprint:r.source_fingerprint,decision:r.decision,reason:r.reason,createdAt:new Date(r.created_at).toISOString(),createdBy:r.created_by,commandId:r.command_id});
const columns="id::text,version,supersedes_revision_id::text,patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,source_fingerprint,decision,reason,created_at,created_by,command_id::text,request_fingerprint";
/** No implicit DDL, cached activation or synthetic legacy-plan fallback. */
export async function followupCoverageAvailable(db:Runner):Promise<boolean>{
  const {rows:[r]}=await db.query<{present:boolean}>(`SELECT to_regclass('public.ortho_followup_coverage_revisions') IS NOT NULL
    AND to_regclass('public.ortho_followup_coverage_rejections') IS NOT NULL
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='ortho_adjustments' AND column_name='followup_coverage_revision_id')
    AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='visits' AND column_name='ortho_followup_coverage_proof')
    AND (SELECT count(*)=7 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='O'
      AND tgname IN ('ortho_followup_visit_manifest','ortho_followup_adjustment_proof','ortho_followup_manifest_children','ortho_followup_proof_parent','ortho_followup_coverage_00_command','ortho_followup_rejection_immutable','ortho_followup_rejection_no_truncate')) AS present`);
  return r?.present===true;
}
/** Stable commercial/source identity; payment progress and treatment progress do
 * not change inclusion. Foreign, cancelled, conflicting and unverified lineage do. */
// Preserve call-time expansion: importing report readers must not eagerly touch
// coverage-specific DB exports. The original helper evaluated these at invocation.
function followupSourceSql(){return `SELECT c.patient_id AS "patientId",c.id AS "orthoCaseId",cc.id AS "clinicalCaseId",
    t.id AS "planId",i.id AS "planItemId",inv.id AS "invoiceId",inv.invoice_number AS "invoiceNumber",i.service_name AS "serviceName",c.arches,cc.site AS "clinicalSite",i.tooth_code AS "toothCode",
    (t.status <> 'cancelled' AND i.status <> 'cancelled' AND inv.status <> 'cancelled'
      AND ${PLAN_ITEM_PREBILLED_SQL} AND NOT ${PLAN_ITEM_FINANCIAL_REVIEW_SQL} AND NOT ${PLAN_ITEM_LEGACY_LINEAGE_SQL}
      AND NOT EXISTS(SELECT 1 FROM invoice_items conflict WHERE conflict.plan_item_id=i.id AND conflict.source_type='plan_item' AND conflict.source_id IS DISTINCT FROM i.id)
      AND NOT EXISTS(SELECT 1 FROM invoice_items duplicate JOIN invoices duplicate_invoice ON duplicate_invoice.id=duplicate.invoice_id
        WHERE duplicate.plan_item_id=i.id AND duplicate.invoice_id<>inv.id AND duplicate_invoice.status<>'cancelled')) AS valid,
    jsonb_build_object('format',1,'case',jsonb_build_array(c.id,c.patient_id,c.arches,c.appliance),
      'clinical',jsonb_build_array(cc.id,cc.patient_id,cc.ortho_case_id,cc.specialty,cc.site),
      'plan',jsonb_build_array(t.id,t.patient_id,t.base_currency),
      'item',jsonb_build_array(i.id,i.plan_id,i.case_id,i.service_id,i.category,i.tooth_code,i.surfaces,i.quantity,i.unit_price_minor::text,i.doctor_id,i.billing_rule,i.session_count,i.origin,i.origin_invoice_id,i.billed_invoice_id),
      'invoice',jsonb_build_array(inv.id,inv.patient_id,inv.invoice_number,inv.base_currency,inv.total_minor::text,inv.discount_minor::text),
      'originInvoice',(SELECT jsonb_build_array(oi.id,oi.patient_id,(oi.status='cancelled'),oi.base_currency,oi.total_minor::text,oi.discount_minor::text,
        (SELECT jsonb_agg(jsonb_build_array(ol.id,ol.service_id,ol.quantity,ol.unit_price_minor::text,ol.total_minor::text,ol.doctor_id,ol.source_type,ol.source_id,ol.plan_item_id) ORDER BY ol.id) FROM invoice_items ol WHERE ol.invoice_id=oi.id)) FROM invoices oi WHERE oi.id=i.origin_invoice_id),
      'lines',COALESCE((SELECT jsonb_agg(jsonb_build_array(ii.id,ii.service_id,ii.quantity,ii.unit_price_minor::text,ii.total_minor::text,ii.doctor_id,ii.source_type,ii.source_id,ii.plan_item_id) ORDER BY ii.id) FROM invoice_items ii WHERE ii.invoice_id=inv.id),'[]'::jsonb),
      'corrections',COALESCE((SELECT jsonb_agg(jsonb_build_array(ic.id,ic.original_invoice_id,ic.corrected_invoice_id,ic.created_at) ORDER BY ic.id) FROM invoice_corrections ic WHERE ic.original_invoice_id=inv.id OR ic.corrected_invoice_id=inv.id),'[]'::jsonb)) AS snapshot
    FROM ortho_cases c JOIN clinical_cases cc ON cc.ortho_case_id=c.id AND cc.patient_id=c.patient_id AND cc.specialty='orthodontics'
    JOIN plan_items i ON i.case_id=cc.id AND i.category='ortho'
    JOIN treatment_plans t ON t.id=i.plan_id AND t.patient_id=c.patient_id
    JOIN invoices inv ON inv.id=i.billed_invoice_id AND inv.patient_id=c.patient_id
    WHERE c.id=$1 AND c.patient_id=$2 ORDER BY i.id,inv.id`;}
async function sourceRows(db:Runner,patientId:number,caseId:number):Promise<SourceRow[]>{
  const {rows}=await db.query<SourceRow>(followupSourceSql(),[caseId,patientId]);
  return validateSources(rows);
}
function validateSources(rows:SourceRow[]):SourceRow[]{
  return rows.map(r=>{
    const site=validateLineSite({category:"ortho",toothCode:r.toothCode,scope:r.arches});
    return {...r,valid:r.valid&&site.ok&&caseSiteFits("orthodontics",r.clinicalSite,site.site)};
  });
}
const matches=(r:FollowupSourceIdentity,s:FollowupSourceIdentity)=>r.patientId===s.patientId&&r.orthoCaseId===s.orthoCaseId&&r.clinicalCaseId===s.clinicalCaseId&&r.planId===s.planId&&r.planItemId===s.planItemId&&r.invoiceId===s.invoiceId;
const choice=(r:SourceRow):FollowupSourceChoice=>({patientId:r.patientId,orthoCaseId:r.orthoCaseId,clinicalCaseId:r.clinicalCaseId,planId:r.planId,planItemId:r.planItemId,invoiceId:r.invoiceId,invoiceNumber:r.invoiceNumber,serviceName:r.serviceName,fingerprint:hash(r.snapshot)});
async function currentHead(db:Runner,caseId:number):Promise<Stored|null>{
  return (await db.query<Stored>(`SELECT ${columns} FROM ortho_followup_coverage_revisions WHERE ortho_case_id=$1 ORDER BY version DESC LIMIT 1`,[caseId])).rows[0]??null;
}
async function authorizeCurrentCase(client:DbClient,session:SessionPayload,caseId:number){
  const active=await revalidateSessionInTransaction(session,client);
  if(!active||active.role!=="admin"||!positive(active.userId??0))
    fail(403,"coverage_forbidden","تغيّرت الجلسة أو لا تملك صلاحية اعتماد نطاق تغطية الاتفاق.");
  const current=(await client.query<{patient_id:number}>("SELECT patient_id FROM ortho_cases WHERE id=$1",[caseId])).rows[0];
  if(!current)fail(404,"case_missing","حالة التقويم غير موجودة.");
  if(!await canAccessPatient(active,current.patient_id,undefined,client,"nowait"))
    fail(403,"coverage_forbidden","لا تملك صلاحية ملف المالك الحالي للحالة.");
  return {actor:active,currentPatientId:current.patient_id};
}
async function owner(client:DbClient,patientId:number,caseId:number,write:boolean){
  await client.query(`SELECT id FROM patients WHERE id=$1 FOR ${write?"NO KEY UPDATE":"SHARE"} NOWAIT`,[patientId]);
  const {rows:[r]}=await client.query<{status:string}>(`SELECT status FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR ${write?"UPDATE":"SHARE"} NOWAIT`,[caseId,patientId]);
  if(!r)fail(404,"case_missing","حالة التقويم غير موجودة ضمن هذا المريض.");
  return r.status;
}
/** Locks for both the decision writer and the sign-time proof reader. Patient
 * is first; NOWAIT refuses inverted legacy source writers rather than deadlocks. */
async function lockSource(client:DbClient,s:FollowupSourceIdentity,strictOwnership=false){
  const clinical=await client.query("SELECT id FROM clinical_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT",[s.clinicalCaseId,s.patientId]);
  if(strictOwnership&&!clinical.rows.length)return false;
  const plan=await client.query("SELECT id FROM treatment_plans WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT",[s.planId,s.patientId]);
  if(strictOwnership&&!plan.rows.length)return false;
  const item=await client.query(strictOwnership
    ? "SELECT id FROM plan_items WHERE id=$1 AND plan_id=$2 AND case_id=$3 FOR SHARE NOWAIT"
    : "SELECT id FROM plan_items WHERE id=$1 AND plan_id=$2 FOR SHARE NOWAIT",strictOwnership?[s.planItemId,s.planId,s.clinicalCaseId]:[s.planItemId,s.planId]);
  if(strictOwnership&&!item.rows.length)return false;
  await client.query("SELECT p.id FROM parties p JOIN plan_items i ON i.doctor_id=p.id WHERE i.id=$1 FOR SHARE OF p NOWAIT",[s.planItemId]);
  const invoiceIds=(await client.query<{id:number}>("SELECT id FROM invoices WHERE patient_id=$2 AND (id=$1 OR id=(SELECT origin_invoice_id FROM plan_items WHERE id=$3)) ORDER BY id FOR SHARE NOWAIT",[s.invoiceId,s.patientId,s.planItemId])).rows.map(r=>r.id);
  await client.query("SELECT id FROM invoice_items WHERE invoice_id=ANY($1::int[]) ORDER BY id FOR SHARE NOWAIT",[invoiceIds]);
  await client.query("SELECT id FROM invoice_corrections WHERE original_invoice_id=ANY($1::int[]) OR corrected_invoice_id=ANY($1::int[]) ORDER BY id FOR SHARE NOWAIT",[invoiceIds]);
  return true;
}
export async function readFollowupCoverage(input:{session:SessionPayload;patientId:number;orthoCaseId:number}):Promise<FollowupCoverageRead>{
  if(!positive(input.patientId)||!positive(input.orthoCaseId))fail(400,"invalid_scope","معرف الحالة غير صالح.");
  await ensureSchema();
  return withFinancialReadSnapshot(getPool(),async db=>{
    // Admin-only source editor on the deployed compatibility model. Read-only
    // snapshots cannot acquire row locks; route has authenticated this payload.
    if(input.session.role!=="admin"||!await canAccessPatient(input.session,input.patientId))fail(403,"coverage_forbidden","اعتماد نطاق الاتفاق للإدارة فقط.");
    const found=(await db.query<{id:number;status:string}>("SELECT id,status FROM ortho_cases WHERE id=$1 AND patient_id=$2",[input.orthoCaseId,input.patientId])).rows;
    if(!found.length)fail(404,"case_missing","الحالة غير موجودة.");
    const enabled=await followupCoverageAvailable(db);
    const head=enabled?await currentHead(db,input.orthoCaseId):null;
    const sources=await sourceRows(db,input.patientId,input.orthoCaseId);
    return {patientId:input.patientId,orthoCaseId:input.orthoCaseId,enabled,canEdit:enabled&&["active","retention"].includes(found[0].status),current:head?project(head):null,
      applicable:!!head&&sources.some(r=>r.valid&&matches(r,sourceOf(head))&&hash(r.snapshot)===head.source_fingerprint),
      sources:sources.filter(r=>r.valid).map(choice)};
  },usesSharedLocalDatabaseConnection());
}
async function boundedCurrentHead(db:Runner,patientId:number,caseId:number){
  const {rows:[stored]}=await db.query<{oversized:boolean;head:Stored|null}>(`WITH head AS (
    SELECT ${columns} FROM ortho_followup_coverage_revisions WHERE ortho_case_id=$1 ORDER BY version DESC LIMIT 1
  ) SELECT octet_length(to_jsonb(head)::text)>16384 AS oversized,
    CASE WHEN octet_length(to_jsonb(head)::text)<=16384 THEN to_jsonb(head) ELSE NULL END AS head FROM head`,[caseId]);
  if(stored?.oversized)throw new Error("STAFF_READ_READ_FAILED");
  const head=stored?.head??null;
  if(head&&(head.patient_id!==patientId||head.ortho_case_id!==caseId||!Number.isSafeInteger(head.version)||head.version<1
    ||!["included","excluded"].includes(head.decision)||typeof head.reason!=="string"||head.reason.length>600
    ||typeof head.created_by!=="string"||head.created_by.length>1000||!Number.isFinite(new Date(head.created_at).getTime())))
    throw new Error("STAFF_READ_READ_FAILED");
  return head;
}
async function boundedSourceRows(db:Runner,patientId:number,caseId:number){
  // SQL refuses the whole result before sending a large JSON value to Node. It
  // never truncates candidates and falsely concludes a saved decision is stale.
  const {rows:[bounded]}=await db.query<{oversized:boolean;sources:SourceRow[]|null}>(`WITH candidates AS MATERIALIZED (
    ${followupSourceSql()} LIMIT 257
  ), sized AS (SELECT *,octet_length(to_jsonb(candidates)::text) AS bytes FROM candidates)
  SELECT count(*)>256 OR COALESCE(sum(bytes),0)>2097152 AS oversized,
    CASE WHEN count(*)<=256 AND COALESCE(sum(bytes),0)<=2097152
      THEN COALESCE(jsonb_agg(to_jsonb(sized)-'bytes' ORDER BY "planItemId","invoiceId"),'[]'::jsonb) ELSE NULL END AS sources FROM sized`,[caseId,patientId]);
  if(!bounded||bounded.oversized||!Array.isArray(bounded.sources))throw new Error("STAFF_READ_READ_FAILED");
  const sources=validateSources(bounded.sources);
  return sources;
}
/** Already admitted caller only: bounded source materialization on its owning RR
 * connection. Shares the exact commercial SQL, site validation and fingerprint
 * with the compatibility writer; no initializer, transaction or authority fallback. */
export async function readFollowupCoverageSnapshotWith(db:Runner,patientId:number,caseId:number){
  const enabled=await followupCoverageAvailable(db);
  if(!enabled)return {enabled,current:null,applicable:false,sources:[] as FollowupSourceChoice[]};
  const head=await boundedCurrentHead(db,patientId,caseId);
  const sources=await boundedSourceRows(db,patientId,caseId);
  return {enabled,current:head?project(head):null,
    applicable:!!head&&sources.some(r=>r.valid&&matches(r,sourceOf(head))&&hash(r.snapshot)===head.source_fingerprint),
    sources:sources.filter(r=>r.valid).map(choice)};
}
type CoverageCommandInput={session:SessionPayload;patientId:number;orthoCaseId:number;command:unknown};
function exactCommand(input:CoverageCommandInput){
  const command=parseFollowupCoverageCommand(input.command);
  if(!command||command.source.patientId!==input.patientId||command.source.orthoCaseId!==input.orthoCaseId)
    fail(400,"invalid_command","طلب نطاق التغطية غير صالح.");
  return command;
}
async function terminalReceipt(client:Runner,command:FollowupCoverageCommand,fingerprint:string,bounded=false){
  const read = async <T>(sql:string):Promise<T|undefined> => {
    if(!bounded)return (await client.query<T>(sql,[command.commandId])).rows[0];
    const {rows:[row]}=await client.query<{oversized:boolean;receipt:T|null}>(`WITH candidate AS (${sql})
      SELECT octet_length(to_jsonb(candidate)::text)>16384 AS oversized,
        CASE WHEN octet_length(to_jsonb(candidate)::text)<=16384 THEN to_jsonb(candidate) ELSE NULL END AS receipt FROM candidate`,[command.commandId]);
    if(row?.oversized)fail(409,"coverage_receipt_invalid","تعذّر التحقق من إيصال الطلب؛ يبقى معلّقًا.");
    return row?.receipt??undefined;
  };
  const saved=await read<Stored>(`SELECT ${columns} FROM ortho_followup_coverage_revisions WHERE command_id=$1`);
  const rejected=await read<StoredRejection>("SELECT command_id,patient_id,ortho_case_id,actor_user_id,request_fingerprint,actor,code,message,rejected_at,command FROM ortho_followup_coverage_rejections WHERE command_id=$1");
  if(saved&&rejected)fail(409,"terminal_conflict","تعارض سجل الطلب؛ لا تُنشئ طلبًا بديلًا.");
  if((saved&&saved.request_fingerprint!==fingerprint)||(rejected&&rejected.request_fingerprint!==fingerprint))
    fail(409,"command_conflict","رقم الطلب مستخدم لقرار مختلف؛ راجع السجل.");
  return saved?{state:"committed" as const,revision:project(saved)}:rejected?{state:"rejected" as const,rejection:projectRejection(rejected)}:{state:"unresolved" as const};
}
/** Trusted already-admitted caller on its owning transaction, after command and
 * patient/case locks. Shares the immutable receipt and exact actor-bound request
 * fingerprint; no initializer, authority fallback, mutation or transaction control. */
export async function readFollowupCoverageReceiptWith(client:Runner,input:{patientId:number;orthoCaseId:number;actorUserId:number;command:FollowupCoverageCommand}){
  const fingerprint=hash({patientId:input.patientId,orthoCaseId:input.orthoCaseId,actorUserId:input.actorUserId,command:input.command});
  return terminalReceipt(client,input.command,fingerprint,true);
}
/** Read exact durable outcome; missing receipt is unresolved, never a rejection. */
export async function readFollowupCoverageCommandStatus(input:CoverageCommandInput){
  const command=exactCommand(input);await ensureSchema();const client=await getPool().connect();let destroy=false;
  try{
    await client.query("BEGIN");
    const {actor,currentPatientId}=await authorizeCurrentCase(client,input.session,input.orthoCaseId);
    if(!await followupCoverageAvailable(client))fail(503,"coverage_not_ready","سجل نطاق المتابعات غير جاهز للتحقق.");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["ortho-followup-command:"+command.commandId]);
    await owner(client,currentPatientId,input.orthoCaseId,false);
    const fingerprint=hash({patientId:input.patientId,orthoCaseId:input.orthoCaseId,actorUserId:actor.userId,command});
    const result=await terminalReceipt(client,command,fingerprint);
    await client.query("COMMIT");return result;
  }catch(error){try{await client.query("ROLLBACK");}catch{destroy=true;}throw error;}finally{client.release(destroy);}
}
export type FollowupCoverageAppendOutcome =
  | {state:"committed";ok:true;replayed:boolean;revision:FollowupCoverageRevision}
  | {state:"rejected";rejection:FollowupCoverageRejection};
/** Caller-owned transaction. The native decision/source SQL, request identity and
 * durable rejection are shared. A rejection is returned so the owner can commit
 * its audit and receipt before translating it to HTTP; errors still roll back. */
export async function appendFollowupCoverageWith(client:DbClient,input:{patientId:number;orthoCaseId:number},
  command:FollowupCoverageCommand,actor:{userId:number;username:string;role:string},currentPatientId:number,
  hooks?:{bounded:true;assertCurrent:()=>Promise<void>}):Promise<FollowupCoverageAppendOutcome>{
    if(!await followupCoverageAvailable(client))fail(503,"coverage_not_ready","تسجيل نطاق المتابعات لم يُفعّل بعد؛ لا تغيّر الاتفاق أو تنشئ فاتورة بديلة.");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["ortho-followup-command:"+command.commandId]);
    await hooks?.assertCurrent();
    const caseStatus=await owner(client,currentPatientId,input.orthoCaseId,true);
    await hooks?.assertCurrent();
    const requestFingerprint=hash({patientId:input.patientId,orthoCaseId:input.orthoCaseId,actorUserId:actor.userId,command});
    const replay=await terminalReceipt(client,command,requestFingerprint,hooks?.bounded===true);
    if(replay.state!=="unresolved"){
      await hooks?.assertCurrent();
      if(replay.state==="rejected")return replay;
      return {state:"committed",ok:true,replayed:true,revision:replay.revision};
    }
    const reject=async(code:FollowupCoverageRejection["code"],message:string):Promise<FollowupCoverageAppendOutcome>=>{
      const row=(await client.query<StoredRejection>(`INSERT INTO ortho_followup_coverage_rejections
        (command_id,request_fingerprint,patient_id,ortho_case_id,actor_user_id,command,code,message,actor)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING *`,
        [command.commandId,requestFingerprint,input.patientId,input.orthoCaseId,actor.userId,JSON.stringify(command),code,message,actor.username])).rows[0];
      await insertAuditRow(client,{action:"ortho.followup_coverage.append",entity:"ortho_case",entityId:input.orthoCaseId,
        actor:actor.username,actorRole:actor.role,details:{outcome:"rejected",commandId:command.commandId,patientId:input.patientId,code,requestFingerprint}});
      await hooks?.assertCurrent();
      return {state:"rejected",rejection:projectRejection(row)};
    };
    if(currentPatientId!==input.patientId)return reject("source_changed","تغيّر مالك الحالة؛ راجع الربط قبل اعتماد قرار جديد.");
    if(!["active","retention"].includes(caseStatus))return reject("case_closed","الحالة مغلقة؛ لا يتغير نطاق المتابعات الجديدة لها.");
    const head=hooks?.bounded ? await boundedCurrentHead(client,input.patientId,input.orthoCaseId) : await currentHead(client,input.orthoCaseId);
    if((head?String(head.id):null)!==command.expectedRevisionId)return reject("stale_coverage","تغيّر نطاق المتابعات منذ فتح الشاشة؛ أعد التحميل وراجع القرار.");
    if(hooks?.bounded){
      // A supplied foreign item/plan must not acquire locks outside the admitted
      // patient. Recheck the same native fingerprint again after source locks.
      const observed=(await boundedSourceRows(client,input.patientId,input.orthoCaseId)).find(r=>matches(r,command.source));
      if(!observed?.valid||hash(observed.snapshot)!==command.expectedSourceFingerprint)return reject("source_changed","تغيّر مصدر الاتفاق أو لم تعد هويته مثبتة؛ راجع الفاتورة والربط قبل الاعتماد.");
    }
    if(!await lockSource(client,command.source,hooks?.bounded===true))return reject("source_changed","تغيّر مصدر الاتفاق أو لم تعد هويته مثبتة؛ راجع الفاتورة والربط قبل الاعتماد.");
    const source=(await (hooks?.bounded ? boundedSourceRows(client,input.patientId,input.orthoCaseId) : sourceRows(client,input.patientId,input.orthoCaseId))).find(r=>matches(r,command.source));
    if(!source?.valid||hash(source.snapshot)!==command.expectedSourceFingerprint)return reject("source_changed","تغيّر مصدر الاتفاق أو لم تعد هويته مثبتة؛ راجع الفاتورة والربط قبل الاعتماد.");
    if(!source)throw new Error("Coverage source missing after validation");
    const {rows:[saved]}=await client.query<Stored>(`INSERT INTO ortho_followup_coverage_revisions
      (patient_id,ortho_case_id,clinical_case_id,plan_id,plan_item_id,invoice_id,version,supersedes_revision_id,scope,decision,source_fingerprint,source_snapshot,reason,actor_user_id,created_by,command_id,request_fingerprint)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'routine_adjustments',$9,$10,$11::jsonb,$12,$13,$14,$15,$16) RETURNING ${columns}`,
      [input.patientId,input.orthoCaseId,source.clinicalCaseId,source.planId,source.planItemId,source.invoiceId,(head?.version??0)+1,head?.id??null,command.decision,command.expectedSourceFingerprint,JSON.stringify(source.snapshot),command.reason,actor.userId,actor.username,command.commandId,requestFingerprint]);
    await insertAuditRow(client,{action:"ortho.followup_coverage.append",entity:"ortho_case",entityId:input.orthoCaseId,actor:actor.username,actorRole:actor.role,
      details:{before:head?project(head):null,after:project(saved),scope:"routine_adjustments",reason:command.reason}});
    await hooks?.assertCurrent();
    return {state:"committed",ok:true,replayed:false,revision:project(saved)};
}
export async function appendFollowupCoverage(input:CoverageCommandInput){
  const command=exactCommand(input);
  await ensureSchema();const client=await getPool().connect();let destroy=false;
  try{
    await client.query("BEGIN");
    const {actor,currentPatientId}=await authorizeCurrentCase(client,input.session,input.orthoCaseId);
    const outcome=await appendFollowupCoverageWith(client,input,command,{userId:actor.userId!,username:actor.username,role:actor.role},currentPatientId);
    await client.query("COMMIT");
    if(outcome.state==="rejected")throw new FollowupCoverageError(409,outcome.rejection.code,outcome.rejection.message,outcome.rejection);
    return {ok:true as const,replayed:outcome.replayed,revision:outcome.revision};
  }catch(error){try{await client.query("ROLLBACK");}catch{destroy=true;}throw error;}finally{client.release(destroy);}
}
/** Current explicit head only. No head is NOT an exclusion. A stale source is
 * review-required and cannot fall back to blanket historical funding. */
export async function resolveExplicitFollowupCoverage(db:Runner,caseId:number,patientId:number,lock=false):Promise<
  {state:"absent"}|{state:"review_required"}|{state:"included"|"excluded";revisionId:string;invoiceId:number}> {
  if(!await followupCoverageAvailable(db))return {state:"absent"};
  if(lock)await (db as DbClient).query("SELECT id FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR SHARE NOWAIT",[caseId,patientId]);
  const head=await currentHead(db,caseId);if(!head)return {state:"absent"};
  if(lock)await lockSource(db as DbClient,sourceOf(head));
  const source=(await sourceRows(db,patientId,caseId)).find(r=>matches(r,sourceOf(head)));
  if(!source?.valid||hash(source.snapshot)!==head.source_fingerprint)return {state:"review_required"};
  return {state:head.decision,revisionId:String(head.id),invoiceId:head.invoice_id};
}
/** Historical proof is the revision recorded at sign time, not today's head. */
export async function readSignedFollowupProofs(db:Runner,adjustmentIds:number[]):Promise<Map<number,{invoiceId:number;valid:boolean}>>{
  const result=new Map<number,{invoiceId:number;valid:boolean}>();
  if(!adjustmentIds.length||!await followupCoverageAvailable(db))return result;
  const {rows}=await db.query<Stored&{adjustment_id:number;visit_patient:number;case_owner:number;visit_signed:Date|null;manifest_matches:boolean}>(`SELECT ${columns.split(',').map(c=>c.replace(/^([a-z_]+)/,'r.$1')).join(',')},a.id AS adjustment_id,v.patient_id AS visit_patient,c.patient_id AS case_owner,v.signed_at AS visit_signed,
      COALESCE(v.ortho_followup_coverage_proof @> jsonb_build_array(jsonb_build_object(
        'adjustmentId',a.id,'caseId',a.case_id,'revisionId',r.id::text,'patientId',r.patient_id)),false) AS manifest_matches
    FROM ortho_adjustments a JOIN ortho_followup_coverage_revisions r ON r.id=a.followup_coverage_revision_id
    JOIN visits v ON v.id=a.visit_id JOIN ortho_cases c ON c.id=a.case_id
    WHERE a.id=ANY($1::int[]) AND a.case_id=r.ortho_case_id AND a.billing_class='INCLUDED'`,[adjustmentIds]);
  const cached=new Map<string,SourceRow[]>();
  for(const row of rows){
    const key=`${row.patient_id}:${row.ortho_case_id}`;
    if(!cached.has(key))cached.set(key,await sourceRows(db,row.patient_id,row.ortho_case_id));
    const source=row.manifest_matches&&row.visit_signed&&row.visit_patient===row.patient_id&&row.case_owner===row.patient_id&&row.decision==='included'
      ?cached.get(key)!.find(r=>matches(r,sourceOf(row))):undefined;
    result.set(row.adjustment_id,{invoiceId:row.invoice_id,valid:!!source?.valid&&hash(source.snapshot)===row.source_fingerprint});
  }
  return result;
}
