import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import type { CanonicalSnapshotQuery } from "../../lib/canonical-read-snapshot";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-problem-create-secret-0123456789");
const snapshots = await import("../../lib/canonical-read-snapshot");
const patientReads = await import("../../lib/canonical-patient-reads");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-problem-create-command"), reads = await import("../../lib/canonical-case-reads");
const EDIT = { "clinical.visits.document": true };
const ACCOUNTS = {
  owner: { username: "SYN-PCW-OWNER", role: "admin" },
  own: { username: "SYN-PCW-OWN", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
  all: { username: "SYN-PCW-ALL", role: "reception", patientScope: "all", grants: EDIT },
  none: { username: "SYN-PCW-NONE", role: "doctor", doctor: true, patientScope: "none", grants: EDIT },
  unlinked: { username: "SYN-PCW-UNLINKED", role: "doctor", patientScope: "own", grants: EDIT },
  planedit: { username: "SYN-PCW-PLANEDIT", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true, "clinical.plans.edit": true } },
  readonly: { username: "SYN-PCW-READ", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-PCW-${++seq}`, own ? fx.parties.own : null])).rows[0].id);
  return { ...await seedCanonicalPatientCases(fx.pool, patientId, own ? fx.parties.own : undefined), patientId };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const rows=async(s:Scenario)=>(await fx.pool.query("SELECT id,patient_id,label,site,specialty,status,case_id,noted_by,resolved_at,resolved_by FROM patient_problems WHERE patient_id=$1 ORDER BY id",[s.patientId])).rows;
const audit=async(s:Scenario)=>(await fx.pool.query("SELECT action,actor,details FROM audit_log WHERE entity_id=$1 AND action='problem.create' ORDER BY id",[String(s.patientId)])).rows;
const draft=(s:Scenario)=>({label:"SYN new clinical problem",site:"26",specialty:"endodontics",caseId:s.caseId});
const create=async(key:Key,s:Scenario,body:unknown=draft(s))=>commands.commandCanonicalProblemCreate(await fx.session(key),String(s.patientId),body);
it("owner/own/all documenters create; plan edit/read/none/unlinked do not",async()=>{
  for(const key of ["owner","own","all"] as const){const s=await scenario(),result=await create(key,s);expect(result).toEqual({ok:true,problemId:expect.any(Number)});expect((await rows(s)).find(r=>r.id===result.problemId)).toMatchObject({status:"active",noted_by:ACCOUNTS[key].username,resolved_at:null,resolved_by:null});expect(await audit(s)).toHaveLength(1);}
  const s=await scenario(),before=await rows(s);for(const key of ["none","readonly","planedit","unlinked"] as const)await expect(create(key,s)).rejects.toThrow(/SCOPE|CAPABILITY|UNLINKED/);expect(await rows(s)).toEqual(before);expect(await audit(s)).toEqual([]);
});
it("outside patient and missing patient are equivalent and do not create",async()=>{
  const s=await scenario(false);await expect(create("own",s)).rejects.toMatchObject({code:"problem_create_patient_not_found"});await expect(commands.commandCanonicalProblemCreate(await fx.session("own"),"2147483647",draft(s))).rejects.toMatchObject({code:"problem_create_patient_not_found"});expect(await audit(s)).toEqual([]);
});
it("preserves optional fields, exact maximal text and existing case status",async()=>{
  const s=await scenario();await fx.pool.query("UPDATE clinical_cases SET status='completed',completed_at=NOW() WHERE id=$1",[s.caseId]);const a=await create("own",s,{label:"ع".repeat(200),site:"س".repeat(60),specialty:null,caseId:null}),b=await create("own",s);expect((await rows(s)).find(r=>r.id===a.problemId)).toMatchObject({label:"ع".repeat(200),site:"س".repeat(60),specialty:null,case_id:null});expect((await rows(s)).find(r=>r.id===b.problemId)?.case_id).toBe(s.caseId);expect((await fx.pool.query("SELECT status FROM clinical_cases WHERE id=$1",[s.caseId])).rows[0].status).toBe("completed");
});
it("foreign or absent case is refused identically, even while the foreign case is locked",async()=>{
  const s=await scenario(),foreign=await scenario(false),gate=await side.connect();try{await gate.query("BEGIN");await gate.query("SELECT id FROM clinical_cases WHERE id=$1 FOR UPDATE",[foreign.caseId]);for(const caseId of [foreign.caseId,2147483647])await expect(create("all",s,{...draft(s),caseId})).rejects.toMatchObject({code:"problem_create_case_not_found"});expect(await audit(s)).toEqual([]);}finally{await gate.query("ROLLBACK");gate.release();}
});
it("hidden orthodontic case remains indistinguishable from missing even under a lock",async()=>{
  const s=await scenario(),gate=await side.connect();await fx.pool.query("UPDATE clinical_cases SET specialty='orthodontics' WHERE id=$1",[s.caseId]);try{await gate.query("BEGIN");await gate.query("SELECT id FROM clinical_cases WHERE id=$1 FOR UPDATE",[s.caseId]);await expect(create("all",s)).rejects.toMatchObject({code:"problem_create_case_not_found"});expect(await audit(s)).toEqual([]);}finally{await gate.query("ROLLBACK");gate.release();}
});
it("owner can document a linked ortho problem without changing its native case or responsibilities",async()=>{
  const s=await scenario(),ortho=Number((await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id",[s.patientId])).rows[0].id);await fx.pool.query("UPDATE clinical_cases SET specialty='orthodontics',ortho_case_id=$1 WHERE id=$2",[ortho,s.caseId]);
  const snapshot=async()=>(await fx.pool.query("SELECT (SELECT to_jsonb(c) FROM clinical_cases c WHERE id=$1) clinical,(SELECT to_jsonb(o) FROM ortho_cases o WHERE id=$2) ortho,(SELECT primary_doctor_id FROM patients WHERE id=$3) responsible",[s.caseId,ortho,s.patientId])).rows;const before=await snapshot();await create("owner",s,{...draft(s),specialty:"orthodontics"});expect(await snapshot()).toEqual(before);expect((await reads.readCanonicalPatientCases(await fx.session("own"),s.patientId)).problems.every(p=>p.caseId===null)).toBe(true);
});
it("same clinical text from two explicit concurrent intentions remains two legitimate records",async()=>{
  const s=await scenario(),sessions=[await fx.session("own"),await fx.session("all")],gate=await side.connect();let pending:Promise<{ok:true;problemId:number}>[]=[];
  try{await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);pending=sessions.map(session=>commands.commandCanonicalProblemCreate(session,String(s.patientId),draft(s)));pending.forEach(p=>{void p.catch(()=>undefined);});await vi.waitFor(async()=>expect((await side.query(`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`,[pid])).rowCount).toBe(2),{timeout:10000,interval:10});await gate.query("COMMIT");const results=await Promise.all(pending);expect(new Set(results.map(r=>r.problemId)).size).toBe(2);expect(await audit(s)).toHaveLength(2);
  }finally{await gate.query("ROLLBACK");gate.release();await Promise.allSettled(pending);}
});
it("creation cannot alter retained invoices, plan items or responsibility scope",async()=>{
  const s=await scenario(),invoice=Number((await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,status,total_minor,base_currency,created_by) VALUES($1,$2,'cancelled',0,'YER','SYN') RETURNING id",[`SYN-PCW-INV-${s.patientId}`,s.patientId])).rows[0].id);await fx.pool.query("INSERT INTO invoice_items(invoice_id,description,plan_item_id) VALUES($1,'SYN retained source',$2)",[invoice,s.item]);
  const snapshot=async()=>(await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i) lines,(SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM plan_items i) items,(SELECT primary_doctor_id FROM patients WHERE id=$1) doctor,(SELECT responsible_party_id FROM clinical_cases WHERE id=$2) responsible",[s.patientId,s.caseId])).rows;const before=await snapshot();await create("own",s);expect(await snapshot()).toEqual(before);
});
it("audit failure rolls back insertion",async()=>{
  const s=await scenario(),before=await rows(s);await fx.pool.query("CREATE FUNCTION syn_create_audit_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='problem.create' THEN RAISE EXCEPTION 'SYN create audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_create_audit_refuse BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_create_audit_refuse()");try{await expect(create("owner",s)).rejects.toThrow("SYN create audit unavailable");expect(await rows(s)).toEqual(before);expect(await audit(s)).toEqual([]);}finally{await fx.pool.query("DROP TRIGGER syn_create_audit_refuse ON audit_log; DROP FUNCTION syn_create_audit_refuse()");}
});
it("uses one connection and no initializer, pool read or rich postcommit reader",async()=>{
  const s=await scenario(),session=await fx.session("own"),pool=db.getPool();const connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),ensure=vi.spyOn(db,"ensureSchema"),rich=vi.spyOn(db,"listPatientProblems");try{await commands.commandCanonicalProblemCreate(session,String(s.patientId),draft(s));expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();expect(rich).not.toHaveBeenCalled();}finally{connect.mockRestore();query.mockRestore();ensure.mockRestore();rich.mockRestore();}
});
it.each(["expire","scope"] as const)("%s during patient-lock wait prevents creation",async kind=>{
  const s=await scenario(),before=await rows(s),session=await fx.session("own",kind==="expire"?1500:60000),gate=await side.connect();let pending:Promise<unknown>|undefined;
  try{await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);pending=commands.commandCanonicalProblemCreate(session,String(s.patientId),draft(s));void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);if(kind==="expire")await new Promise(r=>setTimeout(r,1700));else{await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[s.patientId]);await gate.query("UPDATE clinical_cases SET responsible_party_id=NULL WHERE patient_id=$1",[s.patientId]);}await gate.query("COMMIT");if(kind==="expire")await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);else await expect(pending).rejects.toMatchObject({code:"problem_create_patient_not_found"});expect(await rows(s)).toEqual(before);expect(await audit(s)).toEqual([]);}finally{await gate.query("ROLLBACK");gate.release();if(pending)await pending.catch(()=>undefined);}
});
it("revoked documentation grant at the identity fence defeats an already signed request",async()=>{
  const s=await scenario(),session=await fx.session("all"),gate=await side.connect();let pending:Promise<unknown>|undefined;try{await gate.query("BEGIN");const pid=(await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);await gate.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{"clinical.plans.view":true},patientScope:"all"},2)),fx.ids.all]);pending=commands.commandCanonicalProblemCreate(session,String(s.patientId),draft(s));void pending.catch(()=>undefined);expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);await gate.query("COMMIT");await expect(pending).rejects.toThrow(/STALE/);await expect(create("all",s)).rejects.toThrow(/CAPABILITY_DENIED/);expect(await audit(s)).toEqual([]);}finally{await gate.query("ROLLBACK");gate.release();if(pending)await pending.catch(()=>undefined);await fx.setGrants("all",EDIT,{patientScope:"all"});}
});
it("expiry after INSERT inside audit rolls back both effect and audit",async()=>{
  const s=await scenario(),before=await rows(s),session=await fx.session("own",1500);await fx.pool.query("CREATE FUNCTION syn_delay_create_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='problem.create' THEN PERFORM pg_sleep(1.8); END IF; RETURN NEW; END $$; CREATE TRIGGER syn_delay_create_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_delay_create_audit()");try{await expect(commands.commandCanonicalProblemCreate(session,String(s.patientId),draft(s))).rejects.toThrow(/SESSION|EXPIRED/);expect(await rows(s)).toEqual(before);expect(await audit(s)).toEqual([]);}finally{await fx.pool.query("DROP TRIGGER syn_delay_create_audit ON audit_log; DROP FUNCTION syn_delay_create_audit()");}
});
it("inverse visible-case lock refuses without inserting or hanging",async()=>{const s=await scenario(),gate=await side.connect();try{await gate.query("BEGIN");await gate.query("SELECT id FROM clinical_cases WHERE id=$1 FOR UPDATE",[s.caseId]);await expect(create("all",s)).rejects.toMatchObject({code:"problem_create_conflict"});expect(await audit(s)).toEqual([]);}finally{await gate.query("ROLLBACK");gate.release();}});

it("problem list keeps authorized clinical facts while masking independent ortho association",async()=>{
  const s=await scenario();await fx.pool.query("UPDATE clinical_cases SET specialty='orthodontics',title='SYN hidden ortho title' WHERE id=$1",[s.caseId]);const created=await create("owner",s);const own=await patientReads.readCanonicalProblems(await fx.session("own"),s.patientId),owner=await patientReads.readCanonicalProblems(await fx.session("owner"),s.patientId);expect(own.find(p=>p.id===created.problemId)).toMatchObject({label:draft(s).label,caseId:null,caseTitle:null});expect(JSON.stringify(own)).not.toContain("SYN hidden ortho title");expect(owner.find(p=>p.id===created.problemId)).toMatchObject({caseId:s.caseId,caseTitle:"SYN hidden ortho title"});
  const legacy=await db.listPatientProblemsWith(fx.pool,s.patientId);expect(legacy.find(p=>p.id===created.problemId)?.caseTitle).toBe("SYN hidden ortho title");
});
it("canonical problem list fails closed on a retained foreign case reference",async()=>{
  const s=await scenario(),foreign=await scenario(false);await fx.pool.query("UPDATE patient_problems SET case_id=$1 WHERE id=$2",[foreign.caseId,s.problemId]);await expect(patientReads.readCanonicalProblems(await fx.session("owner"),s.patientId)).rejects.toThrow("STAFF_READ_READ_FAILED");
});
it("problem list source reference and projection share one readonly snapshot",async()=>{
  const s=await scenario(),session=await fx.session("own"),pool=db.getPool();const connect=vi.spyOn(pool,"connect"),query=vi.spyOn(pool,"query"),ensure=vi.spyOn(db,"ensureSchema");try{const result=await patientReads.readCanonicalProblems(session,s.patientId);expect(result.find(p=>p.id===s.problemId)?.caseTitle).toBe("SYN root case");expect(connect).toHaveBeenCalledTimes(1);expect(query).not.toHaveBeenCalled();expect(ensure).not.toHaveBeenCalled();}finally{connect.mockRestore();query.mockRestore();ensure.mockRestore();}
});

it("reference checks and ortho projection stay in one RR readonly snapshot across a commit",async()=>{
  const s=await scenario(),session=await fx.session("own"),original=snapshots.runCanonicalReadSnapshot;let changed=false;
  const hook=vi.spyOn(snapshots,"runCanonicalReadSnapshot").mockImplementationOnce((admission,key,reader,options)=>original(admission,key,(q,scope)=>reader({query:(async(text:string,args?:unknown[])=>{
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");expect(text).not.toMatch(/\b(invoices|payments|legacy_treatment_agreements)\b/);const result=await q.query(text,args);
    if(!changed&&text.includes("AS invalid")){changed=true;await side.query("UPDATE clinical_cases SET specialty='orthodontics',title='SYN newly hidden association' WHERE id=$1",[s.caseId]);}return result;
  }) as CanonicalSnapshotQuery["query"]},scope),options));
  try{const snapshot=await patientReads.readCanonicalProblems(session,s.patientId);expect(changed).toBe(true);expect(snapshot.find(p=>p.id===s.problemId)).toMatchObject({caseId:s.caseId,caseTitle:"SYN root case"});hook.mockRestore();expect((await patientReads.readCanonicalProblems(session,s.patientId)).find(p=>p.id===s.problemId)).toMatchObject({caseId:null,caseTitle:null});}finally{hook.mockRestore();}
});
