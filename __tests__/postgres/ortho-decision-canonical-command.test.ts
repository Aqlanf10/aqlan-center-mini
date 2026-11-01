import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
vi.mock("server-only", () => ({})); assertRealPostgresUrl(); stubPostgresEnv(); vi.stubEnv("SESSION_SECRET", "synthetic-ortho-decision-write-0123456789");
const db = await import("../../lib/db"), commands = await import("../../lib/canonical-ortho-decision-command"), reads = await import("../../lib/canonical-ortho-decisions");
const EDIT = { "clinical.ortho.view": true, "clinical.ortho.edit": true }, BILL = { "finance.invoices.create": true };
const ACCOUNTS = {
  owner: { username: "SYN-ODW-OWNER", role: "admin" },
  own: { username: "SYN-ODW-OWN", role: "doctor", doctor: true, patientScope: "own", grants: EDIT },
  manager: { username: "SYN-ODW-MANAGER", role: "admin", doctor: true, patientScope: "all", grants: EDIT },
  biller: { username: "SYN-ODW-BILLER", role: "reception", patientScope: "all", grants: BILL },
  billOwn: { username: "SYN-ODW-BILLOWN", role: "doctor", doctor: true, patientScope: "own", grants: BILL },
  none: { username: "SYN-ODW-NONE", role: "doctor", doctor: true, patientScope: "none", appointmentScope: "all", grants: { ...EDIT, ...BILL } },
  viewer: { username: "SYN-ODW-VIEWER", role: "admin", patientScope: "all", grants: { "clinical.ortho.view": true } },
  unlinked: { username: "SYN-ODW-UNLINKED", role: "doctor", patientScope: "own", grants: EDIT },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool, seq = 0;
beforeAll(async () => { fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner"); side = new Pool({ connectionString: fx.pool.options.connectionString, max: 4 }); }, 180000);
afterAll(async () => { await side?.end(); await fx?.close(); });
async function scenario(assigned: "own" | "billOwn" | null = "own") {
  const patientId = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$1,$2) RETURNING id", [`SYN-ODW-${++seq}`, assigned ? fx.parties[assigned] : null])).rows[0].id as number;
  const caseId = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by,responsible_doctor_id) VALUES($1,'SYN',$2) RETURNING id", [patientId, assigned ? fx.parties[assigned] : null])).rows[0].id as number;
  const adjustmentId = (await fx.pool.query("INSERT INTO ortho_adjustments(case_id,recorded_by,billing_class,note) VALUES($1,'SYN','REVIEW_REQUIRED','SYN retained private note') RETURNING id", [caseId])).rows[0].id as number;
  return { patientId, caseId, adjustmentId };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
async function draft(s: Scenario, decision: "billed" | "no_charge" = "no_charge", invoiceNumber: string | null = null) {
  const row = (await reads.readCanonicalOrthoDecisions(await fx.session("owner"))).pending.find(r => r.adjustmentId === s.adjustmentId)!;
  return { patientId: s.patientId, expectedVersion: row.decisionContext!.expectedVersion, decision, reason: decision === "no_charge" ? "SYN documented clinical decision" : null, invoiceNumber };
}
const command = async (key: Key, s: Scenario, body: unknown) => commands.commandCanonicalOrthoDecision(await fx.session(key), String(s.adjustmentId), body);
const audit = async (s: Scenario) => (await fx.pool.query("SELECT actor,details FROM audit_log WHERE action='ortho.billing_decision' AND entity_id=$1 ORDER BY id", [String(s.adjustmentId)])).rows;
const state = async (s: Scenario) => (await fx.pool.query("SELECT to_jsonb(a) value FROM ortho_adjustments a WHERE id=$1", [s.adjustmentId])).rows;
async function invoice(s: Scenario, status = "open") {
  const number = `SYN-ODW-INV-${++seq}`, id = (await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,status,total_minor,base_currency,created_by) VALUES($1,$2,$3,123456,'USD','SYN') RETURNING id", [number, s.patientId, status])).rows[0].id as number;
  return { id, number };
}
it("the native responsible clinician and unlinked protected owner may make the existing no-charge decision", async () => {
  for (const key of ["own", "owner"] as const) { const s = await scenario(key === "owner" ? null : "own"), body = await draft(s); expect(await command(key, s, body)).toEqual({ ok: true, adjustmentId: s.adjustmentId, decision: "no_charge" }); expect(await audit(s)).toEqual([{ actor: ACCOUNTS[key].username, details: { القرار: "بلا رسوم", السبب: body.reason } }]); }
});
it.each(["viewer", "none", "unlinked"] as const)("%s cannot inherit mutation from a legacy role or appointment scope", async key => { const s = await scenario(), before = await state(s); await expect(command(key, s, await draft(s))).rejects.toThrow(/CAPABILITY|SCOPE|UNLINKED/); expect(await state(s)).toEqual(before); expect(await audit(s)).toEqual([]); });
it("a delegated doctor-manager with all scope still needs native case responsibility", async () => {
  const s = await scenario(); await expect(command("manager", s, await draft(s))).rejects.toMatchObject({ code: "ortho_decision_responsibility_denied" });
  await fx.pool.query("UPDATE ortho_cases SET responsible_doctor_id=$1 WHERE id=$2", [fx.parties.manager, s.caseId]);
  expect(await command("manager", s, await draft(s))).toMatchObject({ ok: true });
});
it("billing uses its independent create capability, including own scope, without requiring invoice-view or ortho-view", async () => {
  for (const key of ["biller", "billOwn"] as const) { const s = await scenario(key === "billOwn" ? "billOwn" : "own"), inv = await invoice(s); await expect(reads.readCanonicalOrthoDecisions(await fx.session(key))).rejects.toThrow(/CAPABILITY/); expect(await command(key, s, await draft(s, "billed", inv.number))).toEqual({ ok: true, adjustmentId: s.adjustmentId, decision: "billed" }); expect((await state(s))[0].value.billing_invoice_id).toBe(inv.id); }
});
it("branch capabilities never substitute for one another", async () => {
  const s = await scenario(), inv = await invoice(s); await expect(command("own", s, await draft(s, "billed", inv.number))).rejects.toThrow(/CAPABILITY/); await expect(command("biller", s, await draft(s))).rejects.toThrow(/CAPABILITY/); await expect(command("none", s, await draft(s, "billed", inv.number))).rejects.toThrow(/SCOPE/); expect(await audit(s)).toEqual([]);
});
it("outside, absent and mismatched patient references are indistinguishable", async () => {
  const own = await scenario(), outside = await scenario(null), body = await draft(outside);
  for (const [s, b] of [[outside, body], [{ ...outside, adjustmentId: 2147483647 }, body], [own, body]] as const) await expect(command("own", s, b)).rejects.toMatchObject({ code: "ortho_decision_not_found", status: 404 });
});
it("foreign, cancelled and missing invoice numbers refuse without a decision or reference disclosure", async () => {
  const s = await scenario(), outside = await scenario(null), foreign = await invoice(outside), cancelled = await invoice(s, "cancelled");
  for (const number of [foreign.number, cancelled.number, "SYN missing invoice"]) await expect(command("biller", s, await draft(s, "billed", number))).rejects.toMatchObject({ code: "ortho_decision_conflict" }); expect(await audit(s)).toEqual([]);
});
it("a patient-unlinked or foreign visit never becomes a valid command witness", async () => {
  for (const linked of [null, false] as const) {
    const s = await scenario(), other = await scenario(null), body = await draft(s), visit = (await fx.pool.query("INSERT INTO visits(patient_name,patient_id) VALUES('SYN invalid visit',$1) RETURNING id", [linked === null ? null : other.patientId])).rows[0].id;
    await fx.pool.query("UPDATE ortho_adjustments SET visit_id=$1 WHERE id=$2", [visit, s.adjustmentId]);
    try { await expect(command("owner", s, body)).rejects.toMatchObject({ code: "ortho_decision_conflict" }); expect(await audit(s)).toEqual([]); }
    finally { await fx.pool.query("UPDATE ortho_adjustments SET visit_id=NULL WHERE id=$1", [s.adjustmentId]); }
  }
});
it("changed case/adjustment observations and the retained legacy writer prevent replay", async () => {
  const s = await scenario(), old = await draft(s); await fx.pool.query("UPDATE ortho_cases SET note='SYN new care note' WHERE id=$1", [s.caseId]); await expect(command("own", s, old)).rejects.toMatchObject({ code: "ortho_decision_conflict" });
  const fresh = await draft(s); await db.decideOrthoAdjustmentBilling({ adjustmentId: s.adjustmentId, decision: "no_charge", reason: "SYN legacy decision", invoiceNumber: null, actor: "SYN-LEGACY", actorRole: "doctor" }); await expect(command("own", s, fresh)).rejects.toMatchObject({ code: "ortho_decision_conflict" }); expect(await audit(s)).toHaveLength(1);
});
it("two requests actually waiting on the patient produce exactly one decision and one audit", async () => {
  const s = await scenario(), body = await draft(s), sessions = [await fx.session("own"), await fx.session("owner")], gate = await side.connect(); let pending: Promise<unknown>[] = [];
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]); pending = sessions.map(session => commands.commandCanonicalOrthoDecision(session, String(s.adjustmentId), body)); pending.forEach(p => { void p.catch(() => undefined); });
    await vi.waitFor(async () => expect((await side.query("WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT pid FROM blocked", [pid])).rowCount).toBe(2), { timeout: 10000, interval: 10 }); await gate.query("COMMIT"); const results = await Promise.allSettled(pending); expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1); expect(results.filter(r => r.status === "rejected")).toMatchObject([{ reason: { code: "ortho_decision_conflict" } }]); expect(await audit(s)).toHaveLength(1);
  } finally { await gate.query("ROLLBACK"); gate.release(); await Promise.allSettled(pending); }
});
it.each(["expire", "scope", "move", "responsibility", "cancel_invoice"] as const)("%s while waiting for the patient is rechecked before the decision", async kind => {
  const s = await scenario(), other = { patientId: (await fx.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,$1) RETURNING id", [`SYN-ODW-MOVE-${++seq}`])).rows[0].id }, inv = await invoice(s), billed = kind === "cancel_invoice", body = await draft(s, billed ? "billed" : "no_charge", billed ? inv.number : null), session = await fx.session(billed ? "biller" : "own", kind === "expire" ? 1500 : 60000), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [s.patientId]); pending = commands.commandCanonicalOrthoDecision(session, String(s.adjustmentId), body); void pending.catch(() => undefined); await waitForBlockedBy(side, pid);
    if (kind === "expire") await new Promise(r => setTimeout(r, 1700));
    else if (kind === "scope") { await gate.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [s.patientId]); await gate.query("UPDATE ortho_cases SET responsible_doctor_id=NULL WHERE id=$1", [s.caseId]); }
    else if (kind === "move") await gate.query("UPDATE ortho_cases SET patient_id=$1 WHERE id=$2", [other.patientId, s.caseId]);
    else if (kind === "responsibility") await gate.query("UPDATE ortho_cases SET responsible_doctor_id=$1 WHERE id=$2", [fx.parties.manager, s.caseId]);
    else await gate.query("UPDATE invoices SET status='cancelled' WHERE id=$1", [inv.id]);
    await gate.query("COMMIT"); if (kind === "expire") await expect(pending).rejects.toThrow(/SESSION|EXPIRED/); else await expect(pending).rejects.toBeInstanceOf(commands.CanonicalOrthoDecisionRefusal); expect(await audit(s)).toEqual([]);
  } finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); }
});
it("inverse adjustment, case and invoice locks fail closed without a deadlock", async () => {
  for (const table of ["ortho_adjustments", "ortho_cases", "invoices"] as const) { const s = await scenario(), inv = await invoice(s), body = await draft(s, "billed", inv.number), gate = await side.connect();
    try { await gate.query("BEGIN"); await gate.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE`, [table === "ortho_adjustments" ? s.adjustmentId : table === "ortho_cases" ? s.caseId : inv.id]); await expect(command("biller", s, body)).rejects.toMatchObject({ code: "ortho_decision_conflict" }); expect(await audit(s)).toEqual([]); }
    finally { await gate.query("ROLLBACK"); gate.release(); }
  }
});
it("fresh authority after the lifecycle fence refuses a revoked command", async () => {
  const s = await scenario(), body = await draft(s), session = await fx.session("own"), gate = await side.connect(); let pending: Promise<unknown> | undefined;
  try { await gate.query("BEGIN"); const pid = (await gate.query("SELECT pg_backend_pid() pid")).rows[0].pid; await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('aqlan.canonical.identity.substrate.v1:public',0))"); await gate.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: { "clinical.ortho.view": true }, patientScope: "own" }, 2)), fx.ids.own]); pending = commands.commandCanonicalOrthoDecision(session, String(s.adjustmentId), body); void pending.catch(() => undefined); await waitForBlockedBy(side, pid); await gate.query("COMMIT"); await expect(pending).rejects.toThrow(/STALE/); await expect(command("own", s, body)).rejects.toThrow(/CAPABILITY/); expect(await audit(s)).toEqual([]); }
  finally { await gate.query("ROLLBACK"); gate.release(); await pending?.catch(() => undefined); await fx.setGrants("own", EDIT, { patientScope: "own" }); }
});
it("the linked invoice remains locked until the decision and audit commit", async () => {
  const s = await scenario(), inv = await invoice(s), body = await draft(s, "billed", inv.number), original = db.decideOrthoAdjustmentBillingInTransaction;
  let cancelling: Promise<unknown> | undefined;
  const spy = vi.spyOn(db, "decideOrthoAdjustmentBillingInTransaction").mockImplementationOnce(async (client, input) => {
    const result = await original(client, input), pid = (await client.query("SELECT pg_backend_pid() pid")).rows[0].pid;
    cancelling = side.query("UPDATE invoices SET status='cancelled' WHERE id=$1", [inv.id]); void cancelling.catch(() => undefined);
    expect((await waitForBlockedBy(side, pid)).length).toBeGreaterThan(0);
    return result;
  });
  try { expect(await command("biller", s, body)).toMatchObject({ ok: true }); await cancelling; expect(await audit(s)).toHaveLength(1); expect((await state(s))[0].value.billing_invoice_id).toBe(inv.id); }
  finally { spy.mockRestore(); await cancelling?.catch(() => undefined); }
});
it("protected owner preview closes with its read snapshot and cannot be inferred from a manager role", async () => {
  const { runCanonicalReadSnapshot } = await import("../../lib/canonical-read-snapshot");
  for (const key of ["owner", "manager"] as const) {
    let preview: (() => boolean) | undefined;
    const result = await runCanonicalReadSnapshot(await fx.session(key), "read:ortho.decisions", async (_q, scope) => { preview = scope.isProtectedOwner; return { owner: scope.isProtectedOwner() }; }, { errorPrefix: "STAFF_READ", maxBytes: 1024 });
    expect(result.owner).toBe(key === "owner"); expect(preview?.()).toBe(false);
  }
});
it("audit failure and expiry during audit roll back the saved decision atomically", async () => {
  for (const delay of [false, true]) { const s = await scenario(), body = await draft(s), before = await state(s), session = await fx.session("own", delay ? 1500 : 60000);
    await fx.pool.query(`CREATE FUNCTION syn_ortho_decision_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.billing_decision' THEN ${delay ? "PERFORM pg_sleep(1.8)" : "RAISE EXCEPTION 'SYN decision audit failure'"}; END IF; RETURN NEW; END $$; CREATE TRIGGER syn_ortho_decision_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION syn_ortho_decision_audit()`);
    try { await expect(commands.commandCanonicalOrthoDecision(session, String(s.adjustmentId), body)).rejects.toThrow(delay ? /SESSION|EXPIRED/ : /SYN decision audit failure/); expect(await state(s)).toEqual(before); expect(await audit(s)).toEqual([]); }
    finally { await fx.pool.query("DROP TRIGGER syn_ortho_decision_audit ON audit_log; DROP FUNCTION syn_ortho_decision_audit()"); }
  }
});
it("one connection preserves nonempty invoice, payment, shift and currency snapshots", async () => {
  const s = await scenario(), inv = await invoice(s), shift = (await fx.pool.query("INSERT INTO cashier_shifts(opened_by,status,closed_at,closed_by) VALUES('SYN','closed',NOW(),'SYN') RETURNING id")).rows[0].id;
  await fx.pool.query("INSERT INTO payments(receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,method,created_by) VALUES($1,$2,$3,$4,'payment',12345,'USD',1,12345,'USD','cash','SYN')", [`SYN-ODW-PAY-${inv.id}`, s.patientId, inv.id, shift]);
  const snapshot = async () => (await fx.pool.query("SELECT (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i) invoices,(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p) payments,(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM cashier_shifts s) shifts,(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM ortho_cases o) cases")).rows;
  const before = await snapshot(), body = await draft(s, "billed", inv.number), session = await fx.session("biller"), pool = db.getPool(), connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), ensure = vi.spyOn(db, "ensureSchema");
  try { await commands.commandCanonicalOrthoDecision(session, String(s.adjustmentId), body); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); expect(ensure).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); ensure.mockRestore(); }
  expect(await snapshot()).toEqual(before); expect(await audit(s)).toEqual([{ actor: ACCOUNTS.biller.username, details: { القرار: "فوتِرت", الفاتورة: inv.number } }]);
});
