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

describe("debt movement clips each monthly row to the selected clinic dates", () => {
  async function movement(pid: number, from: string, to: string) {
    const params = new URLSearchParams({ report: "debt", debtMode: "movement", preset: "custom", from, to, patientId: String(pid) });
    return buildReport("debt", parseFilters(params));
  }

  it("reports December and January in order and reconciles movements and boundary balances by currency", async () => {
    const pid = await patient();
    const cases = [
      { currency: "YER", prior: 120, december: 50, january: 10, paid: 20 },
      { currency: "SAR", prior: 35, december: 11, january: 8, paid: 5 },
      { currency: "USD", prior: 52, december: 9, january: 4, paid: 3 },
    ];
    for (const { currency, prior, december, january, paid } of cases) {
      const old = await invoice(pid, currency, prior + 2, "2026-12-29T12:00:00+03:00");
      await payment(pid, old, currency, 2, "2026-12-30T20:59:59.999Z");
      const first = await invoice(pid, currency, december, "2026-12-30T21:00:00Z");
      const collected = await payment(pid, first, currency, paid, "2026-12-31T20:59:59.999Z");
      await payment(pid, first, currency, paid, "2026-12-31T21:00:00Z", collected);
      await invoice(pid, currency, january, "2027-01-01T20:59:59.999Z");
      await invoice(pid, currency, 70, "2027-01-01T21:00:00Z");
    }

    const result = await movement(pid, "2026-12-31", "2027-01-01");
    expect(result.monthly?.rows).toHaveLength(6);
    // Screen and print use this metadata to total flows but never balance snapshots.
    expect(result.monthly?.columns.filter(column => column.type === "money" && column.aggregate !== "none")
      .map(column => column.key)).toEqual(["newDebtMinor", "collectedMinor", "adjustmentsMinor"]);
    for (const { currency, prior, december, january, paid } of cases) {
      const minor = (value: number) => toMinor(value, currency);
      const decClosing = prior + december - paid;
      const janClosing = decClosing + january + paid;
      expect(result.monthly?.rows.filter(row => row.currency === currency)).toEqual([
        { monthLabel: "ديسمبر 2026", currency, openingMinor: minor(prior), newDebtMinor: minor(december),
          collectedMinor: minor(paid), adjustmentsMinor: 0, closingMinor: minor(decClosing) },
        { monthLabel: "يناير 2027", currency, openingMinor: minor(decClosing), newDebtMinor: minor(january),
          collectedMinor: 0, adjustmentsMinor: minor(paid), closingMinor: minor(janClosing) },
      ]);
      const cards = Object.fromEntries(result.kpis.filter(kpi => kpi.currency === currency).map(kpi => [kpi.key, kpi.minor]));
      const suffix = currency === "YER" ? "" : `-${currency}`;
      expect(cards).toEqual({
        [`opening${suffix}`]: minor(prior), [`new${suffix}`]: minor(december + january),
        [`collected${suffix}`]: minor(paid), [`adj${suffix}`]: minor(paid), [`closing${suffix}`]: minor(janClosing),
      });
    }
    expect(result.bars).toEqual([{ label: "ديسمبر 2026", minor: 150 }, { label: "يناير 2027", minor: 180 }]);
  });

  it("keeps native amounts at both endpoints of a 120-month window ending on January 1", async () => {
    const pid = await patient();
    await invoice(pid, "YER", 101, "2017-02-28T00:00:00+03:00");
    await invoice(pid, "SAR", 23, "2027-01-01T23:59:59+03:00");
    await invoice(pid, "SAR", 79, "2027-01-02T00:00:00+03:00");

    const result = await movement(pid, "2027-01-01", "2017-02-28");
    expect(result.bars).toHaveLength(120);
    expect(result.bars?.at(-1)).toEqual({ label: "يناير 2027", minor: 101 });
    expect(result.monthly?.rows.filter(row => row.newDebtMinor !== 0)).toEqual([
      expect.objectContaining({ monthLabel: "فبراير 2017", currency: "YER", newDebtMinor: 101 }),
      expect.objectContaining({ monthLabel: "يناير 2027", currency: "SAR", newDebtMinor: toMinor(23, "SAR") }),
    ]);
  });

  it("shows a newly recorded opening balance without inventing a movement", async () => {
    const pid = await patient();
    await opening(pid, "SAR", "2027-01-03", 20);
    const result = await movement(pid, "2027-01-02", "2027-01-04");
    expect(result.monthly?.rows).toEqual([{ monthLabel: "يناير", currency: "SAR", openingMinor: 0,
      newDebtMinor: 0, collectedMinor: 0, adjustmentsMinor: 0, closingMinor: toMinor(20, "SAR") }]);
    expect(result.kpis.filter(kpi => kpi.currency === "SAR").map(kpi => [kpi.key, kpi.minor]))
      .toEqual([["closing-SAR", toMinor(20, "SAR")]]);
    expect(result.bars).toEqual([{ label: "يناير", minor: 0 }]);
  });

  it("excludes the January 31 refund on January 1, then includes it for the full month", async () => {
    const pid = await patient();
    const old = await invoice(pid, "YER", 100, "2026-12-31T12:00:00+03:00");
    const collected = await payment(pid, old, "YER", 30, "2027-01-01T12:00:00+03:00");
    await payment(pid, old, "YER", 30, "2027-01-31T12:00:00+03:00", collected);

    for (const [to, refund, closing] of [["2027-01-01", 0, 70], ["2027-01-31", 30, 100]] as const) {
      const result = await movement(pid, "2027-01-01", to);
      expect(result.monthly?.rows).toEqual([{ monthLabel: "يناير", currency: "YER", openingMinor: 100,
        newDebtMinor: 0, collectedMinor: 30, adjustmentsMinor: refund, closingMinor: closing }]);
      expect(result.kpis.find(kpi => kpi.key === "adj")?.minor).toBe(refund);
      expect(result.kpis.find(kpi => kpi.key === "closing")?.minor).toBe(closing);
      expect(result.bars).toEqual([{ label: "يناير", minor: closing }]);
    }
  });
});
