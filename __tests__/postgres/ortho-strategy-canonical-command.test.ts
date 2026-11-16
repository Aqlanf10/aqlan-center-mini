import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalStrategy } from "../fixtures/canonical-ortho-strategy";
import type { StrategyCommand } from "../../lib/ortho-treatment-strategy";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-strategy-write-secret-0123456789");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-ortho-strategy-command");
const reads = await import("../../lib/canonical-ortho-strategy");
const EDIT = { "clinical.ortho.view": true, "clinical.ortho.edit": true };
const PLANS = { ...EDIT, "clinical.plans.view": true, "clinical.plans.edit": true };
const ACCOUNTS = {
  owner: { username: "SYN-OSW-OWNER", role: "admin" },
  own: { username: "SYN-OSW-OWN", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
  all: { username: "SYN-OSW-ALL", role: "reception", patientScope: "all", grants: EDIT },
  planView: { username: "SYN-OSW-PLANVIEW", role: "reception", patientScope: "all", grants: { ...EDIT, "clinical.plans.view": true } },
  planEdit: { username: "SYN-OSW-PLANEDIT", role: "reception", patientScope: "all", grants: PLANS },
  none: { username: "SYN-OSW-NONE", role: "doctor", doctor: true, patientScope: "none", grants: EDIT },
  unlinked: { username: "SYN-OSW-UNLINKED", role: "doctor", patientScope: "own", grants: EDIT },
  read: { username: "SYN-OSW-READ", role: "admin", patientScope: "all", grants: { "clinical.ortho.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true, status = "active", bridge = true) {
  const patientId = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-OSW-${++seq}`, own ? fx.parties.own : null])).rows[0].id as number;
  const caseId = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,status,created_by) VALUES($1,$2,'SYN') RETURNING id", [patientId, status])).rows[0].id as number;
  const bridgeId = bridge ? (await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,ortho_case_id,created_by) VALUES($1,'orthodontics','SYN explicit bridge',$2,'SYN') RETURNING id", [patientId, caseId])).rows[0].id as number : 0;
  const problemId = bridge ? (await fx.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) VALUES($1,$2,'SYN original problem','SYN') RETURNING id", [patientId, bridgeId])).rows[0].id as number : 0;
  return { patientId, caseId, bridgeId, problemId, actorId: fx.ids.owner };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const command = (s: Scenario): StrategyCommand => ({ schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: null,
  reason: "SYN documented intention", rows: [{ problemId: s.problemId || 1, objective: "SYN objective", strategy: "SYN saved strategy", rationale: null, planItemIds: [] }] });
const run = async (key: Key, s: Scenario, body: unknown) => commands.commandCanonicalOrthoStrategy(await fx.session(key), String(s.caseId), body);
const revisions = async (s: Scenario) => (await fx.pool.query("SELECT to_jsonb(r) value FROM ortho_strategy_revisions r WHERE ortho_case_id=$1 ORDER BY version", [s.caseId])).rows.map(r => r.value);
const audits = async (s: Scenario) => (await fx.pool.query("SELECT action,actor,summary FROM audit_log WHERE action='ortho.strategy_revision' AND entity_id=$1 ORDER BY id", [String(s.patientId)])).rows;
async function plan(s: Scenario) {
  const planId = (await fx.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,created_by) VALUES($1,'SYN private funding',98765,'SYN') RETURNING id", [s.patientId])).rows[0].id;
  const itemId = (await fx.pool.query("INSERT INTO plan_items(plan_id,service_name,unit_price_minor,quantity,case_id) VALUES($1,'SYN current service',98765,1,$2) RETURNING id", [planId, s.bridgeId])).rows[0].id;
  return { planId, itemId };
}

it.each(["own", "all", "owner"] as const)("%s appends the existing immutable clinical snapshot and atomic actual-actor audit", async key => {
  const s = await scenario(), result = await run(key, s, command(s));
  expect(result).toMatchObject({ ok: true, replayed: false, revision: { patientId: s.patientId, orthoCaseId: s.caseId, clinicalCaseId: s.bridgeId, version: 1, createdBy: ACCOUNTS[key].username,
    rows: [{ problem: { id: s.problemId, label: "SYN original problem" }, strategy: "SYN saved strategy" }] } });
  expect(await revisions(s)).toHaveLength(1); expect(await audits(s)).toMatchObject([{ actor: ACCOUNTS[key].username }]);
  expect(await reads.readCanonicalOrthoStrategy(await fx.session(key), s.caseId)).toMatchObject({ clinicalWritable: false, choices: { problems: [], planItems: [] } });
});
it.each(["read", "none", "unlinked"] as const)("%s refuses without role-based scope expansion", async key => {
  const s = await scenario(); await expect(run(key, s, command(s))).rejects.toThrow(/CAPABILITY|SCOPE|UNLINKED/);
  expect(await revisions(s)).toEqual([]); expect(await audits(s)).toEqual([]);
});
it("outside equals missing and no bridge is manufactured", async () => {
  const s = await scenario(false), errors = [];
  for (const id of [s.caseId, 2147483647]) try { await commands.commandCanonicalOrthoStrategy(await fx.session("own"), String(id), command(s)); throw Error("unexpected"); }
  catch (error) { errors.push({ code: (error as { code: string }).code, message: (error as Error).message }); }
  expect(errors[0]).toEqual(errors[1]); expect(errors[0].code).toBe("ortho_case_not_found");
  const absent = await scenario(true, "active", false);
  await expect(run("own", absent, command(absent))).rejects.toMatchObject({ code: "bridge_missing" });
  expect(await revisions(absent)).toEqual([]);
});
it("exact same-actor replay is immutable; changed bytes, another actor and stale heads cannot append", async () => {
  const s = await scenario(), input = command(s), first = await run("own", s, input), before = await revisions(s);
  expect(await run("own", s, input)).toEqual({ ...first, replayed: true });
  await expect(run("own", s, { ...input, reason: "SYN changed request" })).rejects.toMatchObject({ code: "command_conflict" });
  await expect(run("all", s, input)).rejects.toMatchObject({ code: "stale_revision" });
  await expect(run("own", s, command(s))).rejects.toMatchObject({ code: "stale_revision" });
  expect(await revisions(s)).toEqual(before); expect(await audits(s)).toHaveLength(1);
});
it("history whose explicit bridge was detached is not disguised as an empty unlinked case", async () => {
  const s = await scenario(), input = command(s); await run("own", s, input);
  const before = await revisions(s);
  await fx.pool.query("UPDATE clinical_cases SET ortho_case_id=NULL WHERE id=$1", [s.bridgeId]);
  await expect(run("own", s, input)).rejects.toMatchObject({ code: "revision_scope_mismatch", status: 409 });
  expect(await revisions(s)).toEqual(before); expect(await audits(s)).toHaveLength(1);
});
it("plan links require independent view AND edit when adding, retaining, removing and replaying removal", async () => {
  const s = await scenario(), linked = await plan(s), input = command(s); input.rows[0].planItemIds = [linked.itemId];
  for (const key of ["own", "planView"] as const) await expect(run(key, s, input)).rejects.toMatchObject({ code: "plan_links_unavailable", status: 403 });
  const first = await run("planEdit", s, input), remove = { ...command(s), expectedRevisionId: first.revision.revisionId };
  for (const key of ["own", "planView"] as const) await expect(run(key, s, remove)).rejects.toMatchObject({ code: "plan_links_unavailable" });
  const removed = await run("planEdit", s, remove); expect(removed.revision.rows[0].planLinks).toEqual({ state: "allowed", items: [] });
  await fx.setGrants("planEdit", EDIT, { patientScope: "all" });
  try { await expect(run("planEdit", s, remove)).rejects.toMatchObject({ code: "plan_links_unavailable" }); }
  finally { await fx.setGrants("planEdit", PLANS, { patientScope: "all" }); }
  expect(await revisions(s)).toHaveLength(2); expect(await audits(s)).toHaveLength(2);
});
it("foreign problem/item references and same-patient different-bridge references cannot bind", async () => {
  const s = await scenario(), other = await scenario(false), foreign = await plan(other);
  const badProblem = command(s); badProblem.rows[0].problemId = other.problemId;
  await expect(run("owner", s, badProblem)).rejects.toMatchObject({ code: "problem_scope_mismatch" });
  const badItem = command(s); badItem.rows[0].planItemIds = [foreign.itemId];
  await expect(run("owner", s, badItem)).rejects.toMatchObject({ code: "item_scope_mismatch" });
  await fx.pool.query("UPDATE patient_problems SET case_id=NULL WHERE id=$1", [s.problemId]);
  await expect(run("own", s, command(s))).rejects.toMatchObject({ code: "problem_scope_mismatch" });
  expect(await revisions(s)).toEqual([]);
});
it("replay preserves authored snapshots while changed or foreign live links expose only their state", async () => {
  const s = await scenario(), other = await scenario(false), linked = await plan(s), input = command(s); input.rows[0].planItemIds = [linked.itemId];
  const first = await run("planEdit", s, input);
  await fx.pool.query("UPDATE patient_problems SET patient_id=$1,case_id=NULL,label='SYN FOREIGN PRIVATE' WHERE id=$2", [other.patientId, s.problemId]);
  await fx.pool.query("UPDATE treatment_plans SET patient_id=$1,title='SYN FOREIGN FUNDING' WHERE id=$2", [other.patientId, linked.planId]);
  const replay = await run("planEdit", s, input);
  expect(replay.replayed).toBe(true); expect(replay.revision.revisionId).toBe(first.revision.revisionId);
  expect(replay.revision.rows[0].problem.label).toBe("SYN original problem");
  expect(replay.revision.rows[0].currentProblem).toEqual({ state: "unavailable", status: null });
  expect(JSON.stringify(replay)).not.toMatch(/FOREIGN PRIVATE|FOREIGN FUNDING|98765/);
  expect(await revisions(s)).toHaveLength(1);
});
it.each(["completed", "discontinued"])("%s permits retrospective documentation without reopening treatment", async status => {
  const s = await scenario(true, status), before = (await fx.pool.query("SELECT to_jsonb(c) value FROM ortho_cases c WHERE id=$1", [s.caseId])).rows;
  expect((await run("own", s, command(s))).revision.recordingContext).toBe("retrospective");
  expect((await fx.pool.query("SELECT to_jsonb(c) value FROM ortho_cases c WHERE id=$1", [s.caseId])).rows).toEqual(before);
});
it("two actual blocked same-command waiters produce one revision and one replay", async () => {
  const s = await scenario(), input = command(s), session = await fx.session("own"), holder = await side.connect(); let pending: Promise<unknown>[] = [];
  try {
    await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = [1, 2].map(() => commands.commandCanonicalOrthoStrategy(session, String(s.caseId), input)); pending.forEach(p => { void p.catch(() => undefined); });
    await vi.waitFor(async () => expect((await side.query("WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked", [pid])).rowCount).toBe(2), { timeout: 10000, interval: 10 });
    await holder.query("COMMIT"); const result = await Promise.all(pending);
    expect((result as { replayed: boolean }[]).map(r => r.replayed).sort()).toEqual([false, true]);
    expect(await revisions(s)).toHaveLength(1); expect(await audits(s)).toHaveLength(1);
  } finally { await holder.query("ROLLBACK"); holder.release(); await Promise.allSettled(pending); }
});
it.each(["expiry", "membership"] as const)("%s is rechecked after a real patient-row wait", async kind => {
  const s = await scenario(), session = await fx.session("own", kind === "expiry" ? 1500 : 60000), holder = await side.connect(); let pending: Promise<unknown> | undefined;
  try {
    await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = commands.commandCanonicalOrthoStrategy(session, String(s.caseId), command(s)); void pending.catch(() => undefined); await waitForBlockedBy(side, pid);
    if (kind === "expiry") await new Promise(r => setTimeout(r, 1700)); else await holder.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]);
    await holder.query("COMMIT"); await expect(pending).rejects.toThrow(); expect(await revisions(s)).toEqual([]);
  } finally { await holder.query("ROLLBACK"); holder.release(); await pending?.catch(() => undefined); }
});
it.each(["case", "problem", "item", "plan"] as const)("inverse %s contention fails closed without waiting", async kind => {
  const s = await scenario(), linked = await plan(s), input = command(s); input.rows[0].planItemIds = [linked.itemId];
  const holder = await side.connect(), table = { case: "ortho_cases", problem: "patient_problems", item: "plan_items", plan: "treatment_plans" }[kind];
  const id = { case: s.caseId, problem: s.problemId, item: linked.itemId, plan: linked.planId }[kind];
  try {
    await holder.query("BEGIN"); await holder.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [id]);
    await expect(run("planEdit", s, input)).rejects.toMatchObject({ code: "strategy_conflict", status: 409 });
    expect(await revisions(s)).toEqual([]);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});
it("a revoked grant behind the identity fence rejects an old session and a fresh reader", async () => {
  const s = await scenario(), session = await fx.session("all"), holder = await side.connect(); let pending: Promise<unknown> | undefined;
  try {
    await holder.query("BEGIN"); const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan.canonical.identity.substrate.v1:public',0))");
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: { "clinical.ortho.view": true }, patientScope: "all" }, 2)), fx.ids.all]);
    pending = commands.commandCanonicalOrthoStrategy(session, String(s.caseId), command(s)); void pending.catch(() => undefined); await waitForBlockedBy(side, pid);
    await holder.query("COMMIT"); await expect(pending).rejects.toThrow(/STALE/); await expect(run("all", s, command(s))).rejects.toThrow(/CAPABILITY/);
    expect(await revisions(s)).toEqual([]);
  } finally { await holder.query("ROLLBACK"); holder.release(); await pending?.catch(() => undefined); await fx.setGrants("all", EDIT, { patientScope: "all" }); }
});
it.each(["audit", "late-expiry"] as const)("%s rolls back the revision and its audit atomically", async kind => {
  const s = await scenario(), session = await fx.session("own", kind === "late-expiry" ? 1500 : 60000);
  await fx.pool.query(`CREATE FUNCTION syn_strategy_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.strategy_revision' THEN ${kind === "audit" ? "RAISE EXCEPTION 'SYN audit refused';" : "PERFORM pg_sleep(1.8);"} END IF; RETURN NEW; END $$; CREATE TRIGGER syn_strategy_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_strategy_audit()`);
  try {
    await expect(commands.commandCanonicalOrthoStrategy(session, String(s.caseId), command(s))).rejects.toThrow();
    expect(await revisions(s)).toEqual([]); expect(await audits(s)).toEqual([]);
  } finally { await fx.pool.query("DROP TRIGGER syn_strategy_audit ON audit_log; DROP FUNCTION syn_strategy_audit()"); }
});
it("one owning transaction preserves nonempty finance and original patient/bridge identities", async () => {
  const s = await scenario(), linked = await plan(s), input = command(s); input.rows[0].planItemIds = [linked.itemId];
  await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by) VALUES($1,$2,54321,'USD','SYN')", [`SYN-OSW-FIN-${s.caseId}`, s.patientId]);
  const unchanged = async () => (await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM treatment_plans t) plans,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM plan_items p) items,(SELECT to_jsonb(p) FROM patients p WHERE id=$1) patient,(SELECT to_jsonb(c) FROM ortho_cases c WHERE id=$2) ortho,(SELECT to_jsonb(c) FROM clinical_cases c WHERE id=$3) bridge", [s.patientId, s.caseId, s.bridgeId])).rows;
  const before = await unchanged(), session = await fx.session("planEdit"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  try {
    await commands.commandCanonicalOrthoStrategy(session, String(s.caseId), input);
    expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled();
  } finally { connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
  expect(await unchanged()).toEqual(before);
});

it("the 5000-revision reader boundary cannot be crossed by a successful canonical append", async () => {
  const s = await scenario(), first = await seedCanonicalStrategy(fx.pool, s);
  await fx.pool.query(`WITH identities AS MATERIALIZED (
    SELECT n,nextval(pg_get_serial_sequence('ortho_strategy_revisions','id'))::int id FROM generate_series(2,5000) n ORDER BY n)
    INSERT INTO ortho_strategy_revisions(id,patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,schema_version,version,supersedes_revision_id,actor_user_id,created_by,reason,recording_context,command_id,request_fingerprint,rows)
    SELECT id,$1,$1,$2,$3,1,n,lag(id,1,$4::int) OVER(ORDER BY n),$5,'SYN','SYN budget','current','synthetic_strategy_budget_'||n,$6,$7::jsonb FROM identities`,
  [s.patientId, s.caseId, s.bridgeId, first.id, fx.ids.owner, "a".repeat(64), JSON.stringify(first.rows)]);
  const before = await reads.readCanonicalOrthoStrategy(await fx.session("own"), s.caseId);
  expect(before.history).toHaveLength(5000);
  await expect(run("own", s, { ...command(s), expectedRevisionId: before.history[0].revisionId })).rejects.toMatchObject({ code: "strategy_history_limit" });
  expect((await reads.readCanonicalOrthoStrategy(await fx.session("own"), s.caseId)).history).toEqual(before.history);
  expect(await audits(s)).toEqual([]);
});
it("the all-history reference union cannot be enlarged beyond the accepted 128-reference read bound", async () => {
  const s = await scenario(), ids = (await fx.pool.query("INSERT INTO patient_problems(patient_id,case_id,label,noted_by) SELECT $1,$2,'SYN bounded '||n,'SYN' FROM generate_series(1,129) n RETURNING id", [s.patientId, s.bridgeId])).rows.map(row => row.id);
  let previous: number | null = null;
  for (let i = 0; i < 128; i++) previous = (await seedCanonicalStrategy(fx.pool, { ...s, problemId: ids[i], version: i + 1, previous })).id;
  expect((await reads.readCanonicalOrthoStrategy(await fx.session("own"), s.caseId)).history).toHaveLength(128);
  const input = { ...command(s), expectedRevisionId: previous }; input.rows[0].problemId = ids[128];
  await expect(run("own", s, input)).rejects.toMatchObject({ code: "strategy_reference_limit" });
  expect((await reads.readCanonicalOrthoStrategy(await fx.session("own"), s.caseId)).history).toHaveLength(128);
  expect(await audits(s)).toEqual([]);
});
