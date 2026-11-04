import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-plan-dependency-secret-0123456789");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-plan-dependency-command"), reads = await import("../../lib/canonical-case-reads");
const EDIT = { "clinical.plans.view": true, "clinical.plans.edit": true };
const ACCOUNTS = {
  owner: { username: "SYN-PDW-OWNER", role: "admin" },
  own: { username: "SYN-PDW-OWN", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
  all: { username: "SYN-PDW-ALL", role: "reception", patientScope: "all", grants: EDIT },
  none: { username: "SYN-PDW-NONE", role: "doctor", doctor: true, patientScope: "none", grants: EDIT },
  unlinked: { username: "SYN-PDW-UNLINKED", role: "doctor", patientScope: "own", grants: EDIT },
  readonly: { username: "SYN-PDW-READ", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-PDW-${++seq}`, own ? fx.parties.own : null])).rows[0].id);
  const saved = await seedCanonicalPatientCases(fx.pool, patientId, own ? fx.parties.own : undefined);
  const next = Number((await fx.pool.query("INSERT INTO plan_items(plan_id,service_name) VALUES($1,'SYN next dependency item') RETURNING id", [saved.plan])).rows[0].id);
  return { ...saved, patientId, next };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const add = async (key: Key, s: Scenario, item = s.next, requires = s.item) => commands.commandCanonicalPlanDependency(await fx.session(key), "add", String(item), { requiresItemId: requires, requirement: "clearance", note: "SYN clinical dependency" });
const feed = async (s: Scenario) => reads.readCanonicalPatientCases(await fx.session("owner"), s.patientId);
const remove = async (key: Key, s: Scenario, version: string) => commands.commandCanonicalPlanDependency(await fx.session(key), "remove", String(s.item), { requiresItemId: s.prerequisite, expectedVersion: version });
const version = async (s: Scenario) => (await feed(s)).dependencies.find(d => d.itemId === s.item && d.requiresItemId === s.prerequisite)!.version;
const audit = async (s: Scenario) => (await fx.pool.query("SELECT action,actor FROM audit_log WHERE action IN ('plan.dependency_add','plan.dependency_remove') AND entity_id=$1 ORDER BY id", [String(s.patientId)])).rows;
const present = async (s: Scenario) => (await fx.pool.query("SELECT 1 FROM plan_item_dependencies WHERE item_id=$1 AND requires_item_id=$2", [s.item, s.prerequisite])).rows.length === 1;
it.each(["owner", "own", "all"] as const)("%s adds and removes with independent plan authority and real atomic actors", async key => {
  const s = await scenario(); expect(await add(key, s)).toEqual({ ok: true, itemId: s.next, requiresItemId: s.item });
  expect(await remove(key, s, await version(s))).toEqual({ ok: true, itemId: s.item, requiresItemId: s.prerequisite }); expect(await present(s)).toBe(false);
  expect(await audit(s)).toEqual([{ action: "plan.dependency_add", actor: ACCOUNTS[key].username }, { action: "plan.dependency_remove", actor: ACCOUNTS[key].username }]);
});
it.each(["none", "unlinked", "readonly"] as const)("refuses %s for both graph operations", async key => {
  const s = await scenario(); await expect(add(key, s)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/);
  await expect(remove(key, s, await version(s))).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/); expect(await audit(s)).toEqual([]); expect(await present(s)).toBe(true);
});
it("outside and missing source/target are indistinguishable and neither creates a scope witness", async () => {
  const s = await scenario(), other = await scenario(false), errors = [];
  for (const requires of [other.item, 2147483647]) try { await add("own", s, s.next, requires); throw Error("unexpected"); } catch (e) { errors.push({ code: (e as { code: string }).code, message: (e as Error).message }); }
  expect(errors[0]).toEqual(errors[1]); expect(errors[0].code).toBe("plan_dependency_not_found"); await expect(add("own", other)).rejects.toMatchObject({ code: "plan_dependency_not_found" }); expect(await audit(s)).toEqual([]);
});
it("duplicate add and a reverse cycle refuse without extra audit; cancelled plans remain legitimate endpoints", async () => {
  const s = await scenario(); await fx.pool.query("UPDATE treatment_plans SET status='cancelled' WHERE id=$1", [s.plan]); await add("own", s);
  await expect(add("own", s)).rejects.toMatchObject({ code: "plan_dependency_conflict" });
  await expect(add("own", s, s.prerequisite, s.next)).rejects.toMatchObject({ code: "plan_dependency_cycle" }); expect(await audit(s)).toHaveLength(1);
});
it("an old deletion cannot remove a recreated identical edge, even in the same transaction timestamp", async () => {
  const s = await scenario(); let old = "";
  await fx.pool.query("BEGIN");
  try {
    await fx.pool.query("UPDATE plan_item_dependencies SET created_at=transaction_timestamp() WHERE item_id=$1 AND requires_item_id=$2", [s.item, s.prerequisite]);
    const row = (await fx.pool.query(`SELECT item_id AS "itemId",requires_item_id AS "requiresItemId",requirement,note,created_by AS "createdBy",created_at::text AS "createdAt",xmin::text AS "rowXmin",ctid::text AS "rowTid" FROM plan_item_dependencies WHERE item_id=$1 AND requires_item_id=$2`, [s.item,s.prerequisite])).rows[0];
    old = (await import("../../lib/canonical-plan-dependency-version")).planDependencyVersion(row);
    await fx.pool.query("DELETE FROM plan_item_dependencies WHERE item_id=$1 AND requires_item_id=$2", [s.item, s.prerequisite]);
    await fx.pool.query("INSERT INTO plan_item_dependencies(item_id,requires_item_id,requirement,note,created_by) VALUES($1,$2,'completed','SYN dependency note','SYN clinician')", [s.item, s.prerequisite]); await fx.pool.query("COMMIT");
  } catch (e) { await fx.pool.query("ROLLBACK"); throw e; }
  const next = await version(s); expect(next).not.toBe(old); await expect(remove("own", s, old)).rejects.toMatchObject({ code: "plan_dependency_conflict" }); expect(await present(s)).toBe(true); expect(await audit(s)).toEqual([]);
  await remove("own", s, next); await expect(remove("own", s, next)).rejects.toMatchObject({ code: "plan_dependency_not_found" }); expect(await audit(s)).toHaveLength(1);
});
it("a row-only lock does not invalidate a read version and does not expose physical identifiers", async () => {
  const s = await scenario(), before = await version(s); const locked = await side.connect();
  try { await locked.query("BEGIN"); await locked.query("SELECT 1 FROM plan_item_dependencies WHERE item_id=$1 FOR UPDATE", [s.item]); await locked.query("COMMIT"); } finally { await locked.release(); }
  expect(await version(s)).toBe(before); const body = await feed(s); expect(JSON.stringify(body)).not.toMatch(/rowXmin|rowTid|createdAt|ctid/); await remove("own", s, before);
});
it.each(["add", "remove"] as const)("audit failure rolls back %s and its clinical effect", async kind => {
  const s = await scenario(), saved = await version(s);
  await fx.pool.query("CREATE FUNCTION syn_refuse_dep_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('plan.dependency_add','plan.dependency_remove') THEN RAISE EXCEPTION 'SYN dependency audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_refuse_dep_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_refuse_dep_audit()");
  try { await expect(kind === "add" ? add("own", s) : remove("own", s, saved)).rejects.toThrow("SYN dependency audit unavailable"); expect(await present(s)).toBe(true); expect((await feed(s)).dependencies).toHaveLength(1); expect(await audit(s)).toEqual([]); }
  finally { await fx.pool.query("DROP TRIGGER syn_refuse_dep_audit ON audit_log; DROP FUNCTION syn_refuse_dep_audit()"); }
});
it("one admitted connection, no schema initialization or pool escape", async () => {
  const s = await scenario(), session = await fx.session("own"), pool = db.getPool();
  const connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  try { await commands.commandCanonicalPlanDependency(session, "add", String(s.next), { requiresItemId: s.item, requirement: "completed", note: null }); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
});
it("two overlapping deletions of one version produce one effect and audit", async () => {
  const s = await scenario(), saved = await version(s), sessions = [await fx.session("own"),await fx.session("all")], gate = await side.connect(); let pending: Promise<unknown>[] = [];
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);
    pending = sessions.map(session => commands.commandCanonicalPlanDependency(session,"remove",String(s.item),{requiresItemId:s.prerequisite,expectedVersion:saved})); pending.forEach(p=>{void p.catch(()=>undefined);});
    await vi.waitFor(async () => { expect((await side.query(`WITH RECURSIVE blocked(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`,[pid])).rowCount).toBe(2); },{timeout:10000,interval:10});
    await gate.query("COMMIT"); const results=await Promise.allSettled(pending); expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1); expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"plan_dependency_not_found"}}); expect(await present(s)).toBe(false); expect(await audit(s)).toHaveLength(1);
  } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(pending); }
});
it("the edge bound is checked before insertion without truncating the cycle graph", async () => {
  const s = await scenario();
  await fx.pool.query("INSERT INTO plan_items(plan_id,service_name) SELECT $1,'SYN edge bound' FROM generate_series(1,100)",[s.plan]);
  await fx.pool.query(`INSERT INTO plan_item_dependencies(item_id,requires_item_id,requirement,created_by)
    SELECT a.id,b.id,'completed','SYN' FROM plan_items a JOIN plan_items b ON a.plan_id=b.plan_id AND a.id>b.id
    WHERE a.plan_id=$1 AND NOT EXISTS(SELECT 1 FROM plan_item_dependencies d WHERE d.item_id=a.id AND d.requires_item_id=b.id) LIMIT 4000`,[s.plan]);
  const before=Number((await fx.pool.query("SELECT count(*)::int n FROM plan_item_dependencies d JOIN plan_items i ON i.id=d.item_id WHERE i.plan_id=$1",[s.plan])).rows[0].n);
  expect(before).toBe(4001); await expect(add("own",s)).rejects.toMatchObject({code:"plan_dependency_limit"}); expect(await audit(s)).toEqual([]);
});
it("two proven overlapping inverse additions cannot create a cycle", async () => {
  const s = await scenario(), sessions = [await fx.session("own"), await fx.session("all")], gate = await side.connect(); let pending: Promise<unknown>[] = [];
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = [[s.next,s.item],[s.item,s.next]].map(([item,required],i) => commands.commandCanonicalPlanDependency(sessions[i], "add", String(item), { requiresItemId: required, requirement: "completed", note: null })); pending.forEach(p => { void p.catch(() => undefined); });
    await vi.waitFor(async () => { expect((await side.query(`WITH RECURSIVE blocked(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`, [pid])).rowCount).toBe(2); }, { timeout: 10_000, interval: 10 });
    await gate.query("COMMIT"); const results = await Promise.allSettled(pending);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "plan_dependency_cycle" }) })]); expect(await audit(s)).toHaveLength(1);
  } finally { await gate.query("ROLLBACK"); await gate.release(); await Promise.allSettled(pending); }
});
it("authority expiry during the patient wait rolls back with no graph change", async () => {
  const s = await scenario(), session = await fx.session("own",1500), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);
    pending = commands.commandCanonicalPlanDependency(session,"add",String(s.next),{requiresItemId:s.item,requirement:"completed",note:null}); void pending.catch(()=>undefined); expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);
    await new Promise(resolve => setTimeout(resolve,1700)); await gate.query("COMMIT"); await expect(pending).rejects.toThrow(/SESSION|EXPIRED/); expect(await audit(s)).toEqual([]);
  } finally { vi.restoreAllMocks(); await gate.query("ROLLBACK"); await gate.release(); if(pending) await pending.catch(()=>undefined); }
});
it("scope removed while the patient is locked cannot be expanded through a new edge", async () => {
  const s = await scenario(), session = await fx.session("own"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE",[s.patientId]);
    pending = commands.commandCanonicalPlanDependency(session,"add",String(s.next),{requiresItemId:s.item,requirement:"completed",note:null}); void pending.catch(()=>undefined); expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0);
    await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1",[s.patientId]); await gate.query("UPDATE clinical_cases SET responsible_party_id=NULL WHERE patient_id=$1",[s.patientId]); await gate.query("COMMIT");
    await expect(pending).rejects.toMatchObject({code:"plan_dependency_not_found"}); expect(await audit(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); if(pending) await pending.catch(()=>undefined); }
});
it("a revocation before the identity fence opens defeats both old and freshly signed authority", async () => {
  const s = await scenario(), session = await fx.session("all"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",["aqlan.canonical.identity.substrate.v1:public"]);
    await gate.query("UPDATE users SET permissions=$1 WHERE id=$2",[JSON.stringify(capabilityDocument({grants:{"clinical.plans.view":true},patientScope:"all"},2)),fx.ids.all]);
    pending = commands.commandCanonicalPlanDependency(session,"add",String(s.next),{requiresItemId:s.item,requirement:"completed",note:null}); void pending.catch(()=>undefined); expect((await waitForBlockedBy(side,pid,7000)).length).toBeGreaterThan(0); await gate.query("COMMIT");
    await expect(pending).rejects.toThrow(/STALE/); await expect(add("all",s)).rejects.toThrow(/CAPABILITY_DENIED/); expect(await audit(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); if(pending) await pending.catch(()=>undefined); await fx.setGrants("all",EDIT,{patientScope:"all"}); }
});
it("an inverse item writer is refused immediately without deadlock or partial audit", async () => {
  const s = await scenario(), gate = await side.connect();
  try { await gate.query("BEGIN"); await gate.query("SELECT id FROM plan_items WHERE id=$1 FOR UPDATE",[s.item]); await expect(add("own",s)).rejects.toMatchObject({code:"plan_dependency_conflict"}); expect(await audit(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); }
});
it("graph admission refuses excess nodes while deletion can still reduce an oversized graph", async () => {
  const s = await scenario(), saved = await version(s);
  await fx.pool.query("INSERT INTO plan_items(plan_id,service_name) SELECT $1,'SYN bounded graph' FROM generate_series(1,2001)",[s.plan]);
  await expect(add("own",s)).rejects.toMatchObject({code:"plan_dependency_limit"}); await remove("own",s,saved); expect(await present(s)).toBe(false); expect(await audit(s)).toHaveLength(1);
});
