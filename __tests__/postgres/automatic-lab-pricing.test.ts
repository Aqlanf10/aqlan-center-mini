import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { LabOrderPricingConflict } from "../../lib/lab-order-pricing";
import type { Currency } from "../../lib/money";

// Original environment is checked before any rewrite/import/SQL. Disposable
// owned loopback PostgreSQL 18 only; no schema resets, real data or Production.
validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) =>
  (await db.getPool().query<T>(sql, values)).rows;
const id = async (sql: string, values: unknown[] = []) => (await q<{ id: number }>(sql, values))[0].id;
type Input = Parameters<typeof db.createLabOrder>[0];
const keys = ["finance.rate.USD", "finance.rate.SAR"];
let priorRates: { key: string; value: string; updated_at: Date }[] = [];
let ratesCaptured = false;
const run = `synthetic-fx-${Date.now().toString(36)}`;
let sequence = 0;

async function rate(key: string, value: string | null) {
  if (value === null) await q("DELETE FROM settings WHERE key = $1", [key]);
  else await q(`INSERT INTO settings(key,value) VALUES ($1,$2)
    ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [key, value]);
}
beforeAll(async () => {
  await db.ensureSchema();
  priorRates = await q("SELECT key,value,updated_at FROM settings WHERE key = ANY($1::text[])", [keys]);
  ratesCaptured = true;
}, 180_000);
beforeEach(async () => {
  await rate(keys[0], "531.125");
  await rate(keys[1], "141.25");
  db.invalidateSettingsCache();
});
afterAll(async () => {
  for (const key of ratesCaptured ? keys : []) {
    const previous = priorRates.find(row => row.key === key);
    if (previous) await q(`INSERT INTO settings(key,value,updated_at) VALUES ($1,$2,$3)
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`,
    [previous.key, previous.value, previous.updated_at]);
    else await q("DELETE FROM settings WHERE key=$1", [key]);
  }
  db.invalidateSettingsCache();
  await db.resetPoolForTesting();
});

async function fixture(currency = "USD", unitCost = "2500", toothScope = "single_tooth") {
  const n = ++sequence;
  const patientId = await id(`INSERT INTO patients(patient_number,full_name)
    VALUES($1,'Synthetic FX patient') RETURNING id`, [`${run}-${n}`]);
  const partyId = await id(`INSERT INTO parties(name,kind,currency)
    VALUES($1,'lab','YER') RETURNING id`, [`${run}-lab-${n}`]);
  const serviceId = await id(`INSERT INTO lab_services(name,code,category,tooth_scope)
    VALUES('Synthetic FX crown',$1,'prostho',$2) RETURNING id`, [`${run}-service-${n}`, toothScope]);
  const ruleId = await id(`INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by)
    VALUES($1,$2,$3,$4,'2026-01-01','synthetic-fx-actor') RETURNING id`, [partyId, serviceId, unitCost, currency]);
  const input: Input = { patientId, partyId, labServiceId: serviceId, labName: `${run}-lab-${n}`,
    labPhone: null, workType: "Synthetic FX crown", details: "Synthetic details", note: "Synthetic note",
    sentDate: "2026-10-03", dueDate: "2026-10-10", costMinor: null, costCurrency: null,
    baseCurrency: "YER", exchangeRate: 1, createdBy: "synthetic-fx-actor", actorRole: "admin",
    toothNumbers: "16,17,18", source: "manual", status: "sent", isPosted: true };
  return { input, ruleId };
}
async function snapshot() {
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const table of ["patients", "visits", "parties", "lab_services", "lab_pricing_rules", "lab_orders", "lab_order_tracking", "payables", "audit_log"]) {
    result[table] = await q(`SELECT * FROM ${table} ORDER BY id`);
  }
  return result;
}
async function assertFinancialPair(input: Input, expected: { cost: number; currency: Currency; rate: number; base: number }) {
  const order = await db.createLabOrder(input);
  expect(order).not.toBeNull();
  const [stored] = await q(`SELECT * FROM lab_orders WHERE id=$1`, [order!.id]);
  expect(stored).toMatchObject({ patient_id: input.patientId, cost_minor: String(expected.cost), cost_currency: expected.currency,
    base_amount_minor: String(expected.base), is_posted: input.isPosted !== false, source: input.source ?? "manual",
    details: input.details, note: input.note, tooth_numbers: input.toothNumbers,
    expense_account_code: "5101", payable_account_code: "2101" });
  expect(Number(stored.exchange_rate)).toBe(expected.rate);
  const payable = await q(`SELECT id,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,is_posted
    FROM payables WHERE lab_order_id=$1`, [order!.id]);
  if (expected.cost === 0) expect(payable).toEqual([]);
  else {
    expect(payable).toHaveLength(1);
    expect(payable[0]).toEqual({ id: stored.payable_id, amount_minor: String(expected.cost), currency: expected.currency,
      exchange_rate: stored.exchange_rate, base_amount_minor: stored.base_amount_minor,
      base_currency: "YER", is_posted: input.isPosted !== false });
  }
  expect(await q(`SELECT action,actor,actor_role,to_status FROM lab_order_tracking WHERE lab_order_id=$1`, [order!.id]))
    .toEqual([{ action: "create", actor: "synthetic-fx-actor", actor_role: "admin", to_status: "sent" }]);
  return order!;
}

describe("owned PostgreSQL automatic rule FX snapshots", () => {
  it.each([
    ["USD", 531.125, 39834], ["SAR", 141.25, 10594], ["YER", 1, 7500],
  ] as const)("uses configured %s rate for automatic quantity and both persisted rows", async (currency, exchangeRate, base) => {
    const f = await fixture(currency);
    await assertFinancialPair(f.input, { cost: 7500, currency, rate: exchangeRate, base });
  });
  it.each(["single_tooth", "multi_teeth_bridge", "full_arch", "general"])("preserves %s pricing quantity", async scope => {
    const f = await fixture("SAR", "2500", scope);
    const cost = ["single_tooth", "multi_teeth_bridge"].includes(scope) ? 7500 : 2500;
    await assertFinancialPair(f.input, { cost, currency: "SAR", rate: 141.25, base: cost === 7500 ? 10594 : 3531 });
  });
  it("keeps effective-date and newest-ID tie-break selection, ignores client currency/rate for omitted cost", async () => {
    const f = await fixture("USD", "1000");
    await db.createLabPricingRule({ partyId: f.input.partyId!, labServiceId: f.input.labServiceId!, costMinor: 3000,
      costCurrency: "SAR", effectiveFrom: "2026-01-01", createdBy: "synthetic-fx-actor" });
    await db.createLabPricingRule({ partyId: f.input.partyId!, labServiceId: f.input.labServiceId!, costMinor: 9999,
      costCurrency: "YER", effectiveFrom: "2026-11-01", createdBy: "synthetic-fx-actor" });
    await assertFinancialPair({ ...f.input, costCurrency: "USD", exchangeRate: 7, isPosted: false },
      { cost: 9000, currency: "SAR", rate: 141.25, base: 12713 });
  });
  it("uses actual transaction settings despite a stale process cache", async () => {
    const f = await fixture();
    expect((await db.getSettings())["finance.rate.USD"]).toBe("531.125");
    await rate(keys[0], "540");
    await assertFinancialPair(f.input, { cost: 7500, currency: "USD", rate: 540, base: 40500 });
  });
  it("preserves explicit manual caller rate and cost even without configured FX or a usable rule", async () => {
    const f = await fixture("EUR", "-100");
    await rate(keys[0], null);
    await assertFinancialPair({ ...f.input, costMinor: 12345, costCurrency: "USD", exchangeRate: 530, toothNumbers: "16,17,18" },
      { cost: 12345, currency: "USD", rate: 530, base: 65429 });
  });
  it("USD requires only its own configured rate and missing SAR cannot use defaults", async () => {
    const usd = await fixture("USD");
    await rate(keys[1], null);
    await assertFinancialPair(usd.input, { cost: 7500, currency: "USD", rate: 531.125, base: 39834 });
    const sar = await fixture("SAR");
    const before = await snapshot();
    await expect(db.createLabOrder(sar.input)).rejects.toMatchObject({ code: "lab_order_exchange_rate_invalid" });
    expect(await snapshot()).toEqual(before);
  });
  it("retains legitimate free rules, requiring valid foreign FX", async () => {
    const f = await fixture("USD", "0");
    await assertFinancialPair(f.input, { cost: 0, currency: "USD", rate: 531.125, base: 0 });
  });
  it("YER automatic cost needs no stored foreign rate and ignores the placeholder", async () => {
    const f = await fixture("YER");
    await rate(keys[0], null); await rate(keys[1], null);
    await assertFinancialPair({ ...f.input, exchangeRate: 73 }, { cost: 7500, currency: "YER", rate: 1, base: 7500 });
  });
  it.each([null, "", " ", "0", "-1", "NaN", "Infinity", "bad", "0.0000001", "1.0000004", "1000001"])(
    "rejects %j FX with identical pre/post records and no partial writer effects", async value => {
      const f = await fixture();
      await rate(keys[0], value);
      const before = await snapshot();
      await expect(db.createLabOrder(f.input)).rejects.toMatchObject({ code: "lab_order_exchange_rate_invalid" });
      expect(await snapshot()).toEqual(before);
    });
  it.each([
    ["EUR", "2500"], ["USD", "-1"], ["YER", "9007199254740993"],
    ["YER", "4503599627370496"], ["USD", "2000000000000000"],
  ])("rejects unsafe automatic %s/%s values without partial effects", async (currency, cost) => {
    const f = await fixture(currency, cost);
    const before = await snapshot();
    await expect(db.createLabOrder(f.input)).rejects.toBeInstanceOf(LabOrderPricingConflict);
    expect(await snapshot()).toEqual(before);
  });
  it.each(["SAR", "USD"] as const)("fails closed for unsupported automatic base %s", async baseCurrency => {
    const f = await fixture();
    const before = await snapshot();
    await expect(db.createLabOrder({ ...f.input, baseCurrency })).rejects.toMatchObject({ code: "lab_order_automatic_price_invalid" });
    expect(await snapshot()).toEqual(before);
  });
  it.each(["needed", "no rule"] as const)("preserves %s without configured rates or a payable", async kind => {
    const f = await fixture();
    await rate(keys[0], null); await rate(keys[1], null);
    const input = kind === "needed" ? { ...f.input, status: "needed" as const }
      : { ...f.input, sentDate: "2025-01-01" };
    const order = await db.createLabOrder(input);
    expect(order).not.toBeNull();
    expect(await q(`SELECT cost_minor,cost_currency,base_amount_minor,payable_id FROM lab_orders WHERE id=$1`, [order!.id]))
      .toEqual([{ cost_minor: null, cost_currency: null, base_amount_minor: null, payable_id: null }]);
    expect(await q("SELECT * FROM payables WHERE lab_order_id=$1", [order!.id])).toEqual([]);
  });
  it("later FX or pricing changes do not rewrite historical snapshots", async () => {
    const f = await fixture();
    await assertFinancialPair(f.input, { cost: 7500, currency: "USD", rate: 531.125, base: 39834 });
    const beforeOrders = await q("SELECT * FROM lab_orders ORDER BY id");
    const beforePayables = await q("SELECT * FROM payables ORDER BY id");
    await rate(keys[0], "600");
    await q("UPDATE lab_pricing_rules SET cost_minor=9999 WHERE id=$1", [f.ruleId]);
    expect(await q("SELECT * FROM lab_orders ORDER BY id")).toEqual(beforeOrders);
    expect(await q("SELECT * FROM payables ORDER BY id")).toEqual(beforePayables);
  });
  it("rolls back a newly created party and trigger-created rule when FX is missing", async () => {
    const f = await fixture();
    await rate(keys[0], null);
    const newName = `${run}-rollback-party`;
    // A fixture-only trigger makes a rule available immediately after the writer
    // inserts its new party, so this tests rollback of earlier created effects.
    let functionCreated = false;
    let triggerCreated = false;
    try {
      await q(`CREATE FUNCTION automatic_lab_fx_fixture_rule() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by)
          VALUES(NEW.id,${f.input.labServiceId},2500,'USD','2026-01-01','synthetic-fx-trigger');
          RETURN NEW; END $$`);
      functionCreated = true;
      await q(`CREATE TRIGGER automatic_lab_fx_fixture_rule AFTER INSERT ON parties
        FOR EACH ROW WHEN (NEW.name = '${newName}') EXECUTE FUNCTION automatic_lab_fx_fixture_rule()`);
      triggerCreated = true;
      const before = await snapshot();
      await expect(db.createLabOrder({ ...f.input, partyId: null, labName: newName }))
        .rejects.toMatchObject({ code: "lab_order_exchange_rate_invalid" });
      expect(await snapshot()).toEqual(before);
    } finally {
      try {
        if (triggerCreated) await q("DROP TRIGGER automatic_lab_fx_fixture_rule ON parties");
      } finally {
        if (functionCreated) await q("DROP FUNCTION automatic_lab_fx_fixture_rule()");
      }
    }
  });
});
