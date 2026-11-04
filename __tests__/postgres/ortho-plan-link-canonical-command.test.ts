import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
vi.mock("server-only", () => ({}));
assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-plan-link-secret-0123456789");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-ortho-plan-link-command"), reads = await import("../../lib/canonical-ortho-reads");
const EDIT = { "clinical.ortho.view": true, "clinical.ortho.edit": true, "clinical.plans.view": true, "clinical.plans.edit": true };
const ACCOUNTS = {
  owner: { username: "SYN-OPL-OWNER", role: "admin" },
  own: { username: "SYN-OPL-OWN", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
  all: { username: "SYN-OPL-ALL", role: "reception", patientScope: "all", grants: EDIT },
  manager: { username: "SYN-OPL-MANAGER", role: "admin", doctor: true, patientScope: "own", grants: EDIT },
  none: { username: "SYN-OPL-NONE", role: "doctor", doctor: true, patientScope: "none", grants: EDIT },
  unlinked: { username: "SYN-OPL-UNLINKED", role: "doctor", patientScope: "own", grants: EDIT },
  clinical: { username: "SYN-OPL-CLINICAL", role: "admin", patientScope: "all", grants: { "clinical.ortho.view": true, "clinical.ortho.edit": true } },
  planread: { username: "SYN-OPL-PLANREAD", role: "admin", patientScope: "all", grants: { ...EDIT, "clinical.plans.edit": false } },
  planedit: { username: "SYN-OPL-PLANEDIT", role: "admin", patientScope: "all", grants: { ...EDIT, "clinical.plans.view": false } },
  readonly: { username: "SYN-OPL-READ", role: "admin", patientScope: "all", grants: { ...EDIT, "clinical.ortho.edit": false } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-OPL-${++seq}`, own ? fx.parties.own : null])).rows[0].id as number;
  const id = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by,note) VALUES($1,'SYN','SYN unchanged') RETURNING id", [patientId])).rows[0].id as number;
  const planId = (await fx.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency) VALUES($1,'SYN plan',76543,'USD') RETURNING id", [patientId])).rows[0].id as number;
  return { id, patientId, planId };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const version = async (s: Scenario) => (await reads.readCanonicalOrthoCase(await fx.session("owner"), s.id)).editVersion!;
const input = async (s: Scenario, planId: number | null = s.planId) => ({ expectedVersion: await version(s), planId });
const run = async (key: Key, s: Scenario, body: unknown) => commands.commandCanonicalOrthoPlanLink(await fx.session(key), String(s.id), body);
const snapshot = async (s: Scenario) => (await fx.pool.query("SELECT to_jsonb(c) value FROM ortho_cases c WHERE id=$1", [s.id])).rows[0].value;
const audits = async (s: Scenario) => (await fx.pool.query("SELECT action,actor,summary FROM audit_log WHERE action='ortho.plan_link' AND entity_id=$1 ORDER BY id", [String(s.id)])).rows;

it.each(["own", "all", "owner"] as const)("%s changes only the link and emits one native audit; delayed replay conflicts", async key => {
  const s = await scenario(), before = await snapshot(s), body = await input(s);
  expect(await run(key, s, body)).toEqual({ ok: true, caseId: s.id, changed: true });
  expect(await snapshot(s)).toEqual({ ...before, plan_id: s.planId });
  expect(await audits(s)).toMatchObject([{ action: "ortho.plan_link", actor: ACCOUNTS[key].username }]);
  await expect(run(key, s, body)).rejects.toMatchObject({ code: "ortho_plan_link_conflict" });
  expect(await audits(s)).toHaveLength(1);
});
it.each(["none", "unlinked", "clinical", "planread", "planedit", "readonly"] as const)("%s lacks independent authority even for a no-op unlink", async key => {
  const s = await scenario(), before = await snapshot(s);
  // The catalogue requires plans.view for plans.edit; this deliberately invalid
  // document is rejected by central admission before command-specific checks.
  await expect(run(key, s, await input(s, null))).rejects.toThrow(key === "planedit" ? /^STAFF_OPERATION_PERMISSIONS_STALE$/ : /SCOPE|CAPABILITY|UNLINKED/);
  expect(await snapshot(s)).toEqual(before); expect(await audits(s)).toEqual([]);
});
it("outside, missing and admin-labelled own scope are equally unavailable", async () => {
  const s = await scenario(false), body = await input(s);
  for (const key of ["own", "manager"] as const) await expect(run(key, s, body)).rejects.toMatchObject({ code: "ortho_plan_link_not_found" });
  await expect(commands.commandCanonicalOrthoPlanLink(await fx.session("own"), "2147483647", body)).rejects.toMatchObject({ code: "ortho_plan_link_not_found" });
  expect(await audits(s)).toEqual([]);
});
it("an assigned responsible doctor retains the legitimate current scope", async () => {
  const s = await scenario(false);
  await fx.pool.query("UPDATE ortho_cases SET responsible_doctor_id=$1 WHERE id=$2", [fx.parties.manager, s.id]);
  expect(await run("manager", s, await input(s))).toMatchObject({ changed: true });
  expect((await snapshot(s)).responsible_doctor_id).toBe(fx.parties.manager);
});
it("fresh same-value requests are no-ops without audit, unlinking changes only the link", async () => {
  const s = await scenario(), empty = await input(s, null);
  expect(await run("own", s, empty)).toMatchObject({ changed: false }); expect(await audits(s)).toEqual([]);
  await run("own", s, await input(s)); const linked = await input(s), observed = await snapshot(s);
  for (let n = 0; n < 2; n++) expect(await run("own", s, linked)).toMatchObject({ changed: false });
  expect(await snapshot(s)).toEqual(observed); expect(await audits(s)).toHaveLength(1);
  await run("own", s, await input(s, null)); expect((await snapshot(s)).plan_id).toBeNull(); expect(await audits(s)).toHaveLength(2);
  await expect(run("own", s, linked)).rejects.toMatchObject({ code: "ortho_plan_link_conflict" });
});
it("foreign and missing plans have the same refusal, including a corrupt existing link", async () => {
  const s = await scenario(), other = await scenario(false), body = await input(s), before = await snapshot(s);
  for (const planId of [other.planId, 2147483647]) await expect(run("own", s, { ...body, planId })).rejects.toMatchObject({ code: "ortho_plan_link_unavailable" });
  expect(await snapshot(s)).toEqual(before);
  await fx.pool.query("UPDATE ortho_cases SET plan_id=$1 WHERE id=$2", [other.planId, s.id]);
  await expect(run("own", s, await input(s, null))).rejects.toMatchObject({ code: "ortho_plan_link_unavailable" }); expect(await audits(s)).toEqual([]);
});
it("a cancelled target cannot be linked; removing a cancelled old link is legitimate", async () => {
  const s = await scenario(); await fx.pool.query("UPDATE treatment_plans SET status='cancelled' WHERE id=$1", [s.planId]);
  await expect(run("own", s, await input(s))).rejects.toMatchObject({ code: "ortho_plan_link_unavailable" });
  await fx.pool.query("UPDATE ortho_cases SET plan_id=$1 WHERE id=$2", [s.planId, s.id]);
  expect(await run("own", s, await input(s, null))).toMatchObject({ changed: true }); expect(await audits(s)).toHaveLength(1);
});
it.each(["completed", "discontinued"])("%s case cannot change its plan", async status => {
  const s = await scenario(), body = await input(s); await fx.pool.query("UPDATE ortho_cases SET status=$1 WHERE id=$2", [status, s.id]);
  await expect(run("owner", s, body)).rejects.toMatchObject({ code: "ortho_plan_link_conflict" }); expect(await audits(s)).toEqual([]);
});
it("retention and native completed-but-not-cancelled plan rules remain valid", async () => {
  const s = await scenario(); await fx.pool.query("UPDATE ortho_cases SET status='retention' WHERE id=$1", [s.id]);
  await fx.pool.query("UPDATE treatment_plans SET status='completed' WHERE id=$1", [s.planId]);
  expect(await run("own", s, await input(s))).toMatchObject({ changed: true });
});
it.each(["expire", "scope", "case", "plan"] as const)("%s change during a proven patient lock wait is revalidated", async kind => {
  const s = await scenario(), other = await scenario(false), body = await input(s), session = await fx.session("own", kind === "expire" ? 1500 : 60000), gate = await side.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = commands.commandCanonicalOrthoPlanLink(session, String(s.id), body); void pending.catch(() => undefined); await waitForBlockedBy(side, pid);
    if (kind === "expire") await new Promise(resolve => setTimeout(resolve, 1700));
    if (kind === "scope") await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]);
    if (kind === "case") await gate.query("UPDATE ortho_cases SET phase='finishing' WHERE id=$1", [s.id]);
    if (kind === "plan") await gate.query("UPDATE treatment_plans SET patient_id=$1 WHERE id=$2", [other.patientId, s.planId]);
    await gate.query("COMMIT"); await expect(pending).rejects.toThrow(); expect(await audits(s)).toEqual([]); expect((await snapshot(s)).plan_id).toBeNull();
  } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); }
});
it("two actual lock waiters produce one change and one stale conflict", async () => {
  const s = await scenario(), body = await input(s), sessions = [await fx.session("own"), await fx.session("all")], gate = await side.connect();
  let pending: Promise<unknown>[] = [];
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = sessions.map(session => commands.commandCanonicalOrthoPlanLink(session, String(s.id), body)); pending.forEach(p => { void p.catch(() => undefined); });
    await vi.waitFor(async () => expect((await side.query("WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked", [pid])).rowCount).toBe(2), { timeout: 10000, interval: 10 });
    await gate.query("COMMIT"); const result = await Promise.allSettled(pending);
    expect(result.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(result.filter(r => r.status === "rejected")).toMatchObject([{ reason: { code: "ortho_plan_link_conflict" } }]); expect(await audits(s)).toHaveLength(1);
  } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(pending); }
});
it.each(["case", "plan"] as const)("inverse %s lock refuses without deadlock", async kind => {
  const s = await scenario(), body = await input(s), gate = await side.connect();
  try { await gate.query("BEGIN"); await gate.query(kind === "case" ? "SELECT id FROM ortho_cases WHERE id=$1 FOR UPDATE" : "SELECT id FROM treatment_plans WHERE id=$1 FOR UPDATE", [kind === "case" ? s.id : s.planId]);
    await expect(run("own", s, body)).rejects.toMatchObject({ code: "ortho_plan_link_conflict" }); expect(await audits(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); }
});
it("foreign plan is refused before touching its locked row", async () => {
  const s = await scenario(), other = await scenario(false), body = await input(s, other.planId), gate = await side.connect();
  try { await gate.query("BEGIN"); await gate.query("SELECT id FROM treatment_plans WHERE id=$1 FOR UPDATE", [other.planId]);
    await expect(run("own", s, body)).rejects.toMatchObject({ code: "ortho_plan_link_unavailable" });
  } finally { await gate.query("ROLLBACK"); gate.release(); }
});
it.each([false, true])("late audit failure or expiry rolls back the native link and audit (delay=%s)", async delay => {
  const s = await scenario(), body = await input(s), before = await snapshot(s), session = await fx.session("own", delay ? 1500 : 60000);
  await fx.pool.query(`CREATE FUNCTION syn_plan_link_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.plan_link' THEN ${delay ? "PERFORM pg_sleep(1.8)" : "RAISE EXCEPTION 'SYN plan link audit refused'"}; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_plan_link_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_plan_link_audit()`);
  try { await expect(commands.commandCanonicalOrthoPlanLink(session, String(s.id), body)).rejects.toThrow(delay ? /SESSION|EXPIRED/ : /SYN plan link audit refused/); expect(await snapshot(s)).toEqual(before); expect(await audits(s)).toEqual([]); }
  finally { await fx.pool.query("DROP TRIGGER syn_plan_link_audit ON audit_log; DROP FUNCTION syn_plan_link_audit()"); }
});
it("plan grant revoked behind the actual authority fence defeats old and fresh claims", async () => {
  const s = await scenario(), body = await input(s), session = await fx.session("all"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan.canonical.identity.substrate.v1:public',0))");
    await gate.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: { ...EDIT, "clinical.plans.edit": false }, patientScope: "all" }, 2)), fx.ids.all]);
    pending = commands.commandCanonicalOrthoPlanLink(session, String(s.id), body); void pending.catch(() => undefined); await waitForBlockedBy(side, pid);
    await gate.query("COMMIT"); await expect(pending).rejects.toThrow(/STALE/); await expect(run("all", s, body)).rejects.toThrow(/CAPABILITY/); expect(await audits(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); await fx.setGrants("all", EDIT, { patientScope: "all" }); }
});
it("one admitted connection preserves nonempty finance, signed visits, adjustments and identity assignments", async () => {
  const s = await scenario();
  await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,base_currency,created_by) VALUES($1,$2,76543,'USD','SYN')", [`SYN-OPL-${s.id}`, s.patientId]);
  await fx.pool.query("INSERT INTO visits(patient_id,patient_name,status,signed_at,signed_by) VALUES($1,'SYN signed','done',NOW(),'SYN')", [s.patientId]);
  await fx.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,done,recorded_by) VALUES($1,CURRENT_DATE,'SYN historical','SYN')", [s.id]);
  const unchanged = async () => (await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM treatment_plans t) plans,(SELECT jsonb_agg(to_jsonb(v) ORDER BY id) FROM visits v) visits,(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM ortho_adjustments a) adjustments,(SELECT primary_doctor_id FROM patients WHERE id=$1) doctor", [s.patientId])).rows;
  const before = await unchanged(), body = await input(s), session = await fx.session("own"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  try { expect(await commands.commandCanonicalOrthoPlanLink(session, String(s.id), body)).toEqual({ ok: true, caseId: s.id, changed: true }); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
  expect(await unchanged()).toEqual(before);
});
