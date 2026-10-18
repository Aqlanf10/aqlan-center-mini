import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Synthetic fixtures; the PostgreSQL wrapper supplies its newly isolated database.
const postgresUrl = process.env.TEST_DEBT_CUTOFF_DATABASE_URL;
vi.stubEnv("USE_LOCAL_DB", postgresUrl ? "false" : "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
vi.stubEnv("DATABASE_URL", postgresUrl ?? "");
vi.stubEnv("CLINIC_TIME_ZONE", "Asia/Aden");
const { ensureSchema, getPool, resetPoolForTesting } = await import("../lib/db");
const { buildReport, parseFilters } = await import("../lib/reports");
const toMinor = (value: number, currency: string) => value * (currency === "YER" ? 1 : 100);
let serial = 0;
let shift: number;
const q = (sql: string, params: unknown[] = []) => getPool().query(sql, params);
async function patient() {
  return (await q("INSERT INTO patients (patient_number, full_name) VALUES ($1, 'Synthetic cutoff') RETURNING id", [`CUT-${++serial}`])).rows[0].id as number;
}
async function invoice(pid: number, currency: string, amount: number, at = "2026-10-10T12:00:00+03:00", status = "open") {
  return (await q(`INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_at, status)
    VALUES ($1,$2,$3,0,$4,$5::timestamptz,$6) RETURNING id`, [`CUT-I-${++serial}`, pid, toMinor(amount, currency), currency, at, status])).rows[0].id as number;
}
async function payment(pid: number, iid: number, currency: string, amount: number, at: string, reversal?: number) {
  return (await q(`INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
    exchange_rate, base_amount_minor, base_currency, method, created_at, reversal_of_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,1,$6,'YER','cash',$8::timestamptz,$9) RETURNING id`,
  [`CUT-P-${++serial}`, pid, iid, shift, reversal ? "refund" : "payment", toMinor(amount, currency), currency, at, reversal ?? null])).rows[0].id as number;
}
async function report(pid: number, to = "2026-10-31") {
  return buildReport("debt", parseFilters(new URLSearchParams({ preset: "custom", from: "2026-10-20", to, patientId: String(pid) })));
}
async function opening(pid: number, currency: string, date: string, amount: number) {
  await q(`INSERT INTO patient_opening_balances (patient_id, currency, as_of_date, amount_minor) VALUES ($1,$2,$3::date,$4)`,
    [pid, currency, date, toMinor(amount, currency)]);
}
beforeAll(async () => {
  await ensureSchema();
  // PGlite strips AT TIME ZONE, so align its session. PostgreSQL deliberately
  // stays in UTC to prove the loader applies the clinic timezone itself.
  await q(postgresUrl ? "SET TIME ZONE 'UTC'" : "SET TIME ZONE 'Asia/Aden'");
  shift = (await q("INSERT INTO cashier_shifts (opened_by) VALUES ('synthetic cutoff') RETURNING id")).rows[0].id;
}, 120_000);
afterAll(async () => { await resetPoolForTesting(); vi.unstubAllEnvs(); });

describe("outstanding debt uses one inclusive clinic-date cutoff", () => {
  it.each(["YER", "SAR", "USD"])("October 100 / November 40 in %s: October shows paid 0 and debt 100", async (currency) => {
    const pid = await patient();
    const iid = await invoice(pid, currency, 100);
    await payment(pid, iid, currency, 40, "2026-11-01T00:00:00+03:00");
    const october = await report(pid);
    expect(october.rows).toHaveLength(1);
    expect(october.rows![0]).toMatchObject({ currency, billedMinor: toMinor(100, currency), paidMinor: 0, balanceMinor: toMinor(100, currency), lastPaymentDate: "—" });
    expect((await report(pid, "2026-11-30")).rows![0]).toMatchObject({ billedMinor: toMinor(100, currency), paidMinor: toMinor(40, currency), balanceMinor: toMinor(60, currency) });
  });

  it.each(["YER", "SAR", "USD"])("excludes future invoices/opening and includes boundary opening in %s", async (currency) => {
    const pid = await patient();
    await invoice(pid, currency, 100);
    await invoice(pid, currency, 200, "2026-11-01T00:00:00+03:00");
    await opening(pid, currency, "2026-11-01", 30);
    expect((await report(pid)).rows![0]).toMatchObject({ billedMinor: toMinor(100, currency), paidMinor: 0, balanceMinor: toMinor(100, currency) });
    const boundary = await patient();
    await opening(boundary, currency, "2026-10-31", 30);
    expect((await report(boundary)).rows![0]).toMatchObject({ billedMinor: toMinor(30, currency), balanceMinor: toMinor(30, currency) });
  });

  it("keeps all three currency buckets independent", async () => {
    const pid = await patient();
    for (const [index, currency] of ["YER", "SAR", "USD"].entries()) {
      const iid = await invoice(pid, currency, 100 + index);
      await payment(pid, iid, currency, 10 + index, "2026-10-31T23:59:59.999+03:00");
    }
    const rows = (await report(pid)).rows!;
    expect(rows).toHaveLength(3);
    for (const [index, currency] of ["YER", "SAR", "USD"].entries()) {
      expect(rows.find(row => row.currency === currency)).toMatchObject({ billedMinor: toMinor(100 + index, currency), paidMinor: toMinor(10 + index, currency), balanceMinor: toMinor(90, currency) });
    }
  });

  it("uses Asia/Aden dates at midnight for invoices and reversal payments", async () => {
    const pid = await patient();
    const iid = await invoice(pid, "YER", 100, "2026-10-31T20:59:59.999Z");
    await invoice(pid, "YER", 200, "2026-10-31T21:00:00Z");
    const paid = await payment(pid, iid, "YER", 40, "2026-10-31T20:59:59.999Z");
    await payment(pid, iid, "YER", 40, "2026-10-31T21:00:00Z", paid);
    expect((await report(pid)).rows![0]).toMatchObject({ billedMinor: 100, paidMinor: 40, balanceMinor: 60 });
    expect((await report(pid, "2026-11-01")).rows![0]).toMatchObject({ billedMinor: 300, paidMinor: 0, balanceMinor: 300 });
  });

  it("preserves current cancellation exclusion and signed refunds linked to cancelled invoices", async () => {
    const pid = await patient();
    await invoice(pid, "SAR", 100);
    const cancelled = await invoice(pid, "SAR", 500, undefined, "cancelled");
    const paid = await payment(pid, cancelled, "SAR", 40, "2026-10-15T12:00:00+03:00");
    await payment(pid, cancelled, "SAR", 10, "2026-10-31T23:59:59+03:00", paid);
    expect((await report(pid)).rows![0]).toMatchObject({ currency: "SAR", billedMinor: 10000, paidMinor: 3000, balanceMinor: 7000 });
  });

  it("keeps current plan references explicit without deriving debt from proposed plans", async () => {
    const pid = await patient();
    const plan = (await q(`INSERT INTO treatment_plans (patient_id, title, total_minor, base_currency, status, start_date)
      VALUES ($1, 'Synthetic proposal', 900, 'YER', 'proposed', '2026-10-01') RETURNING id`, [pid])).rows[0].id;
    expect((await report(pid)).rows).toEqual([]);
    const iid = await invoice(pid, "YER", 100);
    await q("UPDATE invoices SET plan_id = $1 WHERE id = $2", [plan, iid]);
    await payment(pid, iid, "YER", 40, "2026-11-01T12:00:00+03:00");
    const result = await report(pid);
    expect(result.rows![0]).toMatchObject({ planTotalMinor: 900, planPaidMinor: 40, billedMinor: 100, paidMinor: 0, balanceMinor: 100 });
    for (const key of ["planTotalMinor", "planPaidMinor"]) {
      expect(result.columns!.find(column => column.key === key)?.label).toContain("الحالي (مرجعي)");
    }
  });

  it("does not turn a financial read failure into zero debt", async () => {
    const pid = await patient();
    await invoice(pid, "YER", 100);
    const pool = getPool();
    let injectedFailures = 0;
    const withFailure = (query: typeof pool.query): typeof pool.query => ((...args: Parameters<typeof pool.query>) => {
      if (String(args[0]).includes("FROM payments WHERE")) {
        injectedFailures += 1;
        return Promise.reject(new Error("synthetic payment read failed"));
      }
      return query(...args);
    }) as typeof pool.query;
    // PGlite uses the shared runner; PostgreSQL reads through its snapshot client.
    const connect = pool.connect.bind(pool);
    const query = pool.query.bind(pool);
    const querySpy = vi.spyOn(pool, "query").mockImplementation(withFailure(query));
    const connectSpy = vi.spyOn(pool, "connect").mockImplementation((...args: unknown[]) => {
      // Native pg pool.query also calls connect(callback); preserve that overload.
      if (args.length) return Reflect.apply(connect, pool, args);
      return connect().then(client => ({
        query: withFailure(client.query.bind(client)), release: client.release.bind(client),
      }));
    });
    try {
      await expect(report(pid)).rejects.toThrow("synthetic payment read failed");
      expect(injectedFailures).toBe(1);
    } finally { querySpy.mockRestore(); connectSpy.mockRestore(); }
  });
});
