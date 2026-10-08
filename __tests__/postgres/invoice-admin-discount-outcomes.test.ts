import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (FIN-DISC, review 5461906275) Admin discount — lock order with the real payment writers, the closed period by clinic date
 * inside the transaction (including a close racing the discount), and an honest outcome around COMMIT. Real PostgreSQL,
 * disposable database, synthetic rows only.
 */
assertRealPostgresUrl();
stubPostgresEnv();

const { getPool, resetPoolForTesting, ensureSchema, applyAdminInvoiceDiscount, recordPayment, correctPayment, saveSettingsAudited } = await import("../../lib/db");

let patientId = 0;
let seq = 0;
const url = process.env.DATABASE_URL!;
beforeAll(async () => {
  await dropPublicSchema(url);
  await ensureSchema();
  const pool = getPool();
  ({ rows: [{ id: patientId }] } = await pool.query(`INSERT INTO patients (patient_number, full_name) VALUES ('DISC-O-1', 'مريض نتائج الخصم') RETURNING id`));
  await pool.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd) VALUES ('disc', 0, 0, 0)`);
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

async function invoice(total = 100000, createdAt: string | null = null) {
  seq += 1;
  const { rows: [row] } = await getPool().query<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, $3, 0, 'YER', 'reception1', COALESCE($4::timestamptz, NOW())) RETURNING id`, [`DISC-O-${seq}`, patientId, total, createdAt]);
  await getPool().query(`INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor)
    VALUES ($1, 'علاج', 1, $2, $2)`, [row.id, total]);
  return row.id;
}
async function pay(invoiceId: number, amountMinor: number) {
  const result = await recordPayment({ patientId, invoiceId, kind: "payment", amountMinor, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, method: "cash", note: null, createdBy: "cashier", reversalOfId: null, openingCurrency: null });
  if (result.reason !== null || !result.payment) throw new Error(`payment refused: ${result.reason}`);
  return result.payment;
}
const settledOf = async (invoiceId: number) => Number((await getPool().query(`SELECT COALESCE(SUM(CASE WHEN kind = 'refund'
  THEN -amount_minor ELSE amount_minor END), 0)::int AS n FROM payments WHERE invoice_id = $1`, [invoiceId])).rows[0].n);
const discountOf = async (id: number) => Number((await getPool().query(`SELECT discount_minor FROM invoices WHERE id = $1`, [id])).rows[0].discount_minor);
const audits = async (id: number) => Number((await getPool().query(
  `SELECT COUNT(*)::int AS n FROM audit_log WHERE action = 'invoice.discount' AND entity_id = $1`, [String(id)])).rows[0].n);
const discount = async (invoiceId: number, additionalMinor: number, extra: Partial<Parameters<typeof applyAdminInvoiceDiscount>[0]> = {}) =>
  applyAdminInvoiceDiscount({ invoiceId, additionalMinor, reason: "قرار الإدارة", actor: "admin1", actorRole: "admin",
    expected: { discountMinor: await discountOf(invoiceId), settledMinor: await settledOf(invoiceId) }, ...extra });
const setLockedBefore = (value: string) => getPool().query(`INSERT INTO settings (key, value) VALUES ('finance.locked_before', $1)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [value]);

/** Backends waiting on a row lock whose query text matches. */
async function waitingOn(fragment: string) {
  const { rows } = await getPool().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`, [`%${fragment}%`]);
  return rows[0].n;
}
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("condition not reached");
}
/** Holds the invoice row FOR UPDATE on its own connection so the next writers queue in a known order. */
async function barrier(invoiceId: number) {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query("BEGIN");
  await client.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
  return { release: async () => { await client.query("COMMIT"); await client.end(); } };
}

describe("lock order with the real payment writers (no deadlock)", () => {
  /*
   * The dangerous order: the discount queues for the invoice first, then a receipt correction locks the payment and the
   * shift and queues for the same invoice. Released together, the old discount took the invoice and then asked for the
   * payment row the correction held — a cycle (40P01). The discount now never waits on a payment or shift row.
   */
  it("a receipt correction queued behind the discount completes, and so does the discount", async () => {
    const id = await invoice();
    const receipt = await pay(id, 30000);
    const hold = await barrier(id);
    const expected = { discountMinor: 0, settledMinor: 30000 };
    const discounting = applyAdminInvoiceDiscount({ invoiceId: id, additionalMinor: 10000, reason: "قرار الإدارة", actor: "admin1", actorRole: "admin", expected });
    await until(async () => await waitingOn("FROM invoices WHERE id = $1 FOR UPDATE") >= 1);
    const correcting = correctPayment({ paymentId: receipt.id, reason: "مبلغ خطأ", actor: "admin",
      replacement: { amountMinor: 30000, currency: "YER", exchangeRate: 1, method: "cash", target: { kind: "original" as const } } });
    await until(async () => await waitingOn("FROM invoices") >= 2);
    await hold.release();
    const [discounted, corrected] = await Promise.all([discounting, correcting]);
    expect(discounted).toMatchObject({ ok: true, afterDiscountMinor: 10000 });
    expect(corrected.reason).toBeNull();
    expect(await discountOf(id)).toBe(10000);
    expect(await settledOf(id)).toBe(30000); // reversal −30,000 and replacement +30,000
  });

  it("a refund queued behind the discount completes, and so does the discount", async () => {
    const id = await invoice();
    const receipt = await pay(id, 30000);
    const hold = await barrier(id);
    const discounting = applyAdminInvoiceDiscount({ invoiceId: id, additionalMinor: 10000, reason: "قرار الإدارة", actor: "admin1", actorRole: "admin",
      expected: { discountMinor: 0, settledMinor: 30000 } });
    await until(async () => await waitingOn("FROM invoices WHERE id = $1 FOR UPDATE") >= 1);
    const refunding = recordPayment({ patientId, invoiceId: null, kind: "refund", amountMinor: 5000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, method: "cash", note: null, createdBy: "admin", reversalOfId: receipt.id, openingCurrency: null });
    await until(async () => await waitingOn("FROM invoices") >= 2);
    await hold.release();
    const [discounted, refunded] = await Promise.all([discounting, refunding]);
    expect(discounted).toMatchObject({ ok: true });
    expect(refunded.reason).toBeNull();
    expect(await settledOf(id)).toBe(25000);
  });

  it("a receipt that commits first makes the discount stale (the settled amount it saw changed)", async () => {
    const id = await invoice();
    await pay(id, 30000);
    const seen = { discountMinor: 0, settledMinor: 30000 };
    await pay(id, 10000);
    expect(await applyAdminInvoiceDiscount({ invoiceId: id, additionalMinor: 10000, reason: "قرار الإدارة", actor: "admin1", actorRole: "admin", expected: seen }))
      .toMatchObject({ ok: false, reason: "stale" });
    expect(await discountOf(id)).toBe(0);
  });
});

describe("closed period: clinic date, read inside the transaction", () => {
  it("uses the invoice's clinic date (Asia/Aden), not its UTC date", async () => {
    await setLockedBefore("2026-09-01");
    // 2026-08-31 22:30Z is 2026-09-01 01:30 in Aden: open. 2026-08-31 20:00Z is 23:00 on the 31st in Aden: closed.
    const openByClinicDate = await invoice(100000, "2026-08-31T22:30:00Z");
    const closedByClinicDate = await invoice(100000, "2026-08-31T20:00:00Z");
    expect(await discount(openByClinicDate, 1000)).toMatchObject({ ok: true });
    expect(await discount(closedByClinicDate, 1000)).toMatchObject({ ok: false, reason: "period_locked" });
    expect(await discountOf(closedByClinicDate)).toBe(0);
    await setLockedBefore("");
  });

  it("a close saved concurrently is waited for and then refuses the discount (no cached settings)", async () => {
    await setLockedBefore("");
    const id = await invoice();
    const closer = new Client({ connectionString: url });
    await closer.connect();
    await closer.query("BEGIN");
    await closer.query(`UPDATE settings SET value = '2099-01-01' WHERE key = 'finance.locked_before'`);
    const discounting = discount(id, 1000);
    await until(async () => await waitingOn("finance.locked_before") >= 1);
    await closer.query("COMMIT");
    await closer.end();
    expect(await discounting).toMatchObject({ ok: false, reason: "period_locked" });
    expect(await discountOf(id)).toBe(0);
    await setLockedBefore("");
  });
});

describe("first close of the books with no settings row (review 5462657687)", () => {
  it("a close committed before the discount reads the period refuses it, starting with the setting absent", async () => {
    await getPool().query(`DELETE FROM settings WHERE key = 'finance.locked_before'`);
    const id = await invoice();
    const hold = await barrier(id);
    const discounting = discount(id, 1000);
    await until(async () => await waitingOn("FROM invoices WHERE id = $1 FOR UPDATE") >= 1);
    expect(await saveSettingsAudited({ values: { "finance.locked_before": "2099-01-01" }, actor: "admin1", actorRole: "admin" }))
      .toMatchObject({ ok: true });
    await hold.release();
    expect(await discounting).toMatchObject({ ok: false, reason: "period_locked" });
    expect(await discountOf(id)).toBe(0);
    await getPool().query(`DELETE FROM settings WHERE key = 'finance.locked_before'`);
  });

  it("a first close started while the discount runs waits for it (shared advisory lock), and never lands underneath it", async () => {
    await getPool().query(`DELETE FROM settings WHERE key = 'finance.locked_before'`);
    const id = await invoice();
    // Pause the discount after it read the period: hold audit_log, which it writes before COMMIT.
    const pause = new Client({ connectionString: url });
    await pause.connect();
    await pause.query("BEGIN");
    await pause.query("LOCK TABLE audit_log IN ACCESS EXCLUSIVE MODE");
    const discounting = discount(id, 1000);
    await until(async () => await waitingOn("audit_log") >= 1);
    const closing = saveSettingsAudited({ values: { "finance.locked_before": "2099-01-01" }, actor: "admin1", actorRole: "admin" });
    await until(async () => (await getPool().query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = 'advisory'`)).rows[0].n >= 1);
    // The close is blocked: the row still does not exist while the discount is in flight.
    expect((await getPool().query(`SELECT 1 FROM settings WHERE key = 'finance.locked_before'`)).rows).toHaveLength(0);
    await pause.query("COMMIT");
    await pause.end();
    expect(await discounting).toMatchObject({ ok: true }); // the period was open when it was decided
    expect(await closing).toMatchObject({ ok: true });     // and the close lands after it
    expect(await discountOf(id)).toBe(1000);
    await getPool().query(`DELETE FROM settings WHERE key = 'finance.locked_before'`);
  });
});

describe("transport error codes at COMMIT (review 5462657687)", () => {
  it("a transport code (ECONNRESET) after a COMMIT that did succeed is reported uncertain, not «nothing changed»", async () => {
    const id = await invoice();
    const result = await discount(id, 3000, { commit: async (client) => {
      await client.query("COMMIT");
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    } });
    expect(result).toMatchObject({ ok: false, reason: "uncertain" });
    if (!result.ok) expect(result.message).not.toContain("لم يتغيّر شيء");
    expect(await discountOf(id)).toBe(3000); // it did commit: claiming a rollback would have been false
  });

  it("control: a server SQLSTATE that rolled back is a definite failure", async () => {
    const id = await invoice();
    const result = await discount(id, 3000, { commit: async (client) => {
      await client.query("ROLLBACK");
      throw Object.assign(new Error("could not serialize access"), { code: "40001" });
    } });
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(await discountOf(id)).toBe(0);
  });
});

describe("outcome around COMMIT", () => {
  it("an audit write failure rolls the discount back", async () => {
    const id = await invoice();
    await getPool().query(`CREATE OR REPLACE FUNCTION pg_temp_fail_discount_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action = 'invoice.discount' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
    await getPool().query(`CREATE TRIGGER fail_discount_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_discount_audit()`);
    try {
      await expect(discount(id, 1000)).rejects.toThrow("synthetic audit failure");
    } finally {
      await getPool().query(`DROP TRIGGER fail_discount_audit ON audit_log`);
    }
    expect(await discountOf(id)).toBe(0);
    expect(await audits(id)).toBe(0);
  });

  it("a COMMIT error reported by the server is a rollback: «لم يتغيّر شيء» is true", async () => {
    const id = await invoice(100000);
    await getPool().query(`CREATE OR REPLACE FUNCTION pg_temp_fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.discount_minor = 4321 THEN RAISE EXCEPTION 'synthetic deferred failure'; END IF; RETURN NULL; END $$`);
    await getPool().query(`CREATE CONSTRAINT TRIGGER fail_at_commit AFTER UPDATE ON invoices DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION pg_temp_fail_at_commit()`);
    try {
      const result = await discount(id, 4321);
      expect(result).toMatchObject({ ok: false, reason: "failed" });
      if (!result.ok) expect(result.message).toContain("لم يتغيّر شيء");
    } finally {
      await getPool().query(`DROP TRIGGER fail_at_commit ON invoices`);
    }
    expect(await discountOf(id)).toBe(0);
    expect(await audits(id)).toBe(0);
  });

  it("a connection lost at COMMIT is reported as uncertain, never as «nothing changed»", async () => {
    const id = await invoice(100000);
    await getPool().query(`CREATE OR REPLACE FUNCTION pg_temp_drop_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.discount_minor = 4322 THEN PERFORM pg_terminate_backend(pg_backend_pid()); END IF; RETURN NULL; END $$`);
    await getPool().query(`CREATE CONSTRAINT TRIGGER drop_at_commit AFTER UPDATE ON invoices DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION pg_temp_drop_at_commit()`);
    try {
      const result = await discount(id, 4322);
      expect(result).toMatchObject({ ok: false, reason: "uncertain" });
      if (!result.ok) expect(result.message).not.toContain("لم يتغيّر شيء");
    } finally {
      await getPool().query(`DROP TRIGGER drop_at_commit ON invoices`);
    }
    // The pool recovers; a later decision sees the real state.
    expect(await discountOf(id)).toBe(0);
  });

  it("a failed read-back after COMMIT is still success with the discount applied", async () => {
    const id = await invoice(100000);
    const result = await discount(id, 7000, { readBack: async () => { throw new Error("synthetic read failure"); } });
    expect(result).toMatchObject({ ok: true, invoice: null, afterDiscountMinor: 7000 });
    expect(await discountOf(id)).toBe(7000);
    expect(await audits(id)).toBe(1);
  });
});
