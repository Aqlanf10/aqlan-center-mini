import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { assessmentCommandV2 } from "../fixtures/ortho-assessment-schema2";
import { seedCanonicalAssessment } from "../fixtures/canonical-ortho-assessment";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-assessment-write-secret-0123456789");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-ortho-assessment-command");
const sources = await import("../../lib/ortho-assessment-versioned-sources");
const EDIT = { "clinical.ortho.view": true, "clinical.ortho.edit": true };
const ACCOUNTS = {
  owner: { username: "SYN-OAW-OWNER", role: "admin" },
  own: { username: "SYN-OAW-OWN", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
  all: { username: "SYN-OAW-ALL", role: "reception", patientScope: "all", grants: EDIT },
  imaging: { username: "SYN-OAW-IMAGING", role: "reception", patientScope: "all", grants: { ...EDIT, "clinical.xrays.view": true } },
  care: { username: "SYN-OAW-CARE", role: "reception", patientScope: "all", grants: { ...EDIT, "clinical.plans.view": true } },
  none: { username: "SYN-OAW-NONE", role: "doctor", doctor: true, patientScope: "none", grants: EDIT },
  unlinked: { username: "SYN-OAW-UNLINKED", role: "doctor", patientScope: "own", grants: EDIT },
  read: { username: "SYN-OAW-READ", role: "admin", patientScope: "all", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true, status = "active", bridge = true) {
  const patientId = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-OAW-${++seq}`, own ? fx.parties.own : null])).rows[0].id as number;
  const caseId = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,$2,'SYN') RETURNING id", [patientId,status])).rows[0].id as number;
  const bridgeId = bridge ? (await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN explicit bridge',$2,'SYN') RETURNING id", [patientId,caseId])).rows[0].id as number : 0;
  return {patientId,caseId,bridgeId,actorId:fx.ids.owner};
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const command = () => ({ ...assessmentCommandV2(), commandId: randomUUID() });
const run = async (key: Key, s: Scenario, body: unknown) => commands.commandCanonicalOrthoAssessment(await fx.session(key), String(s.caseId), body);
const revisions = async (s: Scenario) => (await fx.pool.query("SELECT to_jsonb(r) value FROM ortho_assessment_revisions r WHERE ortho_case_id=$1 ORDER BY version",[s.caseId])).rows.map(r=>r.value);
const audits = async (s: Scenario) => (await fx.pool.query("SELECT action,actor,summary FROM audit_log WHERE action='ortho.assessment.append' AND entity_id=$1 ORDER BY id",[String(s.caseId)])).rows;
async function document(s: Scenario) {
  const id = (await fx.pool.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by,ortho_case_id) VALUES($1,'imaging','SYN private title','image/png',1,$2,'SYN/no-file.png','SYN',$3) RETURNING id",[s.patientId,"a".repeat(64),s.caseId])).rows[0].id as number;
  return {kind:"document" as const,id,version:`sha256:${"a".repeat(64)}`};
}
it.each(["own","all","owner"] as const)("%s appends one native revision and atomically audits the actual actor", async key => {
  const s=await scenario(),input=command(),result=await run(key,s,input);
  expect(result).toMatchObject({ok:true,replayed:false,revision:{patientId:s.patientId,orthoCaseId:s.caseId,clinicalCaseId:s.bridgeId,version:1,schemaVersion:2,createdBy:ACCOUNTS[key].username}});
  expect(result.revision.content.draft).toEqual(input.content);
  expect(await audits(s)).toMatchObject([{action:"ortho.assessment.append",actor:ACCOUNTS[key].username}]);
  expect(await revisions(s)).toHaveLength(1);
});
it.each(["read","none","unlinked"] as const)("%s cannot substitute a role label or write body for patient authority",async key=>{
  const s=await scenario();await expect(run(key,s,command())).rejects.toThrow(/CAPABILITY|SCOPE|UNLINKED/);expect(await revisions(s)).toEqual([]);expect(await audits(s)).toEqual([]);
});
it("outside and missing are indistinguishable; bridge-less cases do not acquire a fabricated clinical identity",async()=>{
  const s=await scenario(false),input=command(),failures=[];
  for(const id of[s.caseId,2147483647]){try{await commands.commandCanonicalOrthoAssessment(await fx.session("own"),String(id),input);throw Error("unexpected");}catch(error){failures.push({code:(error as {code:string}).code,message:(error as Error).message});}}
  expect(failures[0]).toEqual(failures[1]);expect(failures[0].code).toBe("ortho_case_not_found");
  const absent=await scenario(true,"active",false);await expect(run("own",absent,input)).rejects.toMatchObject({code:"bridge_missing"});expect(await revisions(absent)).toEqual([]);
});
it("same actor and exact request replay once; changed bytes or stale head cannot create an extra revision",async()=>{
  const s=await scenario(),input=command(),first=await run("own",s,input),before=await revisions(s);
  expect(await run("own",s,input)).toEqual({...first,replayed:true});
  await expect(run("own",s,{...input,reason:"SYN changed intent"})).rejects.toMatchObject({code:"command_conflict"});
  await expect(run("own",s,command())).rejects.toMatchObject({code:"head_changed"});
  expect(await revisions(s)).toEqual(before);expect(await audits(s)).toHaveLength(1);
});
it.each(["completed","discontinued"])("%s retains retrospective documentation without reopening treatment",async status=>{
  const s=await scenario(true,status),before=(await fx.pool.query("SELECT to_jsonb(c) value FROM ortho_cases c WHERE id=$1",[s.caseId])).rows;
  expect((await run("own",s,command())).revision.recordingContext).toBe("retrospective");
  expect((await fx.pool.query("SELECT to_jsonb(c) value FROM ortho_cases c WHERE id=$1",[s.caseId])).rows).toEqual(before);
});
it("imaging and care sources need independent grants, even for an otherwise legitimate editor",async()=>{
  const s=await scenario(),source=await document(s),input=command();input.content.observations.observations[0].provenance!.sources=[source];
  await expect(run("own",s,input)).rejects.toMatchObject({status:403});expect(await revisions(s)).toEqual([]);
  expect((await run("imaging",s,input)).revision.version).toBe(1);
  const care=await scenario(),id=(await fx.pool.query("INSERT INTO patient_medical_history(patient_id,recorded_by,notes) VALUES($1,'SYN','SYN private medical history') RETURNING id",[care.patientId])).rows[0].id;
  const scope={patientId:care.patientId,orthoCaseId:care.caseId,clinicalCaseId:care.bridgeId};
  const current=await sources.readAssessmentExternalSourcesWith(fx.pool,scope,[{kind:"patient_history",id}]);
  const careInput=command();careInput.content.observations.observations[0].provenance!.sources=[{kind:"patient_history",id,version:current.get(`patient_history:${id}`)!.version}];
  await expect(run("own",care,careInput)).rejects.toMatchObject({status:403});
  // The accepted central care group includes xrays.view; do not invent an extra grant.
  const careSaved = await run("imaging",care,careInput); expect(careSaved.revision.version).toBe(1);
  expect((await run("care",care,{...command(),content:careInput.content,expectedRevisionId:careSaved.revision.id})).revision.version).toBe(2);
});
it("a cleared new draft cannot discard a restricted historical ancestor or copied source",async()=>{
  const s=await scenario(),source=await document(s),first=await seedCanonicalAssessment(fx.pool,{...s,sources:[source]});
  const second=await seedCanonicalAssessment(fx.pool,{...s,version:2,previous:first.id,sources:[{kind:"assessment_revision",id:first.id,version:`sha256:${first.hash}`}]});
  const third=await seedCanonicalAssessment(fx.pool,{...s,version:3,previous:second.id});const input={...command(),expectedRevisionId:third.id},before=await revisions(s);
  await expect(run("own",s,input)).rejects.toMatchObject({status:403});expect(await revisions(s)).toEqual(before);
  expect((await run("imaging",s,input)).revision.version).toBe(4);
});
it("replay checks fresh authority and source ownership, while changed same-owner source bytes preserve the original receipt",async()=>{
  const s=await scenario(),source=await document(s),input=command();input.content.observations.observations[0].provenance!.sources=[source];const first=await run("imaging",s,input);
  await fx.pool.query("UPDATE patient_documents SET sha256=$1 WHERE id=$2",["b".repeat(64),source.id]);expect(await run("imaging",s,input)).toEqual({...first,replayed:true});
  const foreign=await scenario(false);await fx.pool.query("UPDATE patient_documents SET patient_id=$1 WHERE id=$2",[foreign.patientId,source.id]);
  await expect(run("owner",s,{...command(),expectedRevisionId:first.revision.id})).rejects.toMatchObject({status:403});
  await expect(run("imaging",s,input)).rejects.toMatchObject({status:403});expect(await revisions(s)).toHaveLength(1);expect(await audits(s)).toHaveLength(1);
});
it("concurrent same-command waiters serialize to one insert and one durable replay",async()=>{
  const s=await scenario(),input=command(),session=await fx.session("own"),holder=await side.connect();let pending:Promise<unknown>[]=[];
  try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);
    pending=[1,2].map(()=>commands.commandCanonicalOrthoAssessment(session,String(s.caseId),input));pending.forEach(p=>{void p.catch(()=>undefined);});
    await vi.waitFor(async()=>expect((await side.query("WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked",[pid])).rowCount).toBe(2),{timeout:10000,interval:10});
    await holder.query("COMMIT");const result=await Promise.all(pending);expect(result).toMatchObject([{ok:true},{ok:true}]);expect((result as {replayed:boolean}[]).map(r=>r.replayed).sort()).toEqual([false,true]);expect(await revisions(s)).toHaveLength(1);expect(await audits(s)).toHaveLength(1);
  }finally{await holder.query("ROLLBACK");holder.release();await Promise.allSettled(pending);}
});
it.each(["expiry","membership"] as const)("%s is checked after a real patient wait",async kind=>{
  const s=await scenario(),input=command(),session=await fx.session("own",kind==="expiry"?1500:60000),holder=await side.connect();let pending:Promise<unknown>|undefined;
  try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);pending=commands.commandCanonicalOrthoAssessment(session,String(s.caseId),input);void pending.catch(()=>undefined);await waitForBlockedBy(side,pid);
    if(kind==="expiry")await new Promise(r=>setTimeout(r,1700));else await holder.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[s.patientId]);await holder.query("COMMIT");await expect(pending).rejects.toThrow();expect(await revisions(s)).toEqual([]);expect(await audits(s)).toEqual([]);
  }finally{await holder.query("ROLLBACK");holder.release();await pending?.catch(()=>undefined);}
});
it("audit failure rolls back the immutable revision and native results",async()=>{
  const s=await scenario();await fx.pool.query("CREATE FUNCTION syn_assessment_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.assessment.append' THEN RAISE EXCEPTION 'SYN audit refused'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_assessment_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_assessment_audit()");
  try{await expect(run("own",s,command())).rejects.toThrow(/SYN audit refused/);expect(await revisions(s)).toEqual([]);expect(await audits(s)).toEqual([]);}finally{await fx.pool.query("DROP TRIGGER syn_assessment_audit ON audit_log; DROP FUNCTION syn_assessment_audit()");}
});
it("revocation behind the lifecycle fence refuses the old session and a fresh read-only session",async()=>{
  const s=await scenario(),input=command(),session=await fx.session("all"),holder=await side.connect();let pending:Promise<unknown>|undefined;
  try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan.canonical.identity.substrate.v1:public',0))");await holder.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{"clinical.ortho.view":true},patientScope:"all"},2)),fx.ids.all]);
    pending=commands.commandCanonicalOrthoAssessment(session,String(s.caseId),input);void pending.catch(()=>undefined);await waitForBlockedBy(side,pid);await holder.query("COMMIT");await expect(pending).rejects.toThrow(/STALE/);await expect(run("all",s,input)).rejects.toThrow(/CAPABILITY/);expect(await revisions(s)).toEqual([]);
  }finally{await holder.query("ROLLBACK");holder.release();await pending?.catch(()=>undefined);await fx.setGrants("all",EDIT,{patientScope:"all"});}
});
it("a source transferred during a real source-row wait cannot authorize an append",async()=>{
  const s=await scenario(),foreign=await scenario(false),source=await document(s),input=command();input.content.observations.observations[0].provenance!.sources=[source];
  const saved=await seedCanonicalAssessment(fx.pool,{...s,sources:[source]});input.expectedRevisionId=saved.id;
  const session=await fx.session("imaging"),holder=await side.connect();let pending:Promise<unknown>|undefined;
  try{await holder.query("BEGIN");const pid=(await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;await holder.query("SELECT id FROM patient_documents WHERE id=$1 FOR UPDATE",[source.id]);
    pending=commands.commandCanonicalOrthoAssessment(session,String(s.caseId),input);void pending.catch(()=>undefined);await waitForBlockedBy(side,pid);
    await holder.query("UPDATE patient_documents SET patient_id=$1 WHERE id=$2",[foreign.patientId,source.id]);await holder.query("COMMIT");await expect(pending).rejects.toMatchObject({status:403});expect(await revisions(s)).toHaveLength(1);expect(await audits(s)).toEqual([]);
  }finally{await holder.query("ROLLBACK");holder.release();await pending?.catch(()=>undefined);}
});
it("a conflicting case lock fails closed without waiting behind an inverse writer",async()=>{
  const s=await scenario(),holder=await side.connect();try{await holder.query("BEGIN");await holder.query("SELECT id FROM ortho_cases WHERE id=$1 FOR UPDATE",[s.caseId]);
    await expect(run("all",s,command())).rejects.toMatchObject({code:"assessment_conflict",status:409});expect(await revisions(s)).toEqual([]);
  }finally{await holder.query("ROLLBACK");holder.release();}
});
it("expiry after the audit insert rolls back both immutable result and audit",async()=>{
  const s=await scenario(),session=await fx.session("own",1500);
  await fx.pool.query("CREATE FUNCTION syn_assessment_late() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.assessment.append' THEN PERFORM pg_sleep(1.8); END IF; RETURN NEW; END $$; CREATE TRIGGER syn_assessment_late BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_assessment_late()");
  try{await expect(commands.commandCanonicalOrthoAssessment(session,String(s.caseId),command())).rejects.toThrow(/EXPIRED|SESSION/);expect(await revisions(s)).toEqual([]);expect(await audits(s)).toEqual([]);}finally{await fx.pool.query("DROP TRIGGER syn_assessment_late ON audit_log; DROP FUNCTION syn_assessment_late()");}
});
it("one owned transaction preserves nonempty finance and original patient/clinical identities",async()=>{
  const s=await scenario();await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by) VALUES($1,$2,76543,'USD','SYN')",[`SYN-OAW-FIN-${s.caseId}`,s.patientId]);
  const unchanged=async()=>(await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT to_jsonb(p) FROM patients p WHERE id=$1) patient,(SELECT to_jsonb(c) FROM ortho_cases c WHERE id=$2) ortho,(SELECT to_jsonb(cc) FROM clinical_cases cc WHERE id=$3) bridge",[s.patientId,s.caseId,s.bridgeId])).rows;
  const before=await unchanged(),session=await fx.session("own"),pool=db.getPool(),connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),ensure=vi.spyOn(db,"ensureSchema");
  try{await commands.commandCanonicalOrthoAssessment(session,String(s.caseId),command());expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();}finally{connect.mockRestore();query.mockRestore();ensure.mockRestore();}
  expect(await unchanged()).toEqual(before);
});
it("a new revision cannot exceed the real history byte budget and strand the accepted reader",async()=>{
  const {ASSESSMENT_HISTORY_MAX_BYTES,ASSESSMENT_HISTORY_MAX_REVISIONS}=await import("../../lib/ortho-assessment-limits");
  const s=await scenario();let head=await seedCanonicalAssessment(fx.pool,s);
  const bytes=Number((await fx.pool.query("SELECT octet_length(content::text) bytes FROM ortho_assessment_revisions WHERE id=$1",[head.id])).rows[0].bytes);
  const admitted=Math.min(Math.floor(ASSESSMENT_HISTORY_MAX_BYTES/bytes),ASSESSMENT_HISTORY_MAX_REVISIONS);
  expect(admitted).toBeGreaterThan(1);
  for(let version=2;version<=admitted;version++)head=await seedCanonicalAssessment(fx.pool,{...s,version,previous:head.id});
  const before=(await fx.pool.query("SELECT count(*)::int count,sum(octet_length(content::text))::text bytes,max(id) head FROM ortho_assessment_revisions WHERE ortho_case_id=$1",[s.caseId])).rows;
  expect(Number(before[0].bytes)).toBeLessThanOrEqual(ASSESSMENT_HISTORY_MAX_BYTES);
  await expect(run("owner",s,{...command(),expectedRevisionId:head.id})).rejects.toMatchObject({code:"history_resource_limit",status:409});
  expect((await fx.pool.query("SELECT count(*)::int count,sum(octet_length(content::text))::text bytes,max(id) head FROM ortho_assessment_revisions WHERE ortho_case_id=$1",[s.caseId])).rows).toEqual(before);
  expect(await audits(s)).toEqual([]);
});
it("corrupt saved history fails closed without rewriting or bypassing its hash",async()=>{
  const s=await scenario(),saved=await seedCanonicalAssessment(fx.pool,{...s,badHash:true}),before=await revisions(s);
  await expect(run("owner",s,{...command(),expectedRevisionId:saved.id})).rejects.toMatchObject({status:409});
  expect(await revisions(s)).toEqual(before);expect(await audits(s)).toEqual([]);
});
