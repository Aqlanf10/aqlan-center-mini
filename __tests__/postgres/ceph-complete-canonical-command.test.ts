import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { REQUIRED_LANDMARKS, computeAll, type LandmarkMap } from "../../lib/ceph";
import { seedCanonicalCeph } from "../fixtures/canonical-ceph";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-ceph-complete-secret-0123456789");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-ceph-complete-command"), reads = await import("../../lib/canonical-ceph-reads");
const ANALYZE = { "clinical.xrays.view": true, "clinical.ceph.analyze": true };
const ACCOUNTS = {
  owner: { username: "SYN-CCP-OWNER", role: "admin" },
  own: { username: "SYN-CCP-OWN", role: "doctor", doctor: true, patientScope: "own", grants: ANALYZE },
  all: { username: "SYN-CCP-ALL", role: "reception", patientScope: "all", grants: ANALYZE },
  none: { username: "SYN-CCP-NONE", role: "doctor", doctor: true, patientScope: "none", grants: ANALYZE },
  unlinked: { username: "SYN-CCP-UNLINKED", role: "doctor", patientScope: "own", grants: ANALYZE },
  read: { username: "SYN-CCP-READ", role: "admin", patientScope: "all", grants: { "clinical.xrays.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-CCP-${++seq}`, own ? fx.parties.own : null])).rows[0].id as number;
  const s = await seedCanonicalCeph(fx.pool, { patientId, status: "draft" });
  await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'SYN_OLD_CODE',1.25,2.75,'manual','SYN original')", [s.id]);
  await fx.pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'SYN_STORED',42.125)", [s.id]);
  await fx.pool.query("INSERT INTO ceph_diagnoses(analysis_id,final_dx,created_by) VALUES($1,'SYN original draft','SYN original')", [s.id]);
  await fx.pool.query("UPDATE ceph_analyses SET cal_x1=0,cal_y1=0,cal_x2=100,cal_y2=0,cal_mm=50,mm_per_pixel=0.5 WHERE id=$1", [s.id]);
  for (const [i, code] of REQUIRED_LANDMARKS.entries()) await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,$2,$3,$4,'manual','SYN')", [s.id, code, 40+(i*37)%400,30+(i*53)%380]);
  await fx.pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) VALUES($1,'ANB',99)",[s.id]);
  return s;
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
async function body(s: Scenario) { return { expectedVersion: (await reads.readCanonicalCephStudy(await fx.session("owner"), s.id)).discardVersion! }; }
const complete = async (key: Key, s: Scenario, input: unknown) => commands.commandCanonicalCephComplete(await fx.session(key), String(s.id), input);
const audits = async (s: Scenario) => (await fx.pool.query("SELECT action,actor,actor_role,summary FROM audit_log WHERE action='ceph.complete' AND entity_id=$1 ORDER BY id", [String(s.id)])).rows;
const snapshot = async (s: Scenario) => (await fx.pool.query("SELECT (SELECT to_jsonb(a) FROM ceph_analyses a WHERE id=$1) study,(SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM ceph_landmarks l WHERE analysis_id=$1) landmarks,(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM ceph_measurements m WHERE analysis_id=$1) measurements,(SELECT to_jsonb(d) FROM ceph_diagnoses d WHERE analysis_id=$1) diagnosis", [s.id])).rows[0];
it("own, all and protected owner seal precisely the existing engine outputs and one atomic audit", async () => {
  for (const key of ["own","all","owner"] as const) {
    const s=await scenario(), input=await body(s), before=await snapshot(s), map:LandmarkMap={};
    for (const [i,code] of REQUIRED_LANDMARKS.entries()) map[code]={x:40+(i*37)%400,y:30+(i*53)%380};
    const expected=computeAll(map,0.5).filter(r=>r.value!==null).map(r=>({code:r.code,value:r.value===0?0:r.value})).sort((a,b)=>a.code.localeCompare(b.code));
    expect(await complete(key,s,input)).toEqual({ok:true,studyId:s.id,status:"completed"}); const after=await snapshot(s);
    expect(after.study).toMatchObject({...before.study,status:"completed",completed_by:ACCOUNTS[key].username,completed_at:expect.any(String)});
    expect(after.landmarks).toEqual(before.landmarks); expect(after.diagnosis).toEqual(before.diagnosis);
    const rows=after.measurements.filter((m:{code:string})=>m.code!=="SYN_STORED").map((m:{code:string;value:number})=>({code:m.code,value:m.value})).sort((a:{code:string},b:{code:string})=>a.code.localeCompare(b.code));
    expect(rows).toEqual(expected); expect(after.measurements.find((m:{code:string})=>m.code==="SYN_STORED")).toEqual(before.measurements.find((m:{code:string})=>m.code==="SYN_STORED"));
    expect(await audits(s)).toMatchObject([{action:"ceph.complete",actor:ACCOUNTS[key].username}]);
    await expect(complete(key,s,input)).rejects.toMatchObject({code:"ceph_complete_conflict"});expect(await audits(s)).toHaveLength(1);
  }
});
it.each(["calibration","missing-landmark","stale-measurement"] as const)("%s blocks approval without deleting saved values or rewriting diagnosis",async kind=>{
  const s=await scenario();
  if(kind==="calibration")await fx.pool.query("UPDATE ceph_analyses SET mm_per_pixel=NULL WHERE id=$1",[s.id]);
  if(kind==="missing-landmark")await fx.pool.query("DELETE FROM ceph_landmarks WHERE analysis_id=$1 AND code='S'",[s.id]);
  if(kind==="stale-measurement")await fx.pool.query("UPDATE ceph_landmarks SET x=1,y=1 WHERE analysis_id=$1",[s.id]);
  const input=await body(s),before=await snapshot(s);
  await expect(complete("own",s,input)).rejects.toMatchObject({code:"ceph_complete_conditions"});expect(await snapshot(s)).toEqual(before);expect(await audits(s)).toEqual([]);
});
it("a late audit failure or expired authority rolls back stamped measurements and approval together",async()=>{
  for(const delay of [false,true]){
    const s=await scenario(),input=await body(s),before=await snapshot(s),session=await fx.session("own",delay?1500:60000);
    await fx.pool.query(`CREATE FUNCTION syn_ceph_complete_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ceph.complete' THEN ${delay?"PERFORM pg_sleep(1.8)":"RAISE EXCEPTION 'SYN completion audit refused'"}; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_ceph_complete_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_ceph_complete_audit()`);
    try { await expect(commands.commandCanonicalCephComplete(session,String(s.id),input)).rejects.toThrow(delay?/SESSION|EXPIRED/:/SYN completion audit refused/);expect(await snapshot(s)).toEqual(before);expect(await audits(s)).toEqual([]); }
    finally {await fx.pool.query("DROP TRIGGER syn_ceph_complete_audit ON audit_log; DROP FUNCTION syn_ceph_complete_audit()");}
  }
});
it("retained unavailable image keeps its reference semantics without restoring or revealing image bytes",async()=>{
  const s=await scenario();await fx.pool.query("UPDATE patient_documents SET removed_at=NOW(),mime_type='application/octet-stream' WHERE id=$1",[s.documentId]);const before=(await fx.pool.query("SELECT to_jsonb(d) value FROM patient_documents d WHERE id=$1",[s.documentId])).rows;
  expect(await complete("own",s,await body(s))).toMatchObject({status:"completed"});expect((await fx.pool.query("SELECT to_jsonb(d) value FROM patient_documents d WHERE id=$1",[s.documentId])).rows).toEqual(before);
});
it("approval does not exceed the established saved-study measurement budget",async()=>{
 const s=await scenario();await fx.pool.query("INSERT INTO ceph_measurements(analysis_id,code,value) SELECT $1,'SYN_BOUND_'||n,1 FROM generate_series(1,254)n",[s.id]);const input=await body(s),before=await snapshot(s);await expect(complete("own",s,input)).rejects.toMatchObject({code:"ceph_complete_conflict"});expect(await snapshot(s)).toEqual(before);expect(await audits(s)).toEqual([]);
});
it.each(["read", "none", "unlinked"] as const)("%s cannot turn a draft observation into write authority", async key => { const s = await scenario(), before = await snapshot(s); await expect(complete(key, s, await body(s))).rejects.toThrow(/SCOPE|CAPABILITY|UNLINKED/); expect(await snapshot(s)).toEqual(before); expect(await audits(s)).toEqual([]); });

it("foreign and absent studies remain indistinguishable", async () => { const s = await scenario(false), input = await body(s); await expect(complete("own", s, input)).rejects.toMatchObject({ code: "ceph_complete_not_found" }); await expect(commands.commandCanonicalCephComplete(await fx.session("own"), "2147483647", input)).rejects.toMatchObject({ code: "ceph_complete_not_found" }); expect(await audits(s)).toEqual([]); });

it.each(["completed", "discarded"] as const)("%s study stays byte-for-byte unchanged despite a former draft observation", async status => { const s = await scenario(), input = await body(s); await fx.pool.query("UPDATE ceph_analyses SET status=$1 WHERE id=$2", [status, s.id]); const before = await snapshot(s); await expect(complete("owner", s, input)).rejects.toMatchObject({ code: status === "completed" ? "ceph_complete_conflict" : "ceph_complete_not_found" }); expect(await snapshot(s)).toEqual(before); expect(await audits(s)).toEqual([]); });

it.each(["parent", "landmark", "measurement", "diagnosis", "child-add", "child-remove"] as const)("%s change defeats a stale edit without touching the newer data", async kind => {
  const s = await scenario(), input = await body(s);
  if (kind === "parent") await fx.pool.query("UPDATE ceph_analyses SET note=note WHERE id=$1", [s.id]);
  if (kind === "landmark") await fx.pool.query("UPDATE ceph_landmarks SET x=x+1 WHERE analysis_id=$1", [s.id]);
  if (kind === "measurement") await fx.pool.query("UPDATE ceph_measurements SET value=value+1 WHERE analysis_id=$1", [s.id]);
  if (kind === "diagnosis") await fx.pool.query("UPDATE ceph_diagnoses SET final_dx='SYN changed' WHERE analysis_id=$1", [s.id]);
  if (kind === "child-add") await fx.pool.query("INSERT INTO ceph_landmarks(analysis_id,code,x,y,source,confirmed_by) VALUES($1,'SYN_ADDED',1,2,'manual','SYN')", [s.id]);
  if (kind === "child-remove") await fx.pool.query("DELETE FROM ceph_landmarks WHERE analysis_id=$1", [s.id]);
  const before = await snapshot(s); await expect(complete("own", s, input)).rejects.toMatchObject({ code: "ceph_complete_conflict" }); expect(await snapshot(s)).toEqual(before); expect(await audits(s)).toEqual([]);
});

it("two requests actually waiting on the patient produce one set of changes and audit events", async () => {
  const s = await scenario(), input = await body(s), sessions = [await fx.session("own"), await fx.session("all")], gate = await side.connect(); let pending: Promise<unknown>[] = [];
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]); pending = sessions.map(session => commands.commandCanonicalCephComplete(session, String(s.id), input)); pending.forEach(p => { void p.catch(() => undefined); });
    await vi.waitFor(async () => expect((await side.query("WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked", [pid])).rowCount).toBe(2), { timeout: 10000, interval: 10 }); await gate.query("COMMIT"); const outcomes = await Promise.allSettled(pending); expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1); expect(outcomes.filter(o => o.status === "rejected")).toMatchObject([{ reason: { code: "ceph_complete_conflict" } }]); expect(await audits(s)).toHaveLength(1);
  } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(pending); }
});

it.each(["expire", "scope", "complete", "child"] as const)("%s during the patient wait is freshly checked", async kind => {
  const s = await scenario(), input = await body(s), session = await fx.session("own", kind === "expire" ? 1500 : 60000), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]); pending = commands.commandCanonicalCephComplete(session, String(s.id), input); void pending.catch(() => undefined); await waitForBlockedBy(side, pid);
    if (kind === "expire") await new Promise(r => setTimeout(r, 1700));
    if (kind === "scope") await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]);
    if (kind === "complete") await gate.query("UPDATE ceph_analyses SET status='completed' WHERE id=$1", [s.id]);
    if (kind === "child") await gate.query("UPDATE ceph_landmarks SET y=y+1 WHERE analysis_id=$1", [s.id]);
    await gate.query("COMMIT"); if (kind === "expire") await expect(pending).rejects.toThrow(/SESSION|EXPIRED/); else await expect(pending).rejects.toBeInstanceOf(commands.CanonicalCephCompleteRefusal); expect(await audits(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); }
});

it.each(["study", "document", "landmark", "measurement", "diagnosis"] as const)("inversely ordered %s lock fails closed without deadlock", async kind => {
  const s = await scenario(), input = await body(s), before = await snapshot(s), gate = await side.connect();
  const sql = { study: "SELECT id FROM ceph_analyses WHERE id=$1 FOR UPDATE", document: "SELECT id FROM patient_documents WHERE id=$1 FOR UPDATE", landmark: "SELECT id FROM ceph_landmarks WHERE analysis_id=$1 FOR UPDATE", measurement: "SELECT id FROM ceph_measurements WHERE analysis_id=$1 FOR UPDATE", diagnosis: "SELECT analysis_id FROM ceph_diagnoses WHERE analysis_id=$1 FOR UPDATE" };
  try { await gate.query("BEGIN"); await gate.query(sql[kind], [kind === "document" ? s.documentId : s.id]); await expect(complete("all", s, input)).rejects.toMatchObject({ code: "ceph_complete_conflict" }); expect(await snapshot(s)).toEqual(before); }
  finally { await gate.query("ROLLBACK"); gate.release(); }
});

it.each(["document", "ortho"] as const)("foreign %s cannot be used as a clinical write reference", async kind => { const s = await scenario(), other = await scenario(false), input = await body(s); const id = kind === "document" ? other.documentId : (await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [other.patientId])).rows[0].id; await fx.pool.query(`UPDATE ceph_analyses SET ${kind === "document" ? "document_id" : "ortho_case_id"}=$1 WHERE id=$2`, [id, s.id]); const before = await snapshot(s); await expect(complete("all", s, input)).rejects.toMatchObject({ code: "ceph_complete_reference_invalid" }); expect(await snapshot(s)).toEqual(before); });

it("a revoked analysis capability is not restored by an old signed intent", async () => {
  const s = await scenario(), input = await body(s), session = await fx.session("all"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan.canonical.identity.substrate.v1:public',0))"); await gate.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: { "clinical.xrays.view": true }, patientScope: "all" }, 2)), fx.ids.all]); pending = commands.commandCanonicalCephComplete(session, String(s.id), input); void pending.catch(() => undefined); await waitForBlockedBy(side, pid); await gate.query("COMMIT"); await expect(pending).rejects.toThrow(/STALE/); await expect(complete("all", s, input)).rejects.toThrow(/CAPABILITY/); expect(await audits(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); await fx.setGrants("all", ANALYZE, { patientScope: "all" }); }
});

it("one admitted connection leaves nonempty finance, assignment and approved sibling history unchanged", async () => {
  const s = await scenario(), approved = await seedCanonicalCeph(fx.pool, { patientId: s.patientId }); await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by) VALUES($1,$2,76543,'USD','SYN')", [`SYN-CED-FIN-${s.id}`, s.patientId]);
  const unchanged = async () => (await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT primary_doctor_id FROM patients WHERE id=$1) doctor,(SELECT to_jsonb(d) FROM patient_documents d WHERE id=$2) document", [s.patientId, s.documentId])).rows;
  const before = await unchanged(), approvedBefore = await snapshot(approved), input = await body(s), session = await fx.session("own"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  try { await commands.commandCanonicalCephComplete(session, String(s.id), input); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
  expect(await unchanged()).toEqual(before); expect(await snapshot(approved)).toEqual(approvedBefore);
});

