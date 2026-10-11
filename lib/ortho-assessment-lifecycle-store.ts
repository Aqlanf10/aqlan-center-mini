import { createHash } from "node:crypto";
import { CLINIC_TIME_ZONE, ensureSchema, getPool, insertAuditRow, type DbClient } from "./db";
import { clinicDateString } from "./schedule";
import { SITE_SCOPE_LABEL } from "./invoice-clinical-linkage";
import { parseIntakeLifecycleCommand, permitsOrthoDocumentation, type IntakeLifecycleCommand, type ActivateAssessmentCommand, type OrthoLifecycleStatus } from "./ortho-assessment-lifecycle";
import { OrthoLifecycleFault, lifecycleFail, authorizeOrthoLifecycle, assertLifecycleCurrent, type LifecycleOwner, type LifecycleAuthority } from "./ortho-assessment-lifecycle-authority";
export interface LifecycleFailure { ok: false; status: number; code: string; message: string }
const digest = (v: unknown): string => createHash("sha256").update(canonical(v)).digest("hex");
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") { const encoded=JSON.stringify(v); if(encoded===undefined) lifecycleFail(409,"invalid_canonical_value","قيمة السجل غير صالحة."); return encoded; }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}`;
}
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const timestamp = (v: Date | string): string => { const d = v instanceof Date ? v : new Date(v); if (!Number.isFinite(d.getTime())) lifecycleFail(409, "invalid_stored_time", "وقت السجل غير صالح."); return d.toISOString(); };
interface BridgeRow { id: number; patient_id: number; specialty: string; status: string; site: string | null; ortho_case_id: number | null; title: string; site_length: number }
interface PlanRow { id: number; patient_id: number; status: string; consent_at: Date | null; title: string }
interface CaseRow { id: number; patient_id: number; status: string; lifecycle_version: number; assessment_opened_at: Date | null; assessment_cancelled_at: Date | null; assessment_intake_kind: string | null; plan_id: number | null }
interface EventRow { id: number; patient_id: number; recorded_patient_id: number; ortho_case_id: number; clinical_case_id: number; version: number; predecessor_id: number | null; kind: string; actor_user_id: number; recorded_by: string; recorded_at: Date; reason: string; command_id: string; request_fingerprint: string; content_sha256: string; content: unknown }
export interface LifecycleEvent { id: number; patientId: number; recordedPatientId: number; orthoCaseId: number; clinicalCaseId: number; version: number; predecessorId: number | null; kind: string; recordedBy: string; recordedAt: string; reason: string; contentHash: string; content: unknown }
export interface LifecycleChoice { id: number; contentHash: string; title: string; status: string; site?: string | null; consent: "recorded" | "not_recorded" | "not_applicable" }
export interface LifecycleRead {
  ok: true; patientId: number; writable: boolean; canLinkPlan: boolean;
  openCase: { orthoCaseId: number; clinicalCaseId: number; status: OrthoLifecycleStatus; lifecycleVersion: number } | null;
  clinicalCases: LifecycleChoice[]; plans: LifecycleChoice[]; choicesTruncated: boolean;
  history: LifecycleEvent[];
}
const bridgeSelect = `id,patient_id,specialty,status,LEFT(site,200) AS site,COALESCE(char_length(site),0)::int AS site_length,ortho_case_id,LEFT(title,160) AS title`;
const planSelect = `id,patient_id,status,consent_at,LEFT(title,160) AS title`;
const caseSelect = `id,patient_id,status,lifecycle_version,assessment_opened_at,assessment_cancelled_at,assessment_intake_kind,plan_id`;
const eventSelect = `id,patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,predecessor_id,kind,actor_user_id,recorded_by,recorded_at,reason,command_id,request_fingerprint,content_sha256,content`;
function bridgeWitness(b: BridgeRow) {
  if (b.site_length > 200) lifecycleFail(409, "bridge_scope_too_long", "نطاق الحالة يحتاج مراجعة؛ لم يُختصر لإثبات تطابقه.");
  return { version: "ortho-intake-bridge-1", id: b.id, patientId: b.patient_id, specialty: b.specialty, status: b.status, site: b.site, orthoCaseId: b.ortho_case_id };
}
function planWitness(p: PlanRow) { return { version: "ortho-intake-plan-1", id: p.id, patientId: p.patient_id, status: p.status, consentAt: p.consent_at ? timestamp(p.consent_at) : null }; }
function decodeEvent(row: EventRow): LifecycleEvent {
  if (!id(row.id) || !id(row.patient_id) || !id(row.recorded_patient_id) || !id(row.ortho_case_id) || !id(row.clinical_case_id)
    || ![1,2].includes(row.version) || !["assessment_opened","assessment_activated","assessment_cancelled"].includes(row.kind)
    || digest(row.content) !== row.content_sha256) lifecycleFail(409, "invalid_lifecycle_evidence", "تعذّر التحقق من سجل بداية الحالة؛ لم يُعتبر فارغًا.");
  return { id: row.id, patientId: row.patient_id, recordedPatientId: row.recorded_patient_id, orthoCaseId: row.ortho_case_id, clinicalCaseId: row.clinical_case_id,
    version: row.version, predecessorId: row.predecessor_id, kind: row.kind, recordedBy: row.recorded_by, recordedAt: timestamp(row.recorded_at), reason: row.reason, contentHash: row.content_sha256, content: row.content };
}
function recordedConsent(row: EventRow): "recorded" | "not_recorded" | "not_applicable" {
  if (row.kind !== "assessment_activated") return "not_applicable";
  const value = (row.content as {policy?: {consent?: unknown}})?.policy?.consent;
  if(value!=="recorded"&&value!=="not_recorded") lifecycleFail(409,"invalid_consent_witness","توثيق حالة الموافقة التاريخي غير صالح.");
  return value;
}
async function transaction<T extends {ok: true}>(write: boolean, body: (client: DbClient) => Promise<T>): Promise<T | LifecycleFailure> {
  await ensureSchema(); const client = await getPool().connect(); let committing = false;
  try { await client.query(write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ"); const value = await body(client); committing = true; await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof OrthoLifecycleFault) return { ok: false, status: error.status, code: error.code, message: error.message };
    if (write && committing) return { ok: false, status: 503, code: "write_unconfirmed", message: "لم تتأكد نتيجة الحفظ؛ احتفظ بالطلب نفسه للتحقق أو الإعادة." };
    if ((error as {code?: string})?.code === "23505") return { ok: false, status: 409, code: "lifecycle_conflict", message: "تغيرت الحالة أو استُخدم معرّف الطلب؛ أعد القراءة دون إنشاء طلب بديل تلقائيًا." };
    throw error;
  } finally { client.release(); }
}
async function bridgeForCase(client: DbClient, patientId: number, caseId: number, lock: "FOR SHARE" | "FOR UPDATE"): Promise<BridgeRow> {
  const rows = (await client.query<BridgeRow>(`SELECT ${bridgeSelect} FROM clinical_cases WHERE ortho_case_id=$1 ${lock}`, [caseId])).rows;
  if (rows.length !== 1 || rows[0].patient_id !== patientId || rows[0].specialty !== "orthodontics") lifecycleFail(409, "bridge_mismatch", "هوية الحالة السريرية غير متطابقة.");
  return rows[0];
}
async function history(client: DbClient, patientId: number, caseId: number): Promise<EventRow[]> {
  const rows = (await client.query<EventRow>(`SELECT ${eventSelect} FROM ortho_case_lifecycle_events WHERE ortho_case_id=$1 ORDER BY version LIMIT 3`, [caseId])).rows;
  if (rows.length > 2 || rows.some((r,i) => r.patient_id !== patientId || r.version !== i+1 || r.predecessor_id !== (rows[i-1]?.id ?? null))) lifecycleFail(409, "invalid_lifecycle_lineage", "تسلسل بداية الحالة يحتاج مراجعة.");
  rows.forEach(decodeEvent); return rows;
}
export async function readOrthoLifecycle(input: LifecycleOwner & {orthoCaseId?: number}): Promise<LifecycleRead | LifecycleFailure> {
  if (input.orthoCaseId !== undefined && !id(input.orthoCaseId)) return { ok:false,status:400,code:"invalid_case",message:"رقم الحالة غير صالح." };
  return transaction(false, async client => {
    const authority = await authorizeOrthoLifecycle(client,input,false);
    const plans = authority.planVisible && authority.canLinkPlan ? (await client.query<PlanRow>(`SELECT ${planSelect} FROM treatment_plans WHERE patient_id=$1 AND status<>'cancelled' ORDER BY id LIMIT 101`,[input.patientId])).rows : [];
    const linkedPlanRows=(await client.query<{plan_id:string}>(`SELECT DISTINCT e.content->'command'->'financialPlan'->>'id' AS plan_id FROM ortho_case_lifecycle_events e JOIN ortho_cases o ON o.id=e.ortho_case_id WHERE e.patient_id=$1 AND ${input.orthoCaseId === undefined ? "o.status IN ('assessment','active','retention')" : "o.id=$2"} AND e.content->'command'->'financialPlan'->>'id' IS NOT NULL LIMIT 3`,input.orthoCaseId === undefined ? [input.patientId] : [input.patientId,input.orthoCaseId])).rows;
    if (linkedPlanRows.length>1) lifecycleFail(409,"invalid_plan_history","سجل اتفاق الحالة غير متوقع؛ لم يُختصر.");
    if(linkedPlanRows.length&&!authority.planVisible)lifecycleFail(403,"plan_view_denied","سجل البداية يتضمن اتفاقًا مقيدًا؛ لم تُسقط مصادره بصمت.");
    for (const row of linkedPlanRows) {
      const planId=/^[1-9]\d*$/.test(row.plan_id)?Number(row.plan_id):NaN;
      if (!id(planId)) lifecycleFail(409,"invalid_stored_plan","مرجع الاتفاق التاريخي غير صالح.");
      const owner=(await client.query<{patient_id:number}>(`SELECT patient_id FROM treatment_plans WHERE id=$1 FOR SHARE`,[planId])).rows[0];
      if (!owner || owner.patient_id!==input.patientId) lifecycleFail(403,"plan_owner_changed","مرجع الاتفاق التاريخي لم يعد متاحًا لهذا المريض.");
    }
    const cases = (await client.query<CaseRow>(`SELECT ${caseSelect} FROM ortho_cases WHERE patient_id=$1 AND ${input.orthoCaseId === undefined ? "status IN ('assessment','active','retention')" : "id=$2"} ORDER BY id LIMIT 2 FOR SHARE`,input.orthoCaseId === undefined ? [input.patientId] : [input.patientId,input.orthoCaseId])).rows;
    if (cases.length>1) lifecycleFail(409,"ambiguous_open_case","يوجد أكثر من سياق تقويم مفتوح؛ يلزم إصلاح الهوية قبل المتابعة.");
    const found=cases[0]; if(input.orthoCaseId!==undefined&&!found) lifecycleFail(404,"case_missing","الحالة لا تخص المريض الحالي.");
    if(found&&!permitsOrthoDocumentation(found.status)) lifecycleFail(409,"unsupported_case_state","مرحلة الحالة غير مدعومة.");
    const bridge=found?await bridgeForCase(client,input.patientId,found.id,"FOR SHARE"):null;
    const choices=(await client.query<BridgeRow>(`SELECT ${bridgeSelect} FROM clinical_cases WHERE patient_id=$1 AND specialty='orthodontics' AND ortho_case_id IS NULL AND status IN ('active','waiting') ORDER BY id LIMIT 101 FOR SHARE`,[input.patientId])).rows;
    const saved=found?await history(client,input.patientId,found.id):[];
    assertLifecycleCurrent(authority);
    return { ok:true as const,patientId:input.patientId,writable:authority.writable,canLinkPlan:authority.canLinkPlan,
      openCase:found&&bridge?{orthoCaseId:found.id,clinicalCaseId:bridge.id,status:found.status as OrthoLifecycleStatus,lifecycleVersion:found.lifecycle_version}:null,
      clinicalCases:choices.slice(0,100).map(b=>({id:b.id,contentHash:digest(bridgeWitness(b)),title:b.title,status:b.status,site:b.site,consent:"not_applicable" as const})),
      plans:plans.slice(0,100).map(p=>({id:p.id,contentHash:digest(planWitness(p)),title:p.title,status:p.status,consent:p.consent_at?"recorded" as const:"not_recorded" as const})),
      choicesTruncated:plans.length>100||choices.length>100,history:saved.map(decodeEvent) };
  });
}
async function insertEvent(client: DbClient, authority: LifecycleAuthority, patientId: number, command: IntakeLifecycleCommand,
  scope: {orthoCaseId:number;clinicalCaseId:number}, predecessor: EventRow | null, policy: unknown): Promise<LifecycleEvent> {
  const kind=command.kind==="open_assessment"?"assessment_opened":command.kind==="activate_assessment"?"assessment_activated":"assessment_cancelled";
  const content={schemaVersion:1,command,policy};
  const row=(await client.query<EventRow>(`INSERT INTO ortho_case_lifecycle_events(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,version,predecessor_id,kind,actor_user_id,recorded_by,reason,command_id,request_fingerprint,content_version,content_sha256,content)
    VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13::jsonb) RETURNING ${eventSelect}`,
    [patientId,scope.orthoCaseId,scope.clinicalCaseId,(predecessor?.version??0)+1,predecessor?.id??null,kind,authority.actorId,authority.actorName,command.reason,command.commandId,digest(command),digest(content),JSON.stringify(content)])).rows[0];
  const event=decodeEvent(row);
  await insertAuditRow(client,{action:"ortho.lifecycle.record",entity:"ortho_case",entityId:scope.orthoCaseId,entityLabel:kind,actor:authority.actorName,actorRole:authority.session.role,
    details:{patientId,clinicalCaseId:scope.clinicalCaseId,eventId:event.id,version:event.version,kind,contentHash:event.contentHash,reason:command.reason}});
  return event;
}
export async function recordOrthoLifecycle(input: LifecycleOwner & {command: unknown}): Promise<LifecycleFailure | {ok:true;event:LifecycleEvent;replayed:boolean;consentAtRecording:"recorded"|"not_recorded"|"not_applicable"}> {
  const parsed=parseIntakeLifecycleCommand(input.command);
  if(!parsed.ok)return {ok:false,status:400,code:parsed.code,message:"طلب بداية الحالة غير صالح."};
  const command=parsed.value;
  return transaction(true,async client=>{
    const authority=await authorizeOrthoLifecycle(client,input,true);
    // Actor+command is global because intake has no case ID yet. Never inspect
    // another patient's committed content before its current owner is checked.
    const replayMeta=(await client.query<{id:number;patient_id:number;ortho_case_id:number;clinical_case_id:number;request_fingerprint:string;plan_id:string|null}>(
      `SELECT id,patient_id,ortho_case_id,clinical_case_id,request_fingerprint,content->'command'->'financialPlan'->>'id' AS plan_id FROM ortho_case_lifecycle_events WHERE actor_user_id=$1 AND command_id=$2`,[authority.actorId,command.commandId])).rows[0];
    if(replayMeta){
      if(replayMeta.patient_id!==input.patientId||replayMeta.request_fingerprint!==digest(command)) lifecycleFail(409,"command_conflict","معرّف الطلب مستخدم لسياق أو محتوى مختلف.");
      if (replayMeta.plan_id !== null) {
        if(!authority.planVisible)lifecycleFail(403,"plan_view_denied","مرجع الاتفاق التاريخي مقيد حاليًا.");
        const planId = /^[1-9]\d*$/.test(replayMeta.plan_id) ? Number(replayMeta.plan_id) : NaN;
        if (!id(planId)) lifecycleFail(409,"invalid_stored_plan","مرجع الاتفاق التاريخي غير صالح.");
        const owner=(await client.query<{patient_id:number}>(`SELECT patient_id FROM treatment_plans WHERE id=$1 FOR SHARE`,[planId])).rows[0];
        if (!owner || owner.patient_id!==input.patientId) lifecycleFail(403,"plan_owner_changed","مرجع الاتفاق التاريخي لم يعد متاحًا لهذا المريض.");
      }
      const c=(await client.query<CaseRow>(`SELECT ${caseSelect} FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR UPDATE`,[replayMeta.ortho_case_id,input.patientId])).rows[0];
      if(!c)lifecycleFail(409,"owner_changed","تغيرت ملكية الحالة.");
      const b=await bridgeForCase(client,input.patientId,c.id,"FOR UPDATE");
      if(b.id!==replayMeta.clinical_case_id)lifecycleFail(409,"bridge_changed","تغير الرابط السريري للطلب التاريخي.");
      const row=(await client.query<EventRow>(`SELECT ${eventSelect} FROM ortho_case_lifecycle_events WHERE id=$1`,[replayMeta.id])).rows[0];
      assertLifecycleCurrent(authority);
      // Historical acknowledgement does not relink today's plan or reapply facts.
      return {ok:true as const,event:decodeEvent(row),replayed:true,consentAtRecording:recordedConsent(row)};
    }
    if(command.patientId!==input.patientId)lifecycleFail(409,"scope_changed","لا يطابق المريض سياق الطلب الجديد.");
    let plan:PlanRow|null=null;
    if(command.kind==="activate_assessment"&&command.financialPlan){
      if(!authority.planVisible||!authority.canLinkPlan)lifecycleFail(403,"plan_edit_denied","غير مصرّح لك بربط الاتفاق المالي.");
      plan=(await client.query<PlanRow>(`SELECT ${planSelect} FROM treatment_plans WHERE id=$1 FOR SHARE`,[command.financialPlan.id])).rows[0]??null;
      if(!plan||plan.patient_id!==input.patientId||plan.status==="cancelled")lifecycleFail(409,"invalid_plan","الاتفاق المختار ليس اتفاقًا ساريًا لهذا المريض.");
      if(digest(planWitness(plan))!==command.financialPlan.expectedContentHash)lifecycleFail(409,"plan_changed","تغير الاتفاق أو توثيق موافقته؛ أعد مراجعته.");
    }
    if(command.kind==="open_assessment"){
      const open=(await client.query(`SELECT id FROM ortho_cases WHERE patient_id=$1 AND status IN ('assessment','active','retention') ORDER BY id LIMIT 2 FOR UPDATE`,[input.patientId])).rows;
      if(open.length)lifecycleFail(409,"open_case_exists","للمريض حالة تقويم مفتوحة؛ اخترها بدل إنشاء حالة ثانية.");
      const candidates=(await client.query<BridgeRow>(`SELECT ${bridgeSelect} FROM clinical_cases WHERE patient_id=$1 AND specialty='orthodontics' AND ortho_case_id IS NULL AND status IN ('active','waiting') ORDER BY id LIMIT 102 FOR UPDATE`,[input.patientId])).rows;
      if(candidates.length>100)lifecycleFail(409,"case_choice_limit","قائمة الحالات تحتاج عرضًا مخصصًا؛ لم تُختصر لإنشاء حالة جديدة.");
      let bridge:BridgeRow|null=null;
      if(command.bridge.mode==="new"){
        if(candidates.length)lifecycleFail(409,"explicit_existing_case_required","توجد حالة تخصصية مفتوحة؛ اختر الحالة المقصودة صراحةً ولا تنشئ هوية مكررة.");
      }else{
        bridge=candidates.find(b=>b.id===(command.bridge.mode==="existing"?command.bridge.clinicalCaseId:0))??null;
        if(!bridge||digest(bridgeWitness(bridge))!==command.bridge.expectedContentHash)lifecycleFail(409,"bridge_choice_changed","تغيرت الحالة المختارة أو نطاقها؛ أعد اختيارها.");
      }
      const created=(await client.query<{id:number}>(`INSERT INTO ortho_cases(patient_id,appliance,arches,slot,bracket_system,phase,start_date,planned_months,plan_id,note,created_by,status,assessment_opened_at,assessment_intake_kind,lifecycle_version)
        VALUES($1,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,$2,'assessment',NOW(),$3,1) RETURNING id`,[input.patientId,authority.actorName,command.intakeKind])).rows[0];
      const priorBridge=bridge?bridgeWitness(bridge):null;
      let clinicalCaseId:number;
      if(bridge){clinicalCaseId=bridge.id;await client.query(`UPDATE clinical_cases SET ortho_case_id=$2 WHERE id=$1`,[bridge.id,created.id]);}
      else{clinicalCaseId=(await client.query<{id:number}>(`INSERT INTO clinical_cases(patient_id,specialty,title,site,ortho_case_id,created_by,status,started_on)
        VALUES($1,'orthodontics','تقييم حالة تقويم',NULL,$2,$3,'waiting',$4::date) RETURNING id`,[input.patientId,created.id,authority.actorName,clinicDateString(new Date(),CLINIC_TIME_ZONE)])).rows[0].id;}
      const event=await insertEvent(client,authority,input.patientId,command,{orthoCaseId:created.id,clinicalCaseId},null,{bridgeAtOpening:priorBridge,openingDateMeaning:"clinical_episode_opening_not_treatment_start"});
      assertLifecycleCurrent(authority);return {ok:true as const,event,replayed:false,consentAtRecording:"not_applicable" as const};
    }
    const c=(await client.query<CaseRow>(`SELECT ${caseSelect} FROM ortho_cases WHERE id=$1 AND patient_id=$2 FOR UPDATE`,[command.orthoCaseId,input.patientId])).rows[0];
    if(!c)lifecycleFail(404,"case_missing","الحالة لا تخص المريض الحالي.");
    const b=await bridgeForCase(client,input.patientId,c.id,"FOR UPDATE");
    if(b.id!==command.clinicalCaseId)lifecycleFail(409,"bridge_changed","لا يطابق الرابط السريري الطلب.");
    const saved=await history(client,input.patientId,c.id),head=saved.at(-1);
    if(c.status!=="assessment"||c.lifecycle_version!==command.expectedLifecycleVersion||!head||head.kind!=="assessment_opened"||head.version!==c.lifecycle_version) lifecycleFail(409,"lifecycle_changed","تغيرت حالة التقييم؛ أعد قراءة السجل قبل توثيق الإجراء.");
    if(command.kind==="cancel_assessment"){
      const openingPolicy=(saved[0]?.content as {policy?:{bridgeAtOpening?:unknown}})?.policy;
      if(!openingPolicy || !Object.hasOwn(openingPolicy,"bridgeAtOpening") || openingPolicy.bridgeAtOpening!==null)
        lifecycleFail(409,"preexisting_episode_cancel_requires_review","هذا التقييم مرتبط بحالة سريرية سابقة؛ لا يُلغيها إلغاء التقييم. يلزم مسار مراجعة صريح يحفظ حالتها وتاريخها.");
      await client.query(`UPDATE ortho_cases SET status='assessment_cancelled',assessment_cancelled_at=NOW(),assessment_cancelled_reason=$2,closed_at=NOW(),closed_note=$2,lifecycle_version=lifecycle_version+1 WHERE id=$1`,[c.id,command.reason]);
      await client.query(`UPDATE clinical_cases SET status='cancelled',completed_at=NOW(),outcome=$2 WHERE id=$1`,[b.id,command.reason]);
      const event=await insertEvent(client,authority,input.patientId,command,{orthoCaseId:c.id,clinicalCaseId:b.id},head,{eventMeaning:"assessment_episode_cancelled_not_treatment_completed"});
      assertLifecycleCurrent(authority);return {ok:true as const,event,replayed:false,consentAtRecording:"not_applicable" as const};
    }
    const t:ActivateAssessmentCommand["treatment"]=command.treatment;
    if(t.start.state==="known"&&t.start.date>clinicDateString(new Date(),CLINIC_TIME_ZONE))lifecycleFail(400,"future_treatment_start","بداية العلاج الموثقة لا تكون في المستقبل.");
    // This explicit clinical value is never inferred from an invoice or intake date.
    if(b.site!==null&&b.site!==""&&b.site!==t.arches&&b.site!==SITE_SCOPE_LABEL[t.arches])lifecycleFail(409,"arch_scope_conflict","الفك الموثق لا يطابق نطاق الحالة المختارة؛ راجع النطاق صراحةً.");
    await client.query(`UPDATE ortho_cases SET status=$2,appliance=$3,arches=$4,slot=$5,bracket_system=$6,phase=$7,start_date=$8::date,planned_months=$9,plan_id=$10,treatment_start_evidence=$11::jsonb,lifecycle_version=lifecycle_version+1 WHERE id=$1`,
      [c.id,t.phase==="retention"?"retention":"active",t.appliance,t.arches,t.slot,t.bracketSystem,t.phase,t.start.state==="known"?t.start.date:null,t.plannedMonths,plan?.id??null,JSON.stringify(t.start)]);
    await client.query(`UPDATE clinical_cases SET status='active',site=$2,completed_at=NULL WHERE id=$1`,[b.id,SITE_SCOPE_LABEL[t.arches]]);
    const event=await insertEvent(client,authority,input.patientId,command,{orthoCaseId:c.id,clinicalCaseId:b.id},head,{plan:plan?planWitness(plan):null,consentPolicy:"existing_procedure_and_signature_guards_unchanged",consent:plan?.consent_at?"recorded":"not_recorded"});
    assertLifecycleCurrent(authority);return {ok:true as const,event,replayed:false,consentAtRecording:plan?.consent_at?"recorded" as const:"not_recorded" as const};
  });
}
