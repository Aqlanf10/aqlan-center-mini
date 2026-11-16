import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-case-status-secret-0123456789");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-case-status-command"), reads = await import("../../lib/canonical-case-reads");
const EDIT = { "clinical.plans.view": true, "clinical.plans.edit": true };
const ACCOUNTS = {
  owner: { username: "SYN-CSW-OWNER", role: "admin" },
  own: { username: "SYN-CSW-OWN", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
  all: { username: "SYN-CSW-ALL", role: "reception", patientScope: "all", grants: EDIT },
  none: { username: "SYN-CSW-NONE", role: "doctor", doctor: true, patientScope: "none", grants: EDIT },
  unlinked: { username: "SYN-CSW-UNLINKED", role: "doctor", patientScope: "own", grants: EDIT },
  readonly: { username: "SYN-CSW-READ", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-CSW-${++seq}`, own ? fx.parties.own : null])).rows[0].id);
  return { ...await seedCanonicalPatientCases(fx.pool, patientId, own ? fx.parties.own : undefined), patientId };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const current = async (s: Scenario) => (await fx.pool.query("SELECT status,outcome,completed_at FROM clinical_cases WHERE id=$1",[s.caseId])).rows[0];
const version = async (s: Scenario) => (await reads.readCanonicalPatientCases(await fx.session("owner"),s.patientId)).cases.find(c=>c.id===s.caseId)!.version!;
const change = async (key: Key,s:Scenario,status="waiting",outcome:string|null=null,expectedVersion?:string) => commands.commandCanonicalCaseStatus(await fx.session(key),String(s.caseId),{status,outcome,expectedVersion:expectedVersion??await version(s)});
const audit = async (s:Scenario)=>(await fx.pool.query("SELECT action,actor,details FROM audit_log WHERE action='case.status' AND entity_id=$1 ORDER BY id",[String(s.patientId)])).rows;
it.each(["owner","own","all"] as const)("%s changes clinical state with the real actor and no finance projection",async key=>{
  const s=await scenario();expect(await change(key,s)).toEqual({ok:true,caseId:s.caseId,status:"waiting"});expect(await current(s)).toEqual({status:"waiting",outcome:null,completed_at:null});expect(await audit(s)).toEqual([expect.objectContaining({actor:ACCOUNTS[key].username})]);
});
it.each(["none","unlinked","readonly"] as const)("refuses %s without a transition or audit",async key=>{
  const s=await scenario();await expect(change(key,s)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/);expect((await current(s)).status).toBe("active");expect(await audit(s)).toEqual([]);
});
it("outside and missing are indistinguishable",async()=>{
  const s=await scenario(false),session=await fx.session("own"),errors=[];
  for(const id of [s.caseId,2147483647])try{await commands.commandCanonicalCaseStatus(session,String(id),{status:"waiting",outcome:null,expectedVersion:"a".repeat(64)});throw Error("unexpected");}catch(error){errors.push({code:(error as {code:string}).code,message:(error as Error).message});}
  expect(errors[0]).toEqual(errors[1]);expect(errors[0].code).toBe("case_status_not_found");expect(await audit(s)).toEqual([]);
});
it.each([...["waiting","completed","closed","cancelled"].map(to=>["active",to]),...["active","completed","closed","cancelled"].map(to=>["waiting",to])])("preserves the existing %s → %s transition",async(from,to)=>{
  const s=await scenario();if(from==="waiting")await change("owner",s,"waiting");const before=(await audit(s)).length;
  expect(await change("own",s,to,"SYN clinical outcome")).toMatchObject({status:to});const row=await current(s);expect(row.status).toBe(to);expect(row.outcome).toBe("SYN clinical outcome");expect(row.completed_at===null).toBe(["active","waiting"].includes(to));expect(await audit(s)).toHaveLength(before+1);
});
it.each(["completed","closed","cancelled"])("never reopens terminal %s state",async terminal=>{
  const s=await scenario();await change("owner",s,terminal,"SYN terminal reason");const before=await current(s);await expect(change("owner",s,"active")).rejects.toMatchObject({code:"case_status_transition"});expect(await current(s)).toEqual(before);expect(await audit(s)).toHaveLength(1);
});
it("same-state requests and old active→waiting→active comparisons are refused",async()=>{
  const s=await scenario(),old=await version(s);await expect(change("own",s,"active",null,old)).rejects.toMatchObject({code:"case_status_transition"});
  await change("own",s,"waiting",null,old);await change("own",s,"active");await expect(change("own",s,"closed","SYN stale outcome",old)).rejects.toMatchObject({code:"case_status_conflict"});expect((await current(s)).status).toBe("active");expect(await audit(s)).toHaveLength(2);
});
it("native ortho lifecycle cannot be overwritten and hidden ortho needs independent visibility",async()=>{
  const s=await scenario();await fx.pool.query("UPDATE clinical_cases SET specialty='orthodontics' WHERE id=$1",[s.caseId]);
  await expect(change("own",s)).rejects.toMatchObject({code:"case_status_capability_denied"});
  // This remains a general clinical case until linked to a native ortho record.
  await change("owner",s,"waiting");
  const ortho=Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id",[s.patientId])).rows[0].id);
  await fx.pool.query("UPDATE clinical_cases SET ortho_case_id=$1 WHERE id=$2",[ortho,s.caseId]);
  const snapshot=(await fx.pool.query("SELECT to_jsonb(o) saved FROM ortho_cases o WHERE id=$1",[ortho])).rows[0];
  const read=await reads.readCanonicalPatientCases(await fx.session("owner"),s.patientId);expect(read.cases.find(c=>c.id===s.caseId)?.version).toBeNull();
  await expect(change("owner",s,"closed","SYN", "a".repeat(64))).rejects.toMatchObject({code:"case_status_ortho_managed"});expect((await fx.pool.query("SELECT to_jsonb(o) saved FROM ortho_cases o WHERE id=$1",[ortho])).rows[0]).toEqual(snapshot);expect(await audit(s)).toHaveLength(1);
});
it("transition does not alter retained invoices, allocation or responsibilities",async()=>{
  const s=await scenario();const invoice=Number((await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,status,total_minor,base_currency,created_by) VALUES($1,$2,'cancelled',0,'YER','SYN') RETURNING id",[`SYN-CSW-INV-${s.caseId}`,s.patientId])).rows[0].id);
  await fx.pool.query("INSERT INTO invoice_items(invoice_id,description,plan_item_id) VALUES($1,'SYN retained source',$2)",[invoice,s.item]);
  const snapshot=async()=>(await fx.pool.query(`SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i) items,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) payments,(SELECT primary_doctor_id FROM patients WHERE id=$1) doctor,(SELECT responsible_party_id FROM clinical_cases WHERE id=$2) responsible`,[s.patientId,s.caseId])).rows;
  const before=await snapshot();await change("owner",s,"completed","SYN recorded result");expect(await snapshot()).toEqual(before);
});
it("audit failure rolls back the terminal status and outcome",async()=>{
  const s=await scenario();await fx.pool.query("CREATE FUNCTION syn_refuse_status_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='case.status' THEN RAISE EXCEPTION 'SYN status audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_refuse_status_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_refuse_status_audit()");
  try{await expect(change("owner",s,"completed","SYN result")).rejects.toThrow("SYN status audit unavailable");expect(await current(s)).toEqual({status:"active",outcome:null,completed_at:null});expect(await audit(s)).toEqual([]);}finally{await fx.pool.query("DROP TRIGGER syn_refuse_status_audit ON audit_log; DROP FUNCTION syn_refuse_status_audit()");}
});
it("uses one admitted connection without initialization or a rich post-commit reader",async()=>{
  const s=await scenario(),session=await fx.session("own"),saved=await version(s),pool=db.getPool();const connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),ensure=vi.spyOn(db,"ensureSchema"),rich=vi.spyOn(db,"getClinicalCase");
  try{await commands.commandCanonicalCaseStatus(session,String(s.caseId),{status:"waiting",outcome:null,expectedVersion:saved});expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();expect(rich).not.toHaveBeenCalled();}finally{connect.mockRestore();query.mockRestore();ensure.mockRestore();rich.mockRestore();}
});
it("two proven overlapping commands from one observed version commit one audit",async()=>{
  const s=await scenario(),saved=await version(s),sessions=[await fx.session("own"),await fx.session("all")],gate=await side.connect();let pending:Promise<unknown>[]=[];
  try{await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);
    pending=sessions.map((session,i)=>commands.commandCanonicalCaseStatus(session,String(s.caseId),{status:i?"closed":"waiting",outcome:"SYN",expectedVersion:saved}));pending.forEach(p=>{void p.catch(()=>undefined);});
    await vi.waitFor(async()=>{expect((await side.query(`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`,[pid])).rowCount).toBe(2);},{timeout:10000,interval:10});
    await gate.query("COMMIT");const results=await Promise.allSettled(pending);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"case_status_conflict"}});expect(await audit(s)).toHaveLength(1);
  }finally{await gate.query("ROLLBACK");gate.release();await Promise.allSettled(pending);}
});
it.each(["expire","scope"] as const)("%s while awaiting the patient lock cannot transition the case",async kind=>{
  const s=await scenario(),saved=await version(s),session=await fx.session("own",kind==="expire"?1500:60000),gate=await side.connect();let pending:Promise<unknown>|undefined;
  try{await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);pending=commands.commandCanonicalCaseStatus(session,String(s.caseId),{status:"completed",outcome:"SYN",expectedVersion:saved});void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);
    if(kind==="expire")await new Promise(r=>setTimeout(r,1700));else{await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[s.patientId]);await gate.query("UPDATE clinical_cases SET responsible_party_id=NULL WHERE patient_id=$1",[s.patientId]);}
    await gate.query("COMMIT");if(kind==="expire")await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);else await expect(pending).rejects.toMatchObject({code:"case_status_not_found"});expect((await current(s)).status).toBe("active");expect(await audit(s)).toEqual([]);
  }finally{await gate.query("ROLLBACK");gate.release();if(pending)await pending.catch(()=>undefined);}
});
it("permission revocation at the identity fence defeats an already signed request",async()=>{
  const s=await scenario(),saved=await version(s),session=await fx.session("all"),gate=await side.connect();let pending:Promise<unknown>|undefined;
  try{await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);await gate.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{"clinical.plans.view":true},patientScope:"all"},2)),fx.ids.all]);
    pending=commands.commandCanonicalCaseStatus(session,String(s.caseId),{status:"waiting",outcome:null,expectedVersion:saved});void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await gate.query("COMMIT");await expect(pending).rejects.toThrow(/STALE/);await expect(change("all",s)).rejects.toThrow(/CAPABILITY_DENIED/);expect(await audit(s)).toEqual([]);
  }finally{await gate.query("ROLLBACK");gate.release();if(pending)await pending.catch(()=>undefined);await fx.setGrants("all",EDIT,{patientScope:"all"});}
});
it("expiry during the audit rolls back an already executed status update",async()=>{
  const s=await scenario(),saved=await version(s),session=await fx.session("own",1500);
  await fx.pool.query("CREATE FUNCTION syn_delay_status_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='case.status' THEN PERFORM pg_sleep(1.8); END IF; RETURN NEW; END $$; CREATE TRIGGER syn_delay_status_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_delay_status_audit()");
  try{await expect(commands.commandCanonicalCaseStatus(session,String(s.caseId),{status:"completed",outcome:"SYN uncommitted result",expectedVersion:saved})).rejects.toThrow(/SESSION|EXPIRED/);expect(await current(s)).toEqual({status:"active",outcome:null,completed_at:null});expect(await audit(s)).toEqual([]);}finally{await fx.pool.query("DROP TRIGGER syn_delay_status_audit ON audit_log; DROP FUNCTION syn_delay_status_audit()");}
});
it("an inverse case lock fails closed without a deadlock or partial update",async()=>{
  const s=await scenario(),saved=await version(s),gate=await side.connect();
  try{await gate.query("BEGIN");await gate.query("SELECT id FROM clinical_cases WHERE id=$1 FOR UPDATE",[s.caseId]);await expect(change("own",s,"waiting",null,saved)).rejects.toMatchObject({code:"case_status_conflict"});expect(await audit(s)).toEqual([]);}finally{await gate.query("ROLLBACK");gate.release();}
});
