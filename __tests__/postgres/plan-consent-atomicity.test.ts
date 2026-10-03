import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import type { QueryResult } from "../../lib/db";
import type { Currency } from "../../lib/money";
const target = validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_ENVIRONMENT ??= "test";
process.env.SKIP_SEED = "true";
const db = await import("../../lib/db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;
let serial = 0;
const schedule = { count: 3, everyDays: 30, firstDueDate: "2028-02-29" };
const actor = { actor: "synthetic-consent-actor", actorRole: "admin", note: "Synthetic consent" };
async function fixture(currency: Currency = "YER", fixed = false, existing = false) {
  const patientId = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name)
    VALUES ($1, 'Synthetic consent patient') RETURNING id`, [`CONSENT-${++serial}`]))[0].id;
  const planId = (await q<{ id: number }>(`INSERT INTO treatment_plans
    (patient_id, title, total_minor, base_currency, total_from_items)
    VALUES ($1, 'Synthetic consent plan', $2, $3, $4) RETURNING id`, [patientId, fixed ? 3001 : 99, currency, !fixed]))[0].id;
  if (!fixed) await q(`INSERT INTO plan_items (plan_id, service_name, category, tooth_code, quantity, unit_price_minor)
    VALUES ($1, 'Synthetic filling', 'filling', 11, 1, 3001)`, [planId]);
  if (existing) await q(`INSERT INTO plan_installments (plan_id, number, due_date, amount_minor, last_reminder_at)
    VALUES ($1, 1, '2026-10-03', 1000, '2026-10-02T10:00:00Z'), ($1, 2, '2026-11-03', 2001, NULL)`, [planId]);
  return { planId, patientId };
}
async function snapshot(f: { planId: number; patientId: number }) {
  return (await q<{ data: unknown }>(`SELECT jsonb_build_object(
    'plan', (SELECT to_jsonb(p) FROM treatment_plans p WHERE id = $1),
    'items', (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM plan_items i WHERE plan_id = $1),
    'chart', (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tooth_conditions t WHERE patient_id = $2),
    'schedule', (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM plan_installments i WHERE plan_id = $1),
    'audits', (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a WHERE action = 'plan.consent' AND entity_id = $3)) AS data`,
  [f.planId, f.patientId, String(f.planId)]))[0].data;
}
async function financialSnapshot() {
  const tables = ["cashier_shifts", "expenses", "payables", "patient_opening_balances", "invoices", "invoice_items", "payments", "expense_payable_allocations", "doctor_commission_history", "commission_case_overrides", "inventory_movements", "journal_manual", "journal_manual_lines"];
  const result: Record<string, unknown> = {};
  for (const table of tables) result[table] = await q(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`);
  return result;
}
beforeAll(async () => {
  expect(process.env.NODE_ENV).toBe("test"); expect(process.env.SKIP_SEED).toBe("true");
  expect(validatePostgresTestTarget(process.env).testUrl.toString()).toBe(target.testUrl.toString());
  await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema();
});
afterAll(async () => { await db.resetPoolForTesting(); });

describe("consent, chart, schedule and audit commit as one command", () => {
  it.each(["YER", "SAR", "USD"] as const)("commits exact split in %s without financial postings", async (currency) => {
    const f = await fixture(currency); const before = await financialSnapshot();
    expect(await db.recordPlanConsent({ ...f, ...actor, schedule })).toEqual({ ok: true, itemCount: 1, totalMinor: 3001, installments: 3 });
    const [plan] = await q("SELECT consent_at, consent_by, consent_note, total_minor::text FROM treatment_plans WHERE id = $1", [f.planId]);
    expect(plan).toEqual({ consent_at: expect.any(Date), consent_by: actor.actor, consent_note: actor.note, total_minor: "3001" });
    expect(await q("SELECT number, due_date::text, amount_minor::text FROM plan_installments WHERE plan_id = $1 ORDER BY number", [f.planId]))
      .toEqual([{ number: 1, due_date: "2028-02-29", amount_minor: "1001" }, { number: 2, due_date: "2028-03-30", amount_minor: "1000" }, { number: 3, due_date: "2028-04-29", amount_minor: "1000" }]);
    expect(await q("SELECT stage, recorded_by FROM tooth_conditions WHERE patient_id = $1", [f.patientId]))
      .toEqual([{ stage: "planned", recorded_by: actor.actor }]);
    expect(await q("SELECT actor, actor_role FROM audit_log WHERE action = 'plan.consent' AND entity_id = $1", [String(f.planId)]))
      .toEqual([{ actor: actor.actor, actor_role: actor.actorRole }]);
    expect(await financialSnapshot()).toEqual(before);
    const after = await snapshot(f);
    expect(await db.recordPlanConsent({ ...f, ...actor, schedule })).toMatchObject({ ok: false });
    expect(await snapshot(f)).toEqual(after);
  });
  it.each(["schedule", "chart", "audit"])("rolls back every consent effect on %s insert failure", async (failure) => {
    for (const currency of ["YER", "SAR", "USD"] as const) {
      const f = await fixture(currency); const before = await snapshot(f); const financialBefore = await financialSnapshot();
      const table = failure === "schedule" ? "plan_installments" : failure === "chart" ? "tooth_conditions" : "audit_log";
      const condition = failure === "schedule" ? `NEW.plan_id = ${f.planId} AND NEW.number = 2`
        : failure === "chart" ? `NEW.patient_id = ${f.patientId}` : `NEW.action = 'plan.consent' AND NEW.entity_id = '${f.planId}'`;
      await q(`CREATE FUNCTION reject_consent_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF ${condition} THEN RAISE EXCEPTION 'synthetic consent fault'; END IF; RETURN NEW; END $$`);
      await q(`CREATE TRIGGER reject_consent_write BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION reject_consent_write()`);
      try {
        await expect(db.recordPlanConsent({ ...f, ...actor, schedule })).rejects.toThrow("synthetic consent fault");
        expect(await snapshot(f)).toEqual(before); expect(await financialSnapshot()).toEqual(financialBefore);
      } finally { await q(`DROP TRIGGER reject_consent_write ON ${table}`); await q("DROP FUNCTION reject_consent_write()"); }
      expect(await db.recordPlanConsent({ ...f, ...actor, schedule })).toMatchObject({ ok: true });
    }
  });
  it.each([false, true])("preserves existing schedule on consent-only; fixed=%s", async (fixed) => {
    const f = await fixture("SAR", fixed, true);
    const before = await q("SELECT * FROM plan_installments WHERE plan_id = $1 ORDER BY id", [f.planId]);
    const moneyBefore = await financialSnapshot();
    expect(await db.recordPlanConsent({ ...f, ...actor })).toMatchObject({ ok: true, totalMinor: 3001, installments: 0 });
    expect(await q("SELECT * FROM plan_installments WHERE plan_id = $1 ORDER BY id", [f.planId])).toEqual(before);
    expect(await financialSnapshot()).toEqual(moneyBefore);
  });
  it("preserves already collected financial history on a fixed legacy agreement", async () => {
    const f = await fixture("SAR", true, true);
    await db.openShift({ openedBy: "synthetic-cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
    expect(await db.recordPlanInstallment({ ...f, installmentNumber: 1, planTitle: "Synthetic consent plan", amountMinor: 1000,
      currency: "SAR", baseCurrency: "SAR", exchangeRate: 1, method: "cash", note: null, createdBy: "synthetic-cashier" })).toHaveProperty("paymentId");
    const before = await financialSnapshot(); const installments = await q("SELECT * FROM plan_installments WHERE plan_id = $1 ORDER BY id", [f.planId]);
    expect(await db.recordPlanConsent({ ...f, ...actor })).toMatchObject({ ok: true, totalMinor: 3001, installments: 0 });
    expect(await financialSnapshot()).toEqual(before);
    expect(await q("SELECT * FROM plan_installments WHERE plan_id = $1 ORDER BY id", [f.planId])).toEqual(installments);
  });
  it("refuses existing schedule before recalculation, consent or chart writes", async () => {
    const f = await fixture("YER", false, true); const before = await snapshot(f);
    expect(await db.recordPlanConsent({ ...f, ...actor, schedule })).toMatchObject({ ok: false, message: "للخطة جدول أقساط سلفًا." });
    expect(await snapshot(f)).toEqual(before);
  });
  it.each([{ ...schedule, count: 61 }, { ...schedule, count: -1 }, { ...schedule, everyDays: 0 },
    { ...schedule, firstDueDate: "2026-02-30" }])("validates direct helper input before writes: %j", async (invalid) => {
    const f = await fixture(); const before = await snapshot(f);
    expect(await db.recordPlanConsent({ ...f, ...actor, schedule: invalid })).toMatchObject({ ok: false, status: 400 });
    expect(await snapshot(f)).toEqual(before);
  });
  it.each(["cancelled", "completed"])("refuses %s plans unchanged", async (status) => {
    const f = await fixture(); await q("UPDATE treatment_plans SET status = $2 WHERE id = $1", [f.planId, status]);
    const before = await snapshot(f); expect(await db.recordPlanConsent({ ...f, ...actor, schedule })).toMatchObject({ ok: false });
    expect(await snapshot(f)).toEqual(before);
  });
  it("a zero-priced item cannot cause partial consent when scheduling is requested", async () => {
    const f = await fixture(); await q("UPDATE plan_items SET unit_price_minor = 0 WHERE plan_id = $1", [f.planId]);
    const before = await snapshot(f);
    expect(await db.recordPlanConsent({ ...f, ...actor, schedule })).toMatchObject({ ok: false });
    expect(await snapshot(f)).toEqual(before);
  });
  it("consent-only audit failure also rolls back and preserves the prior schedule", async () => {
    const f = await fixture("SAR", true, true); const before = await snapshot(f);
    await q(`CREATE FUNCTION reject_consent_only_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action = 'plan.consent' AND NEW.entity_id = '${f.planId}' THEN RAISE EXCEPTION 'synthetic consent-only fault'; END IF; RETURN NEW; END $$`);
    await q("CREATE TRIGGER reject_consent_only_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_consent_only_audit()");
    try {
      await expect(db.recordPlanConsent({ ...f, ...actor })).rejects.toThrow("synthetic consent-only fault");
      expect(await snapshot(f)).toEqual(before);
    } finally { await q("DROP TRIGGER reject_consent_only_audit ON audit_log"); await q("DROP FUNCTION reject_consent_only_audit()"); }
  });
  it("keeps standalone scheduling prerequisite and never replaces an existing schedule", async () => {
    const f = await fixture(); const before = await snapshot(f);
    expect(await db.schedulePlanInstallments({ planId: f.planId, ...schedule })).toMatchObject({ ok: false });
    expect(await snapshot(f)).toEqual(before);
    expect(await db.recordPlanConsent({ ...f, ...actor })).toMatchObject({ ok: true, installments: 0 });
    expect(await db.schedulePlanInstallments({ planId: f.planId, ...schedule })).toEqual({ ok: true, count: 3 });
    const after = await snapshot(f);
    expect(await db.schedulePlanInstallments({ planId: f.planId, ...schedule })).toMatchObject({ ok: false });
    expect(await snapshot(f)).toEqual(after);
  });
});

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function pausePlanLock() {
  const paused = deferred(); const release = deferred(); let stopped = false; let pid = 0;
  const pool = db.getPool(); const connect = pool.connect.bind(pool);
  const spy = vi.spyOn(pool, "connect").mockImplementation(async (...args: unknown[]) => {
    if (args.length > 0) return Reflect.apply(connect, pool, args);
    const client = await connect(); const query = client.query.bind(client);
    const backend = (await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    return { async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
      const result = await query<T>(sql, values);
      if (!stopped && /FROM treatment_plans WHERE id = \$1 FOR UPDATE/.test(sql)) {
        stopped = true; pid = backend; paused.resolve(); await release.promise;
      }
      return result;
    }, release: () => client.release() };
  });
  return { paused, release, spy, pid: () => pid };
}
async function assertWaiter(observer: Client, blocker: number) {
  const until = Date.now() + 10_000;
  while (Date.now() < until) {
    const { rows } = await observer.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity
      WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`, [blocker]);
    if (rows.length) { expect(rows[0].pid).not.toBe(blocker); return; }
    await new Promise<void>((done) => setImmediate(done));
  }
  throw new Error("Expected actual PostgreSQL row-lock contention");
}
const addItem = (planId: number) => db.addPlanItem({ planId, serviceId: null, serviceName: "Second synthetic item",
  category: "filling", toothCode: 12, surfaces: null, quantity: 1, unitPriceMinor: 500, note: null });
describe("actual independent PostgreSQL backend consent races", () => {
  it.each(["consent-first", "item-first", "two-consents"])("serializes %s", async (order) => {
    const f = await fixture(); const gate = pausePlanLock(); const observer = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    await observer.connect();
    const first = order === "item-first" ? addItem(f.planId) : db.recordPlanConsent({ ...f, ...actor, schedule });
    let second: Promise<unknown> | undefined;
    try {
      await Promise.race([gate.paused.promise, first.then(() => { throw new Error("Command ended before lock barrier"); })]);
      second = order === "consent-first" ? addItem(f.planId) : db.recordPlanConsent({ ...f, ...actor, schedule });
      await assertWaiter(observer, gate.pid()); gate.release.resolve();
      expect(await first).toMatchObject({ ok: true });
      expect(await second).toMatchObject({ ok: order === "item-first" });
      expect((await q("SELECT total_minor::text FROM treatment_plans WHERE id = $1", [f.planId]))[0].total_minor).toBe(order === "item-first" ? "3501" : "3001");
      expect(await q("SELECT id FROM audit_log WHERE action = 'plan.consent' AND entity_id = $1", [String(f.planId)])).toHaveLength(1);
      expect(await q("SELECT id FROM tooth_conditions WHERE patient_id = $1", [f.patientId])).toHaveLength(order === "item-first" ? 2 : 1);
      expect(await q("SELECT id FROM plan_installments WHERE plan_id = $1", [f.planId])).toHaveLength(3);
    } finally { gate.release.resolve(); await first.catch(() => {}); await second?.catch(() => {}); gate.spy.mockRestore(); await observer.end(); }
  });
});
