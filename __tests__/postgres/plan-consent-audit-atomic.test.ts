import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

// Delay only request-metadata lookup, not any SQL or financial writer. The
// barrier deterministically exposes the old post-COMMIT, unawaited audit window.
const source = vi.hoisted(() => ({ hook: null as null | (() => Promise<void>) }));
vi.mock("../../lib/audit-source", () => ({ currentAuditSource: async () => {
  await source.hook?.();
  return { ip: null, userAgent: "synthetic-consent-barrier" };
} }));
assertRealPostgresUrl(); stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_plan_consent_atomic");
const db = await import("../../lib/db");
const q = (sql: string, values: unknown[] = []) => db.getPool().query(sql, values);
let serial = 0;
beforeAll(async () => { await db.ensureSchema(); });
afterAll(async () => { source.hook = null; await db.resetPoolForTesting(); });
async function fixture() {
  const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic consent atomicity') RETURNING id", [`CONSENT-ATOMIC-${++serial}`])).rows[0].id;
  const planId = (await q("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,status) VALUES($1,'Synthetic consent',1000,'YER','active') RETURNING id", [patientId])).rows[0].id;
  await q("INSERT INTO plan_items(plan_id,service_name,category,tooth_code,quantity,unit_price_minor) VALUES($1,'Synthetic filling','filling',11,1,1000)", [planId]);
  return { planId, patientId, actor: "synthetic-atomic-consent", note: "Synthetic explicit consent" };
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of ["treatment_plans", "plan_items", "tooth_conditions", "audit_log", "invoices", "payments", "plan_installments"]) {
    result[table] = (await q(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM ${table} t`)).rows[0].rows;
  }
  return result;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
it("keeps consent and chart invisible until the delayed audit can persist, then acknowledges all three together", async () => {
  const f = await fixture(), before = await snapshot();
  const entered = deferred(), release = deferred();
  source.hook = async () => { entered.resolve(); await release.promise; };
  const pending = db.recordPlanConsent(f);
  try {
    await entered.promise;
    // Independent connection: never hide audit rows or omit timestamps.
    expect(await snapshot()).toEqual(before);
  } finally {
    release.resolve();
    await pending;
    source.hook = null;
  }
  expect(await pending).toMatchObject({ ok: true, itemCount: 1, totalMinor: 1000 });
  expect((await q("SELECT consent_by,consent_note FROM treatment_plans WHERE id=$1 AND consent_at IS NOT NULL", [f.planId])).rows)
    .toEqual([{ consent_by: f.actor, consent_note: f.note }]);
  expect((await q("SELECT stage FROM tooth_conditions WHERE patient_id=$1", [f.patientId])).rows).toEqual([{ stage: "planned" }]);
  expect((await q("SELECT action,actor,entity_id FROM audit_log WHERE action='plan.consent' AND entity_id=$1", [String(f.planId)])).rows)
    .toEqual([{ action: "plan.consent", actor: f.actor, entity_id: String(f.planId) }]);
  const committed = await snapshot();
  expect(await db.recordPlanConsent(f)).toMatchObject({ ok: false });
  expect(await snapshot()).toEqual(committed);
});

it("rolls back consent and chart when PostgreSQL rejects the consent audit", async () => {
  const f = await fixture();
  await q(`CREATE FUNCTION reject_synthetic_consent_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='plan.consent' THEN RAISE EXCEPTION 'synthetic consent audit refused'; END IF; RETURN NEW; END $$`);
  await q("CREATE TRIGGER reject_synthetic_consent_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_synthetic_consent_audit()");
  try {
    const before = await snapshot();
    await expect(db.recordPlanConsent(f)).rejects.toThrow("synthetic consent audit refused");
    expect(await snapshot()).toEqual(before);
  } finally {
    await q("DROP TRIGGER reject_synthetic_consent_audit ON audit_log");
    await q("DROP FUNCTION reject_synthetic_consent_audit()");
  }
});
