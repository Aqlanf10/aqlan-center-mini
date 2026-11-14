import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy, capabilityDocument } from "./_canonical-ready-fixture";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-proposal-contact-secret-0123456789");
const db = await import("../../lib/db"), reads = await import("../../lib/canonical-proposals"), commands = await import("../../lib/canonical-proposal-contact-command");
const GRANTS = { "clinical.plans.edit": true, "clinical.plans.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-PCONT-OWNER", role: "admin" },
  own: { username: "SYN-PCONT-OWN", role: "doctor", doctor: true, patientScope: "own", grants: GRANTS },
  all: { username: "SYN-PCONT-ALL", role: "reception", patientScope: "all", grants: GRANTS },
  none: { username: "SYN-PCONT-NONE", role: "doctor", doctor: true, patientScope: "none", grants: GRANTS },
  viewer: { username: "SYN-PCONT-VIEWER", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true } },
  unlinked: { username: "SYN-PCONT-UNLINKED", role: "doctor", patientScope: "own", grants: GRANTS },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(own = true) {
  const patientId = Number((await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-PCONT-${++seq}`, own ? fx.parties.own : null])).rows[0].id);
  const planId = Number((await fx.pool.query("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,created_at) VALUES($1,'SYN proposal contact',123456,'YER','2026-10-01') RETURNING id", [patientId])).rows[0].id);
  return { patientId, planId };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
async function draft(s: Scenario) { const row = (await reads.readCanonicalProposals(await fx.session("owner"))).proposals.find(p => p.planId === s.planId)!; return { ...s, expectedVersion: row.contactVersion, note: "SYN completed manual contact" }; }
const command = async (key: Key, body: unknown) => commands.commandCanonicalProposalContact(await fx.session(key), body);
const audit = async (s: Scenario) => (await fx.pool.query("SELECT actor,action,entity,entity_id,details FROM audit_log WHERE action='plan.proposal_contact' AND entity_id=$1 ORDER BY id", [String(s.planId)])).rows;
const planState = async (s: Scenario) => (await fx.pool.query("SELECT to_jsonb(t) value FROM treatment_plans t WHERE id=$1", [s.planId])).rows;
it("owner, own and all may record a manual contact without a finance grant", async () => {
  for (const key of ["owner", "own", "all"] as const) { const s = await scenario(), body = await draft(s), before = await planState(s); const result = await command(key, body); expect(result).toEqual({ ok: true, planId: s.planId, lastContactAt: expect.any(String) }); expect(await planState(s)).toEqual(before); expect(await audit(s)).toMatchObject([{ actor: ACCOUNTS[key].username, action: "plan.proposal_contact", entity: "treatment_plans", details: { المريض: s.patientId, الملاحظة: body.note } }]); }
});
it.each(["viewer", "none", "unlinked"] as const)("%s cannot write through a legacy role", async key => { const s = await scenario(); await expect(command(key, await draft(s))).rejects.toThrow(/CAPABILITY|SCOPE|UNLINKED/); expect(await audit(s)).toEqual([]); });
it("foreign, missing and mismatched patient-plan references have one refusal", async () => {
  const own = await scenario(), outside = await scenario(false), body = await draft(outside);
  for (const input of [body, { ...body, planId: 2147483647 }, { ...body, patientId: own.patientId }]) await expect(command("own", input)).rejects.toMatchObject({ code: "proposal_contact_not_found", status: 404 });
  await expect(command("owner", { ...body, patientId: own.patientId })).rejects.toMatchObject({ code: "proposal_contact_not_found" }); expect(await audit(outside)).toEqual([]);
});
it("empty and maximal notes preserve the existing writer meaning without truncation", async () => {
  for (const note of [null, "   ", "ع".repeat(300)]) { const s = await scenario(), body = await draft(s); await command("own", { ...body, note }); const row = (await audit(s))[0]; expect(row.details).toEqual({ المريض: s.patientId, ...(note?.trim() ? { الملاحظة: note.trim() } : {}) }); }
});
it.each(["consented", "cancelled"] as const)("%s proposal refuses the old observation without an audit", async state => { const s = await scenario(), body = await draft(s); if (state === "consented") await fx.pool.query("UPDATE treatment_plans SET consent_at=NOW() WHERE id=$1", [s.planId]); else await fx.pool.query("UPDATE treatment_plans SET status='cancelled' WHERE id=$1", [s.planId]); await expect(command("own", body)).rejects.toMatchObject({ code: "proposal_contact_conflict" }); expect(await audit(s)).toEqual([]); });
it("current state and prior manual contact invalidate an observation even on the same clinic day", async () => {
  const s = await scenario(), old = await draft(s); await command("own", old); await expect(command("own", old)).rejects.toMatchObject({ code: "proposal_contact_conflict" });
  const fresh = await draft(s); expect(fresh.expectedVersion).not.toBe(old.expectedVersion); await command("all", fresh); expect(await audit(s)).toHaveLength(2);
  const observed = await draft(s); await fx.pool.query("UPDATE treatment_plans SET title=title WHERE id=$1", [s.planId]); await expect(command("own", observed)).rejects.toMatchObject({ code: "proposal_contact_conflict" });
});
it("two same-observation requests really wait on one patient and produce exactly one audit", async () => {
  const s = await scenario(), body = await draft(s), sessions = [await fx.session("own"), await fx.session("all")], gate = await side.connect(); let pending: Promise<unknown>[] = [];
  try {
    await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = sessions.map(session => commands.commandCanonicalProposalContact(session, body)); pending.forEach(p => { void p.catch(() => undefined); });
    await vi.waitFor(async () => expect((await side.query(`WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked`, [pid])).rowCount).toBe(2), { timeout: 10000, interval: 10 });
    await gate.query("COMMIT"); const results = await Promise.allSettled(pending); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toMatchObject([{ reason: { code: "proposal_contact_conflict" } }]); expect(await audit(s)).toHaveLength(1);
  } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(pending); }
});
it("retained legacy contact and inverse plan lock cannot bypass the observation", async () => {
  const s = await scenario(), body = await draft(s), gate = await side.connect();
  try { await gate.query("BEGIN"); await gate.query("SELECT id FROM treatment_plans WHERE id=$1 FOR UPDATE", [s.planId]); await expect(command("own", body)).rejects.toMatchObject({ code: "proposal_contact_conflict" }); expect(await audit(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); }
  await db.recordProposalContact({ planId: s.planId, note: "SYN legacy contact", actor: "SYN-LEGACY", actorRole: "reception" }); await expect(command("own", body)).rejects.toMatchObject({ code: "proposal_contact_conflict" }); expect(await audit(s)).toHaveLength(1);
});
it.each(["expire", "scope", "move"] as const)("%s during actual patient-lock wait is rechecked", async kind => {
  const s = await scenario(), other = await scenario(false), body = await draft(s), session = await fx.session("own", kind === "expire" ? 1500 : 60000), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]);
    pending = commands.commandCanonicalProposalContact(session, body); void pending.catch(() => undefined); expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0);
    if (kind === "expire") await new Promise(resolve => setTimeout(resolve, 1700));
    else if (kind === "scope") await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]);
    else await gate.query("UPDATE treatment_plans SET patient_id=$1 WHERE id=$2", [other.patientId, s.planId]);
    await gate.query("COMMIT"); if (kind === "expire") await expect(pending).rejects.toThrow(/SESSION|EXPIRED/); else await expect(pending).rejects.toMatchObject({ code: "proposal_contact_not_found" }); expect(await audit(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); }
});
it("withdrawal behind the identity fence rejects the signed request and fresh re-login", async () => {
  const s = await scenario(), body = await draft(s), session = await fx.session("all"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]); await gate.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: { "clinical.plans.view": true }, patientScope: "all" }, 2)), fx.ids.all]);
    pending = commands.commandCanonicalProposalContact(session, body); void pending.catch(() => undefined); expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await gate.query("COMMIT"); await expect(pending).rejects.toThrow(/STALE/); await expect(command("all", body)).rejects.toThrow(/CAPABILITY/); expect(await audit(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); await fx.setGrants("all", GRANTS, { patientScope: "all" }); }
});
it("audit failure or expiry inside the audit leaves no committed contact", async () => {
  for (const delay of [false, true]) { const s = await scenario(), body = await draft(s), session = await fx.session("own", delay ? 1500 : 60000), before = await planState(s);
    await fx.pool.query(`CREATE FUNCTION syn_contact_audit_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='plan.proposal_contact' THEN ${delay ? "PERFORM pg_sleep(1.8)" : "RAISE EXCEPTION 'SYN contact audit unavailable'"}; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_contact_audit_gate BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_contact_audit_gate()`);
    try { await expect(commands.commandCanonicalProposalContact(session, body)).rejects.toThrow(delay ? /SESSION|EXPIRED/ : /SYN contact audit unavailable/); expect(await audit(s)).toEqual([]); expect(await planState(s)).toEqual(before); }
    finally { await fx.pool.query("DROP TRIGGER syn_contact_audit_gate ON audit_log; DROP FUNCTION syn_contact_audit_gate()"); }
  }
});
it("uses one connection and preserves retained plan, invoice, installment and payment snapshots", async () => {
  const s = await scenario();
  await fx.pool.query("UPDATE treatment_plans SET last_reminder_at='2026-10-12 09:00+03' WHERE id=$1", [s.planId]);
  await fx.pool.query("INSERT INTO plan_installments(plan_id,number,due_date,amount_minor,last_reminder_at) VALUES($1,1,'2026-10-20',123456,'2026-10-12 09:00+03')", [s.planId]);
  await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,status,total_minor,base_currency,created_by) VALUES($1,$2,'cancelled',0,'YER','SYN')", [`SYN-PCONT-INV-${s.planId}`, s.patientId]);
  const body = await draft(s), session = await fx.session("own"), pool = db.getPool();
  const snapshot = async () => (await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM treatment_plans t) plans,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM plan_installments t) installments,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM invoices t) invoices,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM payments t) payments")).rows;
  const before = await snapshot(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema"), legacy = vi.spyOn(db, "listPendingProposals");
  try { await commands.commandCanonicalProposalContact(session, body); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); legacy.mockRestore(); }
  expect(await snapshot()).toEqual(before); expect(await audit(s)).toHaveLength(1);
});
