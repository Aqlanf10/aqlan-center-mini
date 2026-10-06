import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");
let gate: Client;
let witness: Client;
let sequence = 0;
const original = { amountMinor: 35000, asOfDate: "2026-01-01" };

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  await db.openShift({ openedBy: "synthetic-opening-test", opening: { YER: 0, SAR: 0, USD: 0 } });
  gate = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  witness = new Client({ connectionString: process.env.DATABASE_URL!, ssl: false });
  await gate.connect(); await witness.connect();
}, 180_000);
afterAll(async () => {
  await gate?.query("ROLLBACK").catch(() => {}); await gate?.end().catch(() => {});
  await witness?.end().catch(() => {}); await db.resetPoolForTesting();
});

async function patient() {
  const { rows: [row] } = await db.getPool().query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic opening concurrency') RETURNING id`,
    [`OPENING-RACE-${++sequence}`],
  );
  return row.id;
}
function input(patientId: number, patch: Partial<Parameters<typeof db.setPatientOpeningBalance>[0]> = {}) {
  return { patientId, currency: "SAR" as const, ...original, note: null, createdBy: "synthetic-admin", ...patch };
}
async function history(patientId: number) {
  return (await db.listOpeningBalanceHistory(patientId)).filter((row) => row.currency === "SAR").reverse();
}
async function waitForLock(pattern: string, minimum = 1) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { rows: [row] } = await witness.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()
       AND wait_event_type = 'Lock' AND query LIKE $1`, [pattern]);
    if (row.count >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Missing deterministic opening lock witness: ${pattern}`);
}
async function financialRows(patientId: number) {
  const { rows: [row] } = await db.getPool().query<{ payments: number; invoices: number; arrangements: number }>(
    `SELECT (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments,
            (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
            (SELECT COUNT(*)::int FROM legacy_balance_arrangements WHERE patient_id = $1) AS arrangements`, [patientId]);
  return row;
}

describe("opening balance mutation transaction fence", () => {
  it("serializes unguarded internal creates so the second append-only history records the real predecessor", async () => {
    const id = await patient();
    const writes: Promise<unknown>[] = [];
    await gate.query("BEGIN"); await gate.query(`SELECT id FROM patients WHERE id = $1 FOR UPDATE`, [id]);
    try {
      writes.push(db.setPatientOpeningBalance(input(id))); void writes[0].catch(() => {});
      await waitForLock("%FROM patients WHERE id =%FOR%UPDATE%");
      writes.push(db.setPatientOpeningBalance(input(id, { amountMinor: 40000, reason: "Synthetic correction" }))); void writes[1].catch(() => {});
      await waitForLock("%FROM patients WHERE id =%FOR%UPDATE%", 2);
      await gate.query("COMMIT");
      await Promise.all(writes);
      const rows = await history(id);
      expect(rows).toHaveLength(2);
      expect(rows[0].beforeAmountMinor).toBeNull();
      expect(rows[1].beforeAmountMinor).toBe(rows[0].afterAmountMinor);
      expect(rows[1].beforeAsOfDate).toBe(rows[0].afterAsOfDate);
      expect(rows.map((row) => row.afterAmountMinor).sort()).toEqual([35000, 40000]);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled(writes); }
  });

  it.each([false, true])("rejects a concurrent checked-absent create without another history row (addOnly=%s)", async (addOnly) => {
    const id = await patient();
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await gate.query("BEGIN"); await gate.query(`LOCK TABLE patient_opening_balance_history IN SHARE MODE`);
    try {
      first = db.setPatientOpeningBalance(input(id, { expectedBefore: null })); void first.catch(() => {});
      await waitForLock("%INSERT INTO patient_opening_balance_history%");
      second = db.setPatientOpeningBalance(input(id, { amountMinor: 999, expectedBefore: null, addOnly })); void second.catch(() => {});
      await waitForLock("%FROM patients WHERE id =%FOR%UPDATE%");
      await gate.query("COMMIT"); await first;
      await expect(second).rejects.toBeInstanceOf(addOnly ? db.OpeningBalanceExists : db.OpeningBalanceChanged);
      expect(await db.getPatientOpeningBalance(id, "SAR")).toMatchObject(original);
      expect(await history(id)).toHaveLength(1);
      expect(await financialRows(id)).toEqual({ payments: 0, invoices: 0, arrangements: 0 });
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([first, second].filter((p) => p !== undefined)); }
  });

  it.each([
    { amountMinor: 36000, asOfDate: original.asOfDate },
    { amountMinor: original.amountMinor, asOfDate: "2025-01-01" },
  ])("refuses set and clear against changed financial preflight %j", async (changed) => {
    const id = await patient();
    await db.setPatientOpeningBalance(input(id, { expectedBefore: null }));
    await db.setPatientOpeningBalance(input(id, { ...changed, reason: "Synthetic intervening correction" }));
    const before = await history(id);
    await expect(db.setPatientOpeningBalance(input(id, { amountMinor: 30000, expectedBefore: original, reason: "Synthetic stale correction" })))
      .rejects.toBeInstanceOf(db.OpeningBalanceChanged);
    await expect(db.clearPatientOpeningBalance(id, "synthetic-admin", "Synthetic stale clear", "SAR", original))
      .rejects.toBeInstanceOf(db.OpeningBalanceChanged);
    expect(await history(id)).toEqual(before);
    expect(await db.getPatientOpeningBalance(id, "SAR")).toMatchObject(changed);
    expect(await financialRows(id)).toEqual({ payments: 0, invoices: 0, arrangements: 0 });
  });

  it("refuses stale clear and correction after a clear, and does not recreate the balance", async () => {
    const id = await patient();
    await db.setPatientOpeningBalance(input(id));
    await db.clearPatientOpeningBalance(id, "synthetic-admin", "Synthetic clear", "SAR", original);
    const before = await history(id);
    await expect(db.setPatientOpeningBalance(input(id, { expectedBefore: original }))).rejects.toBeInstanceOf(db.OpeningBalanceChanged);
    await expect(db.clearPatientOpeningBalance(id, "synthetic-admin", "Synthetic stale clear", "SAR", original)).rejects.toBeInstanceOf(db.OpeningBalanceChanged);
    expect(await db.getPatientOpeningBalance(id, "SAR")).toBeNull();
    expect(await history(id)).toEqual(before);
    expect(await db.clearPatientOpeningBalance(id, "synthetic-admin", "Synthetic missing clear", "SAR")).toBe(false);
  });

  it.each([["set", "set"], ["set", "clear"], ["clear", "set"], ["clear", "clear"]] as const)(
    "rechecks after an in-flight canonical %s before the stale %s can write", async (firstAction, secondAction) => {
      const id = await patient();
      await db.setPatientOpeningBalance(input(id));
      await db.setPatientOpeningBalance(input(id, { currency: "YER", amountMinor: 5000 }));
      const act = (action: "set" | "clear") => action === "set"
        ? db.setPatientOpeningBalance(input(id, { amountMinor: 30000, expectedBefore: original, reason: "Synthetic correction" }))
        : db.clearPatientOpeningBalance(id, "synthetic-admin", "Synthetic clear", "SAR", original);
      let first: Promise<unknown> | undefined;
      let second: Promise<unknown> | undefined;
      await gate.query("BEGIN"); await gate.query(`LOCK TABLE patient_opening_balance_history IN SHARE MODE`);
      try {
        first = act(firstAction); void first.catch(() => {});
        await waitForLock("%INSERT INTO patient_opening_balance_history%");
        second = act(secondAction); void second.catch(() => {});
        await waitForLock("%FROM patients WHERE id =%FOR%UPDATE%");
        await gate.query("COMMIT"); await first;
        await expect(second).rejects.toBeInstanceOf(db.OpeningBalanceChanged);
        const rows = await history(id);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({ action: firstAction, beforeAmountMinor: original.amountMinor, beforeAsOfDate: original.asOfDate });
        if (firstAction === "set") expect(await db.getPatientOpeningBalance(id, "SAR")).toMatchObject({ amountMinor: 30000 });
        else expect(await db.getPatientOpeningBalance(id, "SAR")).toBeNull();
        expect(await db.getPatientOpeningBalance(id, "YER")).toMatchObject({ amountMinor: 5000 });
        expect(await financialRows(id)).toEqual({ payments: 0, invoices: 0, arrangements: 0 });
      } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([first, second].filter((p) => p !== undefined)); }
    },
  );

  it("refuses an unobserved legacy-import-style insert instead of overwriting it through ON CONFLICT", async () => {
    const id = await patient();
    let pending: Promise<unknown> | undefined;
    await gate.query("BEGIN");
    try {
      await gate.query(`INSERT INTO patient_opening_balances
        (patient_id, currency, amount_minor, as_of_date, created_by)
        VALUES ($1, 'SAR', 42000, '2025-01-01', 'synthetic-import')`, [id]);
      await gate.query(`INSERT INTO patient_opening_balance_history
        (patient_id, currency, action, after_amount_minor, after_as_of_date, actor)
        VALUES ($1, 'SAR', 'set', 42000, '2025-01-01', 'synthetic-import')`, [id]);
      pending = db.setPatientOpeningBalance(input(id, { expectedBefore: null })); void pending.catch(() => {});
      await waitForLock("%INSERT INTO patient_opening_balances%");
      await gate.query("COMMIT");
      await expect(pending).rejects.toBeInstanceOf(db.OpeningBalanceChanged);
      expect(await db.getPatientOpeningBalance(id, "SAR")).toMatchObject({ amountMinor: 42000, asOfDate: "2025-01-01", createdBy: "synthetic-import" });
      expect(await history(id)).toHaveLength(1);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([pending].filter((p) => p !== undefined)); }
  });

  function payment(patientId: number) {
    return db.recordPayment({ patientId, invoiceId: null, openingCurrency: "SAR", kind: "payment",
      amountMinor: 1000, currency: "SAR", baseCurrency: "YER", exchangeRate: 140,
      method: "cash", note: null, createdBy: "synthetic-opening-test" });
  }

  it.each(["set", "clear"] as const)("an ordinary payment can finish its patient FK check while %s waits on its opening row", async (action) => {
    const id = await patient(); await db.setPatientOpeningBalance(input(id));
    let paying: ReturnType<typeof payment> | undefined;
    let changing: Promise<unknown> | undefined;
    await gate.query("BEGIN"); await gate.query(`LOCK TABLE payments IN SHARE MODE`);
    try {
      paying = payment(id); void paying.catch(() => {});
      await waitForLock("%INSERT INTO payments%");
      changing = action === "set"
        ? db.setPatientOpeningBalance(input(id, { amountMinor: 30000, expectedBefore: original, reason: "Synthetic correction" }))
        : db.clearPatientOpeningBalance(id, "synthetic-admin", "Synthetic clear", "SAR", original);
      void changing.catch(() => {});
      await waitForLock("%FROM patient_opening_balances%FOR UPDATE%");
      await gate.query("COMMIT");
      const paid = await paying; await changing;
      expect(paid.reason).toBeNull();
      expect(paid.payment).toMatchObject({ amountMinor: 1000, currency: "SAR", openingCurrency: "SAR" });
      expect(await financialRows(id)).toEqual({ payments: 1, invoices: 0, arrangements: 0 });
      expect(await history(id)).toHaveLength(2);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([paying, changing].filter((p) => p !== undefined)); }
  });

  it.each(["set", "clear"] as const)("an ordinary payment rechecks the target after an in-flight %s", async (action) => {
    const id = await patient(); await db.setPatientOpeningBalance(input(id));
    let paying: ReturnType<typeof payment> | undefined;
    let changing: Promise<unknown> | undefined;
    await gate.query("BEGIN"); await gate.query(`LOCK TABLE patient_opening_balance_history IN SHARE MODE`);
    try {
      changing = action === "set"
        ? db.setPatientOpeningBalance(input(id, { amountMinor: 30000, expectedBefore: original, reason: "Synthetic correction" }))
        : db.clearPatientOpeningBalance(id, "synthetic-admin", "Synthetic clear", "SAR", original);
      void changing.catch(() => {});
      await waitForLock("%INSERT INTO patient_opening_balance_history%");
      paying = payment(id); void paying.catch(() => {});
      await waitForLock("%FROM patient_opening_balances%FOR SHARE%");
      await gate.query("COMMIT"); await changing;
      const paid = await paying;
      expect(paid.reason).toBe(action === "set" ? null : "invalid_opening_target");
      expect(await financialRows(id)).toEqual({ payments: action === "set" ? 1 : 0, invoices: 0, arrangements: 0 });
      expect(await history(id)).toHaveLength(2);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([paying, changing].filter((p) => p !== undefined)); }
  });

  it("refuses reception replacement without waiting for an existing opening's payment reader", async () => {
    const id = await patient(); await db.setPatientOpeningBalance(input(id));
    let paying: ReturnType<typeof payment> | undefined;
    let replacing: Promise<unknown> | undefined;
    let settled = false;
    await gate.query("BEGIN"); await gate.query(`LOCK TABLE payments IN SHARE MODE`);
    try {
      paying = payment(id); void paying.catch(() => {});
      await waitForLock("%INSERT INTO payments%");
      replacing = db.setPatientOpeningBalance(input(id, { addOnly: true, expectedBefore: null }));
      void replacing.then(() => { settled = true; }, () => { settled = true; });
      await expect.poll(() => settled, { timeout: 5000 }).toBe(true);
      await expect(replacing).rejects.toBeInstanceOf(db.OpeningBalanceExists);
      await gate.query("COMMIT"); expect((await paying).reason).toBeNull();
      expect(await history(id)).toHaveLength(1);
      expect(await db.getPatientOpeningBalance(id, "SAR")).toMatchObject(original);
    } finally { await gate.query("ROLLBACK").catch(() => {}); await Promise.allSettled([paying, replacing].filter((p) => p !== undefined)); }
  });

  it("keeps exact-currency checked create/correct/clear and a missing patient compatible", async () => {
    const id = await patient();
    for (const currency of ["YER", "SAR", "USD"] as const) {
      expect(await db.setPatientOpeningBalance(input(id, { currency, expectedBefore: null }))).toMatchObject({ currency, ...original });
      expect(await db.setPatientOpeningBalance(input(id, { currency, amountMinor: 30000, expectedBefore: original, reason: "Synthetic correction" }))).toMatchObject({ currency, amountMinor: 30000 });
      expect(await db.clearPatientOpeningBalance(id, "synthetic-admin", "Synthetic clear", currency, { ...original, amountMinor: 30000 })).toBe(true);
    }
    expect(await db.setPatientOpeningBalance(input(2_000_000_000, { expectedBefore: null }))).toBeNull();
    expect(await db.listOpeningBalanceHistory(id)).toHaveLength(9);
  });
});
