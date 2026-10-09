import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * Case links are live commission inputs. Once an invoice line retains a source
 * procedure, a clinical case edit must not silently reprice that historical line.
 * All financial operations below use the canonical services on real PostgreSQL.
 * Only synthetic event timestamps are fixed afterwards, to exercise a historical
 * cutoff without wall-clock dependence. No runtime/financial service is mocked.
 */
const { session } = vi.hoisted(() => ({
  session: { current: { userId: 1, username: "case-freeze-admin", role: "admin", expiresAt: 4_102_444_800_000 } },
}));
vi.mock("../../lib/session", () => ({ requireSession: vi.fn(async () => session.current) }));

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const { PUT } = await import("../../app/api/plan-items/[id]/case/route");
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> =>
  (await db.getPool().query(sql, params)).rows as T[];
let sequence = 0;
let serviceId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  await db.openShift({ openedBy: "case-freeze-cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  serviceId = (await q<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured, is_active)
     VALUES ('SYNTHETIC case attribution work', 'endo', 10000, TRUE, TRUE) RETURNING id`,
  ))[0].id;
}, 180_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function scenario(options: { sessions?: number; billingRule?: "on_start" | "on_completion"; initialCase?: boolean; funded?: boolean } = {}) {
  sequence += 1;
  const name = `SYNTHETIC case-freeze patient ${sequence}`;
  const patientId = (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`CASE-FREEZE-${sequence}`, name],
  ))[0].id;
  const doctor = await db.createParty({ name: `SYNTHETIC case-freeze doctor ${sequence}`, kind: "doctor", phone: null, commissionPercent: 30, note: null });
  const createCase = async (title: string, percent: number) => {
    const result = await db.createClinicalCase({
      patientId, specialty: "endodontics", title, site: null, problem: null,
      responsiblePartyId: doctor.id, orthoCaseId: null, actor: "case-freeze-admin", actorRole: "admin",
    });
    if (!result.ok || result.case.id === null) throw new Error("case fixture failed");
    const override = await db.createCaseOverride({
      doctorId: doctor.id, caseId: result.case.id, planId: null, action: "set", percent,
      reason: "SYNTHETIC historical agreement", effectiveDate: "2024-01-01", supersedesId: null,
      actor: "case-freeze-admin", actorRole: "admin",
    });
    if (!override.ok) throw new Error(override.message);
    return result.case.id;
  };
  const caseA = await createCase("SYNTHETIC case A", 20);
  const caseB = await createCase("SYNTHETIC case B", 50);
  const plan = await db.createPlanV2({
    patientId, title: "SYNTHETIC attribution plan", specialty: null, primaryDoctorId: doctor.id,
    billingMode: "per_procedure", baseCurrency: "YER", startDate: "2024-01-01", note: null, createdBy: "case-freeze-admin",
    items: [{ serviceId, serviceName: "SYNTHETIC case attribution work", category: "endo", toothCode: null,
      surfaces: null, quantity: 1, unitPriceMinor: 10000, billingRule: options.billingRule ?? "on_completion",
      sessionCount: options.sessions ?? 1, note: null }],
    installments: options.funded ? [{ dueDate: "2024-01-01", amountMinor: 10000 }] : [],
  });
  if (!plan.ok) throw new Error(plan.message);
  const itemId = (await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [plan.planId]))[0].id;
  const initialCase = options.initialCase === false ? null : caseA;
  expect(await db.setPlanItemCase({ itemId, caseId: initialCase, priority: 1, actor: "case-freeze-admin" })).toEqual({ ok: true });
  expect(await db.recordPlanConsent({ planId: plan.planId, actor: "case-freeze-admin", note: null })).toMatchObject({ ok: true });
  const visit = await db.addVisit({ patientId, patientName: name, patientPhone: null, note: null });
  await q(`UPDATE visits SET doctor_id = $2, diagnosis = 'SYNTHETIC diagnosis' WHERE id = $1`, [visit.id, doctor.id]);
  expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [{
    serviceId, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 10000,
    doctorId: doctor.id, note: null, planItemId: itemId,
  }] })).toBe(true);
  return { patientId, doctorId: doctor.id, planId: plan.planId, itemId, caseA, caseB, visitId: visit.id, initialCase };
}
type Scenario = Awaited<ReturnType<typeof scenario>>;
const relink = (s: Scenario, caseId: number | null, priority = 2) =>
  db.setPlanItemCase({ itemId: s.itemId, caseId, priority, actor: "case-freeze-admin", actorRole: "admin" });
const sign = (s: Scenario) => db.signClinicalVisit({
  visitId: s.visitId, baseCurrency: "YER", signedBy: "case-freeze-admin", signerDoctorPartyId: s.doctorId,
});
async function signedInvoice(s: Scenario) {
  const signed = await sign(s);
  expect(signed).toMatchObject({ reason: null, duesMinor: 10000, sessionsCompleted: 1 });
  if (signed.invoiceId === null) throw new Error("expected canonical signed invoice");
  // Fixture chronology only. Financial values and source links stay untouched.
  await q(`UPDATE invoices SET created_at = '2024-03-10T06:00:00Z' WHERE id = $1`, [signed.invoiceId]);
  return signed.invoiceId;
}
async function pay(s: Scenario, invoiceId: number, amountMinor: number, at: string, reversalOfId: number | null = null) {
  const result = await db.recordPayment({
    patientId: s.patientId, invoiceId: reversalOfId === null ? invoiceId : null,
    kind: reversalOfId === null ? "payment" : "refund", amountMinor, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, method: "cash", note: "SYNTHETIC attribution receipt", createdBy: "case-freeze-cashier", reversalOfId,
  });
  expect(result.reason).toBeNull();
  if (!result.payment) throw new Error("payment fixture failed");
  await q(`UPDATE payments SET created_at = $2::timestamptz WHERE id = $1`, [result.payment.id, at]);
  return result.payment.id;
}
async function financialState(s: Scenario) {
  return q(`SELECT jsonb_build_object(
    'invoices', (SELECT jsonb_agg(i ORDER BY i.id) FROM invoices i WHERE i.patient_id = $1),
    'lines', (SELECT jsonb_agg(ii ORDER BY ii.id) FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.patient_id = $1),
    'payments', (SELECT jsonb_agg(p ORDER BY p.id) FROM payments p WHERE p.patient_id = $1),
    'history', (SELECT jsonb_agg(h ORDER BY h.id) FROM doctor_commission_history h WHERE h.party_id = $2),
    'overrides', (SELECT jsonb_agg(o ORDER BY o.id) FROM commission_case_overrides o WHERE o.doctor_id = $2)
  ) AS state`, [s.patientId, s.doctorId]);
}
async function clinicalState(s: Scenario) {
  return q(`SELECT case_id, priority FROM plan_items WHERE id = $1`, [s.itemId]);
}
async function caseAuditCount(s: Scenario) {
  return q(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'plan.item_case' AND entity_id = $1`, [String(s.patientId)]);
}
async function report(s: Scenario, to = "2024-12-31") {
  const detail = await db.commissionDetailReport("2024-01-01", to, { doctorId: s.doctorId });
  const total = (await db.commissionReport("2024-01-01", to)).find(row => row.doctorId === s.doctorId && row.currency === "YER");
  expect(detail.lines).toHaveLength(1);
  expect(total).toBeDefined();
  expect(detail.rows).toHaveLength(1);
  expect(detail.lines[0].earnedMinor).toBe(total!.earnedMinor);
  expect(detail.lines[0].accruedMinor).toBe(total!.accruedMinor);
  expect(detail.rows[0].earnedMinor).toBe(total!.earnedMinor);
  return detail;
}
async function expectFrozen(s: Scenario, target: number | null) {
  const before = { financial: await financialState(s), clinical: await clinicalState(s), audit: await caseAuditCount(s) };
  expect.soft(await relink(s, target)).toEqual({ ok: false, reason: "billed_case_lock" });
  expect.soft(await financialState(s)).toEqual(before.financial);
  expect.soft(await clinicalState(s)).toEqual(before.clinical);
  expect.soft(await caseAuditCount(s)).toEqual(before.audit);
}

describe("historical commission case attribution", () => {
  it("keeps draft relink/detach and unsigned saved procedures editable after consent", async () => {
    const s = await scenario();
    for (const caseId of [s.caseB, null, s.caseA]) {
      expect(await relink(s, caseId)).toEqual({ ok: true });
      expect(await clinicalState(s)).toEqual([{ case_id: caseId, priority: 2 }]);
    }
  });

  it("keeps a signed included session editable; clinical status alone is not the financial boundary", async () => {
    const s = await scenario({ sessions: 2, funded: true });
    expect(await sign(s)).toMatchObject({ reason: null, invoiceId: null, duesMinor: 0, sessionsCompleted: 1 });
    expect(await q(`SELECT status FROM plan_items WHERE id = $1`, [s.itemId])).toEqual([{ status: "in_progress" }]);
    expect(await relink(s, s.caseB)).toEqual({ ok: true });
  });

  it("does not freeze an included item merely because its plan has a paid installment invoice", async () => {
    const s = await scenario({ sessions: 2, funded: true });
    const paid = await db.recordPlanInstallment({
      patientId: s.patientId, planId: s.planId, installmentNumber: 1, planTitle: "SYNTHETIC attribution plan",
      amountMinor: 10000, currency: "YER", baseCurrency: "YER", exchangeRate: 1,
      method: "cash", note: null, createdBy: "case-freeze-cashier",
    });
    if (!("invoiceId" in paid)) throw new Error(paid.reason);
    expect(await sign(s)).toMatchObject({ reason: null, invoiceId: null, sessionsCompleted: 1 });
    await q(`UPDATE invoices SET created_at = '2024-03-10T06:00:00Z' WHERE id = $1`, [paid.invoiceId]);
    await q(`UPDATE payments SET created_at = '2024-04-10T06:00:00Z' WHERE id = $1`, [paid.paymentId]);
    const before = { financial: await financialState(s), report: await report(s) };
    expect(before.report.lines[0]).toMatchObject({ caseId: null, planId: s.planId, percent: 30, earnedMinor: 3000 });
    expect(await relink(s, s.caseB)).toEqual({ ok: true });
    expect(await financialState(s)).toEqual(before.financial);
    expect(await report(s)).toEqual(before.report);
  });

  it("protects an on-completion zero-valued invoice once its source attribution is retained", async () => {
    const s = await scenario({ sessions: 2 });
    const signed = await sign(s);
    expect(signed).toMatchObject({ reason: null, duesMinor: 0, sessionsCompleted: 1 });
    expect(signed.invoiceId).not.toBeNull();
    expect(await q(`SELECT total_minor::int AS amount FROM invoice_items WHERE invoice_id = $1`, [signed.invoiceId]))
      .toEqual([{ amount: 0 }]);
    await expectFrozen(s, s.caseB);
  });

  it.each(["relink", "detach", "assign formerly unassigned"] as const)("freezes unpaid billed attribution: %s", async mode => {
    const s = await scenario({ initialCase: mode !== "assign formerly unassigned" });
    await signedInvoice(s);
    await expectFrozen(s, mode === "detach" ? null : s.caseB);
  });

  it("freezes a partially completed on-start item with a billed first session", async () => {
    const s = await scenario({ sessions: 2, billingRule: "on_start" });
    await signedInvoice(s);
    expect(await q(`SELECT status FROM plan_items WHERE id = $1`, [s.itemId])).toEqual([{ status: "in_progress" }]);
    await expectFrozen(s, s.caseB);
  });

  it.each(["case B", "null"] as const)("preserves original-payment/refund totals, detail and old cutoffs after rejected change to %s", async target => {
    const s = await scenario();
    const invoiceId = await signedInvoice(s);
    const origin = await pay(s, invoiceId, 6000, "2024-04-10T06:00:00Z");
    await pay(s, invoiceId, 4000, "2024-05-10T06:00:00Z");
    const refund = await pay(s, invoiceId, 2000, "2024-06-10T06:00:00Z", origin);
    expect(await q(`SELECT reversal_of_id FROM payments WHERE id = $1`, [refund])).toEqual([{ reversal_of_id: origin }]);
    const current = await report(s);
    const historical = await report(s, "2024-05-31");
    expect(current.lines[0]).toMatchObject({ caseId: s.caseA, percent: 20, ruleSource: "case_override", accruedMinor: 2000, earnedMinor: 1600, invoiceCoveredMinor: 8000 });
    expect(historical.lines[0]).toMatchObject({ accruedMinor: 2000, earnedMinor: 2000, invoiceCoveredMinor: 10000 });
    await expectFrozen(s, target === "null" ? null : s.caseB);
    expect.soft(await report(s)).toEqual(current);
    expect.soft(await report(s, "2024-05-31")).toEqual(historical);
  });

  it.each([true, false])("allows unchanged case attribution (assigned=%s), priority edits and idempotent billed saves", async initialCase => {
    const s = await scenario({ initialCase });
    await signedInvoice(s);
    const before = { financial: await financialState(s), report: await report(s) };
    expect(await relink(s, s.initialCase, 8)).toEqual({ ok: true });
    expect(await relink(s, s.initialCase, 8)).toEqual({ ok: true });
    expect(await clinicalState(s)).toEqual([{ case_id: s.initialCase, priority: 8 }]);
    expect(await financialState(s)).toEqual(before.financial);
    expect(await report(s)).toEqual(before.report);
  });

  it("retains the guard after full refund and invoice cancellation while the historical source line remains", async () => {
    const s = await scenario();
    const invoiceId = await signedInvoice(s);
    const origin = await pay(s, invoiceId, 10000, "2024-04-10T06:00:00Z");
    await pay(s, invoiceId, 10000, "2024-05-10T06:00:00Z", origin);
    // Simulate a historical cancelled invoice; do not delete its retained source.
    await q(`UPDATE invoices SET status = 'cancelled' WHERE id = $1`, [invoiceId]);
    await expectFrozen(s, s.caseB);
  });

  it("uses retained billed-source evidence even when a legacy item still says planned", async () => {
    const s = await scenario();
    await signedInvoice(s);
    // Compatibility fixture: status is not the source of financial attribution.
    await q(`UPDATE plan_items SET status = 'planned', started_at = NULL, done_at = NULL, visit_id = NULL WHERE id = $1`, [s.itemId]);
    await expectFrozen(s, null);
  });

  it.each(["admin", "doctor"])("returns a deliberate HTTP conflict through the real case route for %s and permits priority-only edits", async role => {
    const s = await scenario();
    await signedInvoice(s);
    const user = await db.createStaffUser({
      username: `case-freeze-route-${sequence}`, displayName: "SYNTHETIC route user",
      passwordHash: "synthetic-not-a-usable-hash", role, partyId: s.doctorId,
    });
    session.current = { userId: user.id, username: user.username, role, expiresAt: 4_102_444_800_000 };
    const request = (caseId: number | null) => new Request(`http://localhost/api/plan-items/${s.itemId}/case`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ caseId, priority: 6 }),
    });
    const before = await clinicalState(s);
    const audit = await caseAuditCount(s);
    const refusal = await PUT(request(s.caseB), { params: Promise.resolve({ id: String(s.itemId) }) });
    expect.soft(refusal.status).toBe(409);
    expect.soft((await refusal.json()).message).toMatch(/فاتورة.*الأولوية/);
    expect.soft(await caseAuditCount(s)).toEqual(audit);
    expect.soft(await clinicalState(s)).toEqual(before);
    const allowed = await PUT(request(s.caseA), { params: Promise.resolve({ id: String(s.itemId) }) });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true });
  });
});

/** An independent observer proves actual lock contention, rather than assuming
 * a race from Promise.all or sleep. Triggers gate canonical transactions only in
 * this isolated test schema; every gate is released in finally. */
async function waitForLock(witness: Client, pattern: string, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await witness.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database()
        AND pid <> pg_backend_pid() AND pid <> $2 AND state = 'active'
        AND wait_event_type = 'Lock' AND query ~ $1
        AND $2::int = ANY(pg_blocking_pids(pid))`, [pattern, blockerPid]);
    if (rows[0]) return rows[0].pid;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected actual PostgreSQL lock waiter blocked by PID ${blockerPid}: ${pattern}`);
}
async function gatedRace(s: Scenario, first: "sign" | "relink") {
  const gate = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  const witness = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  const table = first === "sign" ? "visits" : "plan_items";
  const column = first === "sign" ? "signed_at" : "case_id";
  const id = first === "sign" ? s.visitId : s.itemId;
  let pending: Promise<unknown>[] = [];
  await gate.connect();
  await witness.connect();
  try {
    const { rows: [gateBackend] } = await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const { rows: [witnessBackend] } = await witness.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    await q(`CREATE FUNCTION case_freeze_test_gate() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(194280, 1); RETURN NEW; END $$`);
    await q(`CREATE TRIGGER case_freeze_test_gate BEFORE UPDATE OF ${column} ON ${table}
      FOR EACH ROW WHEN (NEW.id = ${id} AND NEW.${column} IS DISTINCT FROM OLD.${column})
      EXECUTE FUNCTION case_freeze_test_gate()`);
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(194280, 1)");
    const firstOperation = first === "sign" ? sign(s) : relink(s, s.caseB);
    pending = [firstOperation];
    const firstPid = await waitForLock(
      witness, first === "sign" ? "UPDATE visits SET signed_at" : "UPDATE plan_items SET case_id", gateBackend.pid,
    );
    const secondOperation = first === "sign" ? relink(s, s.caseB) : sign(s);
    pending.push(secondOperation);
    // Both services lock the patient before the visit/plan item. Prove the
    // second backend waits on the first, which still waits on our trigger gate.
    const secondPid = await waitForLock(
      witness, "^SELECT id FROM patients WHERE id = \\$1 FOR NO KEY UPDATE$", firstPid,
    );
    expect(new Set([gateBackend.pid, witnessBackend.pid, firstPid, secondPid]).size).toBe(4);
    await gate.query("COMMIT");
    const outcomes = await Promise.all(pending);
    return first === "sign" ? { signed: outcomes[0], linked: outcomes[1] } : { signed: outcomes[1], linked: outcomes[0] };
  } finally {
    await gate.query("ROLLBACK").catch(() => {});
    await Promise.allSettled(pending);
    await q(`DROP TRIGGER IF EXISTS case_freeze_test_gate ON ${table}`);
    await q("DROP FUNCTION IF EXISTS case_freeze_test_gate()");
    await gate.end();
    await witness.end();
  }
}

describe("case edit versus signing uses the canonical patient-first lock order", () => {
  it("rejects an edit that waited behind signature and its newly committed invoice", async () => {
    const s = await scenario();
    const result = await gatedRace(s, "sign");
    expect(result.signed).toMatchObject({ reason: null, duesMinor: 10000 });
    expect.soft(result.linked).toEqual({ ok: false, reason: "billed_case_lock" });
    expect.soft(await clinicalState(s)).toEqual([{ case_id: s.caseA, priority: 1 }]);
  });
  it("allows the edit that wins before signature, and the later invoice uses that attribution", async () => {
    const s = await scenario();
    const result = await gatedRace(s, "relink");
    expect(result.linked).toEqual({ ok: true });
    expect(result.signed).toMatchObject({ reason: null, duesMinor: 10000 });
    expect(await clinicalState(s)).toEqual([{ case_id: s.caseB, priority: 2 }]);
    await q(`UPDATE invoices SET created_at = '2024-03-10T06:00:00Z' WHERE patient_id = $1`, [s.patientId]);
    expect((await report(s)).lines[0]).toMatchObject({ caseId: s.caseB, percent: 50, accruedMinor: 5000 });
  });
});
