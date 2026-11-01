import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-problem-status-secret-0123456789");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-problem-status-command"), reads = await import("../../lib/canonical-case-reads");
const EDIT = { "clinical.visits.document": true };
const ACCOUNTS = {
  owner: { username: "SYN-PSW-OWNER", role: "admin" },
  own: { username: "SYN-PSW-OWN", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
  all: { username: "SYN-PSW-ALL", role: "reception", patientScope: "all", grants: EDIT },
  none: { username: "SYN-PSW-NONE", role: "doctor", doctor: true, patientScope: "none", grants: EDIT },
  unlinked: { username: "SYN-PSW-UNLINKED", role: "doctor", patientScope: "own", grants: EDIT },
  planedit: { username: "SYN-PSW-PLANEDIT", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true, "clinical.plans.edit": true } },
  readonly: { username: "SYN-PSW-READ", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-PSW-${++seq}`, own ? fx.parties.own : null])).rows[0].id);
  return { ...await seedCanonicalPatientCases(fx.pool, patientId, own ? fx.parties.own : undefined), patientId };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const current = async (s: Scenario) => (await fx.pool.query("SELECT status,resolved_at,resolved_by FROM patient_problems WHERE id=$1",[s.problemId])).rows[0];
const audit = async (s: Scenario) => (await fx.pool.query("SELECT action,actor,details FROM audit_log WHERE entity_id=$1 AND action='problem.status' ORDER BY id",[String(s.patientId)])).rows;
const version = async (s: Scenario,key:Key="owner") => (await reads.readCanonicalPatientCases(await fx.session(key),s.patientId)).problems.find(p=>p.id===s.problemId)!.version;
const change = async (key:Key,s:Scenario,status="resolved",saved?:string) => commands.commandCanonicalProblemStatus(await fx.session(key),String(s.problemId),{status,expectedVersion:saved??await version(s)});
it("owner/own/all are admitted, independently of plan-edit; none/read/unlinked fail closed",async()=>{
  for(const key of ["owner","own","all"] as const){const s=await scenario();expect(await change(key,s)).toMatchObject({status:"resolved"});expect(await audit(s)).toHaveLength(1);}
  const s=await scenario();for(const key of ["none","readonly","planedit","unlinked"] as const)await expect(change(key,s)).rejects.toThrow(/SCOPE|CAPABILITY|UNLINKED/);expect(await audit(s)).toEqual([]);
});
it("outside and absent problems are indistinguishable without mutation",async()=>{
  const s=await scenario(false);await expect(change("own",s)).rejects.toMatchObject({code:"problem_status_not_found"});await expect(commands.commandCanonicalProblemStatus(await fx.session("own"),"2147483647",{status:"resolved",expectedVersion:"a".repeat(64)})).rejects.toMatchObject({code:"problem_status_not_found"});expect(await audit(s)).toEqual([]);
});
it.each([...["resolved","inactive"].map(to=>["active",to]),...["active","inactive"].map(to=>["resolved",to]),...["active","resolved"].map(to=>["inactive",to])])("preserves legitimate %s → %s and resolution provenance",async(from,to)=>{
  const s=await scenario();if(from!=="active")await change("owner",s,from);const n=(await audit(s)).length;await change("own",s,to);
  const row=await current(s);expect(row.status).toBe(to);expect(row.resolved_at===null).toBe(to!=="resolved");expect(row.resolved_by).toBe(to==="resolved"?ACCOUNTS.own.username:null);expect(await audit(s)).toHaveLength(n+1);
});
it("unchanged state refuses and active→resolved→active invalidates an old intent",async()=>{
  const s=await scenario(),old=await version(s);await expect(change("own",s,"active",old)).rejects.toMatchObject({code:"problem_status_unchanged"});await change("own",s,"resolved",old);await change("own",s,"active");await expect(change("own",s,"inactive",old)).rejects.toMatchObject({code:"problem_status_conflict"});expect(await audit(s)).toHaveLength(2);
});
it("updating a visible problem leaves its case, native ortho, references and balances untouched",async()=>{
  const s=await scenario();const ortho=Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id",[s.patientId])).rows[0].id);await fx.pool.query("UPDATE clinical_cases SET specialty='orthodontics',ortho_case_id=$1 WHERE id=$2",[ortho,s.caseId]);
  const snapshot=async()=>(await fx.pool.query(`SELECT (SELECT to_jsonb(c) FROM clinical_cases c WHERE id=$1) clinical,(SELECT to_jsonb(o) FROM ortho_cases o WHERE id=$2) ortho,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) payments`,[s.caseId,ortho])).rows;
  const invoice=Number((await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,status,total_minor,base_currency,created_by) VALUES($1,$2,'cancelled',0,'YER','SYN') RETURNING id",[`SYN-PSW-INV-${s.problemId}`,s.patientId])).rows[0].id);
  await fx.pool.query("INSERT INTO invoice_items(invoice_id,description,plan_item_id) VALUES($1,'SYN retained source',$2)",[invoice,s.item]);
  const before=await snapshot(),feed=await reads.readCanonicalPatientCases(await fx.session("own"),s.patientId);expect(feed.cases).toEqual([]);expect(feed.problems[0].caseId).toBeNull();expect(JSON.stringify(feed)).not.toMatch(/versionXmin|versionTid/);await change("own",s);expect(await snapshot()).toEqual(before);expect((await fx.pool.query("SELECT case_id FROM patient_problems WHERE id=$1",[s.problemId])).rows[0].case_id).toBe(s.caseId);
});
it("audit failure rolls back status and resolution provenance",async()=>{
  const s=await scenario();await fx.pool.query("CREATE FUNCTION syn_problem_audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='problem.status' THEN RAISE EXCEPTION 'SYN problem audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_problem_audit_refuse BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_problem_audit_refuse()");
  try{await expect(change("owner",s)).rejects.toThrow("SYN problem audit unavailable");expect(await current(s)).toEqual({status:"active",resolved_at:null,resolved_by:null});expect(await audit(s)).toEqual([]);}finally{await fx.pool.query("DROP TRIGGER syn_problem_audit_refuse ON audit_log; DROP FUNCTION syn_problem_audit_refuse()");}
});
it("uses one admitted connection without initializer or rich postcommit read",async()=>{
  const s=await scenario(),session=await fx.session("own"),saved=await version(s),pool=db.getPool();const connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),ensure=vi.spyOn(db,"ensureSchema"),rich=vi.spyOn(db,"listPatientProblems");
  try{await commands.commandCanonicalProblemStatus(session,String(s.problemId),{status:"resolved",expectedVersion:saved});expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();expect(rich).not.toHaveBeenCalled();}finally{connect.mockRestore();query.mockRestore();ensure.mockRestore();rich.mockRestore();}
});
it("two genuinely overlapping commands commit one transition and audit",async()=>{
  const s=await scenario(),saved=await version(s),sessions=[await fx.session("own"),await fx.session("all")],gate=await side.connect();let pending:Promise<unknown>[]=[];
  try{await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);pending=sessions.map((session,i)=>commands.commandCanonicalProblemStatus(session,String(s.problemId),{status:i?"inactive":"resolved",expectedVersion:saved}));pending.forEach(p=>{void p.catch(()=>undefined);});
    await vi.waitFor(async()=>expect((await side.query(`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`,[pid])).rowCount).toBe(2),{timeout:10000,interval:10});
    await gate.query("COMMIT");const results=await Promise.allSettled(pending);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"problem_status_conflict"}});expect(await audit(s)).toHaveLength(1);
  }finally{await gate.query("ROLLBACK");gate.release();await Promise.allSettled(pending);}
});
it.each(["expire","scope"] as const)("%s during patient-lock wait refuses without effect",async kind=>{
  const s=await scenario(),saved=await version(s),session=await fx.session("own",kind==="expire"?1500:60000),gate=await side.connect();let pending:Promise<unknown>|undefined;
  try{await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);pending=commands.commandCanonicalProblemStatus(session,String(s.problemId),{status:"resolved",expectedVersion:saved});void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);
    if(kind==="expire")await new Promise(r=>setTimeout(r,1700));else{await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[s.patientId]);await gate.query("UPDATE clinical_cases SET responsible_party_id=NULL WHERE patient_id=$1",[s.patientId]);}
    await gate.query("COMMIT");if(kind==="expire")await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);else await expect(pending).rejects.toMatchObject({code:"problem_status_not_found"});expect((await current(s)).status).toBe("active");expect(await audit(s)).toEqual([]);
  }finally{await gate.query("ROLLBACK");gate.release();if(pending)await pending.catch(()=>undefined);}
});
it("revocation at the identity fence defeats a signed pending command",async()=>{
  const s=await scenario(),saved=await version(s),session=await fx.session("all"),gate=await side.connect();let pending:Promise<unknown>|undefined;
  try{await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);await gate.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{"clinical.plans.view":true},patientScope:"all"},2)),fx.ids.all]);pending=commands.commandCanonicalProblemStatus(session,String(s.problemId),{status:"resolved",expectedVersion:saved});void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await gate.query("COMMIT");await expect(pending).rejects.toThrow(/STALE/);await expect(change("all",s)).rejects.toThrow(/CAPABILITY_DENIED/);expect(await audit(s)).toEqual([]);
  }finally{await gate.query("ROLLBACK");gate.release();if(pending)await pending.catch(()=>undefined);await fx.setGrants("all",EDIT,{patientScope:"all"});}
});
it("expiry after UPDATE during audit rolls back all stored changes",async()=>{
  const s=await scenario(),saved=await version(s),session=await fx.session("own",1500);await fx.pool.query("CREATE FUNCTION syn_delay_problem_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='problem.status' THEN PERFORM pg_sleep(1.8); END IF; RETURN NEW; END $$; CREATE TRIGGER syn_delay_problem_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_delay_problem_audit()");
  try{await expect(commands.commandCanonicalProblemStatus(session,String(s.problemId),{status:"resolved",expectedVersion:saved})).rejects.toThrow(/SESSION|EXPIRED/);expect(await current(s)).toEqual({status:"active",resolved_at:null,resolved_by:null});expect(await audit(s)).toEqual([]);}finally{await fx.pool.query("DROP TRIGGER syn_delay_problem_audit ON audit_log; DROP FUNCTION syn_delay_problem_audit()");}
});
it("inverse problem lock fails boundedly without partial mutation",async()=>{
  const s=await scenario(),saved=await version(s),gate=await side.connect();try{await gate.query("BEGIN");await gate.query("SELECT id FROM patient_problems WHERE id=$1 FOR UPDATE",[s.problemId]);await expect(change("own",s,"resolved",saved)).rejects.toMatchObject({code:"problem_status_conflict"});expect(await audit(s)).toEqual([]);}finally{await gate.query("ROLLBACK");gate.release();}
});

it("a row-only lock does not invalidate a legitimate comparison version",async()=>{
  const s=await scenario(),saved=await version(s),gate=await side.connect();try{await gate.query("BEGIN");await gate.query("SELECT id FROM patient_problems WHERE id=$1 FOR UPDATE",[s.problemId]);await gate.query("COMMIT");expect(await version(s)).toBe(saved);expect(await change("own",s,"resolved",saved)).toMatchObject({status:"resolved"});}finally{await gate.query("ROLLBACK");gate.release();}
});
