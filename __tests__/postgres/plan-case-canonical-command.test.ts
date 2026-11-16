import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
import { seedCanonicalPatientCases } from "../fixtures/canonical-patient-cases";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-plan-case-write-secret-0123456789");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-plan-case-command");
const EDIT = { "clinical.plans.view": true, "clinical.plans.edit": true };
const ACCOUNTS = {
  owner: { username: "SYN-PCW-OWNER", role: "admin" },
  own: { username: "SYN-PCW-OWN", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
  all: { username: "SYN-PCW-ALL", role: "reception", patientScope: "all", grants: EDIT },
  none: { username: "SYN-PCW-NONE", role: "doctor", doctor: true, patientScope: "none", grants: EDIT },
  unlinked: { username: "SYN-PCW-UNLINKED", role: "doctor", patientScope: "own", grants: EDIT },
  readonly: { username: "SYN-PCW-READ", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true } },
  editOnly: { username: "SYN-PCW-EDIT-ONLY", role: "doctor", doctor: true, patientScope: "all", grants: { "clinical.plans.edit": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-PCW-${++seq}`, own ? fx.parties.own : null])).rows[0].id);
  const saved = await seedCanonicalPatientCases(fx.pool, patientId, own ? fx.parties.own : undefined);
  const newCase = Number((await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES($1,'general','SYN new case','SYN') RETURNING id", [patientId])).rows[0].id);
  return { ...saved, patientId, newCase };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const draft = (s: Scenario) => ({ caseId: s.newCase, priority: 4, expectedCaseId: s.caseId, expectedPriority: 3 });
const command = async (key: Key, s: Scenario, body: unknown = draft(s)) => commands.commandCanonicalPlanItemCase(await fx.session(key), String(s.item), body);
const current = async (s: Scenario) => (await fx.pool.query("SELECT case_id,priority FROM plan_items WHERE id=$1", [s.item])).rows[0];
const audit = async (s: Scenario) => (await fx.pool.query("SELECT actor,actor_role,details FROM audit_log WHERE action='plan.item_case' AND entity_id=$1 ORDER BY id", [String(s.patientId)])).rows;
async function financeSnapshot() { return (await fx.pool.query(`SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,
  (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoice_items i) items,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) payments,
  (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM legacy_treatment_agreements a) agreements`)).rows; }
async function bill(s: Scenario, source: "direct" | "plan_item", q: Pick<Pool, "query"> = fx.pool) {
  const invoiceId = Number((await q.query("INSERT INTO invoices(invoice_number,patient_id,status,total_minor,base_currency,created_by) VALUES($1,$2,'cancelled',0,'YER','SYN') RETURNING id", [`SYN-PCW-INV-${s.item}`, s.patientId])).rows[0].id);
  await q.query("INSERT INTO invoice_items(invoice_id,description,plan_item_id,source_type,source_id) VALUES($1,'SYN retained zero source',$2,$3,$4)", [invoiceId, source === "direct" ? s.item : null, source === "plan_item" ? "plan_item" : null, source === "plan_item" ? s.item : null]);
}
it.each(["owner", "own", "all"] as const)("%s links an unbilled item with its real actor and atomic audit", async key => {
  const s = await scenario(), money = await financeSnapshot();
  expect(await command(key, s)).toEqual({ ok: true, changed: true, itemId: s.item, caseId: s.newCase, priority: 4 });
  expect(await current(s)).toEqual({ case_id: s.newCase, priority: 4 }); expect(await audit(s)).toEqual([expect.objectContaining({ actor: ACCOUNTS[key].username, actor_role: ACCOUNTS[key].role })]);
  expect(await financeSnapshot()).toEqual(money);
});
it.each(["none", "unlinked", "readonly"] as const)("denies %s without changing the link or audit", async key => {
  const s = await scenario(); await expect(command(key, s)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER|عرض بنود الخطط/);
  expect(await current(s)).toEqual({ case_id: s.caseId, priority: 3 }); expect(await audit(s)).toHaveLength(0);
});
it("a malformed edit-only grant document is refused by the existing prerequisite proof", async () => {
  const s = await scenario(); await expect(command("editOnly", s)).rejects.toThrow("STAFF_OPERATION_PERMISSIONS_STALE");
  expect(await current(s)).toEqual({ case_id: s.caseId, priority: 3 }); expect(await audit(s)).toHaveLength(0);
});
it("own cannot relink an outside item; missing and outside are indistinguishable", async () => {
  const s = await scenario(false), session = await fx.session("own"), errors = [];
  for (const id of [s.item, 2147483647]) try { await commands.commandCanonicalPlanItemCase(session, String(id), draft(s)); throw Error("unexpected"); } catch (e) { errors.push({ code: (e as { code: string }).code, message: (e as Error).message }); }
  expect(errors[0]).toEqual(errors[1]); expect(errors[0].code).toBe("plan_item_not_found"); expect(await audit(s)).toHaveLength(0);
});
it("foreign and missing target cases return the same bounded refusal", async () => {
  const s = await scenario(), other = await scenario(false), errors = [];
  for (const caseId of [other.caseId, 2147483647]) try { await command("owner", s, { ...draft(s), caseId }); throw Error("unexpected"); } catch (e) { errors.push({ code: (e as { code: string }).code, message: (e as Error).message }); }
  expect(errors[0]).toEqual(errors[1]); expect(errors[0].code).toBe("plan_case_not_available"); expect(await audit(s)).toHaveLength(0);
});
it("an explicit detach is permitted before financial attribution is retained", async () => {
  const s = await scenario(); expect(await command("own", s, { ...draft(s), caseId: null, priority: null })).toMatchObject({ changed: true }); expect(await current(s)).toEqual({ case_id: null, priority: null });
});
it("a stale comparison refuses lost updates; a fresh unchanged save produces no extra audit", async () => {
  const s = await scenario(); await command("own", s);
  await expect(command("own", s)).rejects.toMatchObject({ code: "plan_case_conflict" }); expect(await audit(s)).toHaveLength(1);
  expect(await command("own", s, { caseId: s.newCase, priority: 4, expectedCaseId: s.newCase, expectedPriority: 4 })).toMatchObject({ changed: false }); expect(await audit(s)).toHaveLength(1);
});
it.each(["direct", "plan_item"] as const)("retains %s zero-value cancelled-invoice attribution but permits a priority-only edit", async source => {
  const s = await scenario(); await bill(s, source); const money = await financeSnapshot();
  await expect(command("owner", s)).rejects.toMatchObject({ code: "plan_case_billed_lock" });
  expect(await current(s)).toEqual({ case_id: s.caseId, priority: 3 }); expect(await audit(s)).toHaveLength(0);
  expect(await command("own", s, { ...draft(s), caseId: s.caseId })).toMatchObject({ changed: true });
  expect(await current(s)).toEqual({ case_id: s.caseId, priority: 4 }); expect(await financeSnapshot()).toEqual(money);
});
it("a retained historical agreement blocks reassignment even without an invoice", async () => {
  const s = await scenario(), serviceId = Number((await fx.pool.query("INSERT INTO services(name,category) VALUES('SYN old agreement','general') RETURNING id")).rows[0].id);
  await fx.pool.query(`INSERT INTO legacy_treatment_agreements(patient_id,plan_item_id,case_id,service_id,service_name,specialty,currency,agreed_minor,previously_paid_minor,remaining_minor,historical_as_of,opening_effect,created_by)
    VALUES($1,$2,$3,$4,'SYN old work','general','YER',100,100,0,'2024-01-01','none','SYN')`, [s.patientId, s.item, s.caseId, serviceId]);
  const money = await financeSnapshot(); await expect(command("owner", s)).rejects.toMatchObject({ code: "plan_case_billed_lock" }); expect(await audit(s)).toHaveLength(0); expect(await financeSnapshot()).toEqual(money);
});
it("independent ortho visibility is required both for assigning and for unlinking a hidden case", async () => {
  const s = await scenario(), ortho = Number((await fx.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES($1,'orthodontics','SYN hidden ortho case','SYN') RETURNING id", [s.patientId])).rows[0].id);
  await expect(command("own", s, { ...draft(s), caseId: ortho })).rejects.toMatchObject({ code: "plan_case_capability_denied" });
  await command("owner", s, { ...draft(s), caseId: ortho });
  await expect(command("own", s, { caseId: null, priority: 4, expectedCaseId: ortho, expectedPriority: 4 })).rejects.toMatchObject({ code: "plan_case_capability_denied" });
  expect((await current(s)).case_id).toBe(ortho); expect(await audit(s)).toHaveLength(1);
});
it("a failed audit rolls back the actual link change", async () => {
  const s = await scenario();
  await fx.pool.query("CREATE FUNCTION syn_refuse_case_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='plan.item_case' THEN RAISE EXCEPTION 'SYN audit unavailable'; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_refuse_case_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_refuse_case_audit()");
  try { await expect(command("own", s)).rejects.toThrow("SYN audit unavailable"); expect(await current(s)).toEqual({ case_id: s.caseId, priority: 3 }); expect(await audit(s)).toHaveLength(0); }
  finally { await fx.pool.query("DROP TRIGGER syn_refuse_case_audit ON audit_log; DROP FUNCTION syn_refuse_case_audit()"); }
  expect(await command("own", s)).toMatchObject({ changed: true });
});
it("uses only the admitted connection and never ensures a schema or escapes to pool queries", async () => {
  const s = await scenario(), session = await fx.session("own"), pool = db.getPool();
  const connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  try { await commands.commandCanonicalPlanItemCase(session, String(s.item), draft(s)); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
});
it("two proven overlapping edits with the same comparison admit exactly one audit", async () => {
  const s = await scenario(), sessions = [await fx.session("own"), await fx.session("all")], gate = await side.connect(); let pending: Promise<unknown>[] = [];
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = sessions.map((session, index) => commands.commandCanonicalPlanItemCase(session, String(s.item), { ...draft(s), priority: 4 + index })); pending.forEach(p => { void p.catch(() => undefined); });
    // A queued UPDATE can wait on the first waiter's tuple lock rather than
    // directly on the gate. Require both real requests in the gate's wait chain.
    await vi.waitFor(async () => { expect((await side.query(`WITH RECURSIVE blocked(pid) AS (
      SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
      UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`, [pid])).rowCount).toBe(2); }, { timeout: 10_000, interval: 10 });
    expect(await current(s)).toEqual({ case_id: s.caseId, priority: 3 }); await gate.query("COMMIT"); const results = await Promise.allSettled(pending);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "plan_case_conflict" } }); expect(await audit(s)).toHaveLength(1);
  } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(pending); }
});
it("a committed invoice created while the item lock is held is observed after the wait", async () => {
  const s = await scenario(), session = await fx.session("own"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM plan_items WHERE id=$1 FOR UPDATE", [s.item]);
    pending = commands.commandCanonicalPlanItemCase(session, String(s.item), draft(s)); void pending.catch(() => undefined);
    expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await bill(s, "direct", gate); await gate.query("COMMIT");
    await expect(pending).rejects.toMatchObject({ code: "plan_case_billed_lock" }); expect(await current(s)).toEqual({ case_id: s.caseId, priority: 3 }); expect(await audit(s)).toHaveLength(0);
  } finally { await gate.query("ROLLBACK"); gate.release(); if (pending) await Promise.allSettled([pending]); }
});
it.each(["patient", "item"] as const)("session expiry while waiting on a %s lock cannot mutate or audit", async locked => {
  const s = await scenario(), session = await fx.session("own", 1500), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    if (locked === "patient") await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    else await gate.query("SELECT id FROM plan_items WHERE id=$1 FOR UPDATE", [s.item]);
    pending = commands.commandCanonicalPlanItemCase(session, String(s.item), draft(s)); void pending.catch(() => undefined);
    expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await new Promise(r => setTimeout(r, 1700)); await gate.query("COMMIT");
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/); expect(await audit(s)).toHaveLength(0); expect(await current(s)).toEqual({ case_id: s.caseId, priority: 3 });
  } finally { await gate.query("ROLLBACK"); gate.release(); if (pending) await Promise.allSettled([pending]); }
});
it("a patient removed from own scope during a lock wait cannot be brought back by the requested link", async () => {
  const s = await scenario(), session = await fx.session("own"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = commands.commandCanonicalPlanItemCase(session, String(s.item), draft(s)); void pending.catch(() => undefined);
    expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0);
    await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]); await gate.query("UPDATE clinical_cases SET responsible_party_id=NULL WHERE patient_id=$1", [s.patientId]); await gate.query("COMMIT");
    await expect(pending).rejects.toMatchObject({ code: "plan_item_not_found" }); expect(await audit(s)).toHaveLength(0);
  } finally { await gate.query("ROLLBACK"); gate.release(); if (pending) await Promise.allSettled([pending]); }
});
it("fresh permission proof refuses a revocation committed before the identity fence opens", async () => {
  const s = await scenario(), session = await fx.session("all"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await gate.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: { "clinical.plans.view": true }, patientScope: "all" }, 2)), fx.ids.all]);
    pending = commands.commandCanonicalPlanItemCase(session, String(s.item), draft(s)); void pending.catch(() => undefined);
    expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await gate.query("COMMIT");
    await expect(pending).rejects.toThrow(/STALE/); await expect(command("all", s)).rejects.toThrow(/CAPABILITY_DENIED/); expect(await audit(s)).toHaveLength(0);
  } finally { await gate.query("ROLLBACK"); gate.release(); if (pending) await Promise.allSettled([pending]); await fx.setGrants("all", EDIT, { patientScope: "all" }); }
});
