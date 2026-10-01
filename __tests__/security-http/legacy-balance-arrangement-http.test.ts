import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await db.query(
    `INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
     SELECT 'legacy-arr-http', 0, 0, 0
      WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`,
  );
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name)
     VALUES ($1, 'مريض تقويم قديم — اختبار ترتيب الرصيد') RETURNING id`,
    [`LBAH-${Date.now()}`],
  ));
  await db.query(
    `INSERT INTO patient_opening_balances
       (patient_id, currency, amount_minor, as_of_date, note, created_by)
     VALUES ($1, 'YER', 350000, CURRENT_DATE, 'متبقٍ قبل النظام', 'migration')`,
    [patientId],
  );
}, 120_000);

afterAll(async () => { await db?.end(); });

describe("P0-C legacy balance arrangement HTTP", () => {
  it("reception creates collection metadata only; no invoice or payment appears", async () => {
    const before = await db.query<{ invoices: string; payments: string }>(
      `SELECT (SELECT count(*)::text FROM invoices WHERE patient_id = $1) AS invoices,
              (SELECT count(*)::text FROM payments WHERE patient_id = $1) AS payments`,
      [patientId],
    );

    const response = await authedMutation(
      `/api/patients/${patientId}/legacy-balance-arrangement`,
      h.sessions.reception,
      "POST",
      JSON.stringify({ currency: "YER", cadence: "per_visit", installmentAmount: "30000", note: "مع كل عودة" }),
    );
    expect(response.status).toBe(201);
    const created = await response.json() as {
      startingDueMinor: number; installmentMinor: number;
      progress: { arrangementRemainingMinor: number; suggestedMinor: number };
    };
    expect(created).toMatchObject({
      startingDueMinor: 350000,
      installmentMinor: 30000,
      progress: { arrangementRemainingMinor: 350000, suggestedMinor: 30000 },
    });

    const after = await db.query<{ invoices: string; payments: string }>(
      `SELECT (SELECT count(*)::text FROM invoices WHERE patient_id = $1) AS invoices,
              (SELECT count(*)::text FROM payments WHERE patient_id = $1) AS payments`,
      [patientId],
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });

  it("cashier/accountant can read financial context but cannot negotiate or cancel the arrangement", async () => {
    expect((await authedGet(
      `/api/patients/${patientId}/legacy-balance-arrangement`,
      h.sessions.accountant,
    )).status).toBe(200);
    expect((await authedGet(
      `/api/patients/${patientId}/legacy-balance-arrangement`,
      h.sessions.cashier,
    )).status).toBe(200);

    const cashierWrite = await authedMutation(
      `/api/patients/${patientId}/legacy-balance-arrangement`,
      h.sessions.cashier,
      "POST",
      JSON.stringify({ currency: "YER", cadence: "per_visit", installmentAmount: "20000" }),
    );
    expect(cashierWrite.status).toBe(403);

    const accountantWrite = await authedMutation(
      `/api/patients/${patientId}/legacy-balance-arrangement`,
      h.sessions.accountant,
      "PATCH",
      JSON.stringify({ arrangementId: 1, reason: "لا يملك صلاحية" }),
    );
    expect(accountantWrite.status).toBe(403);
  });

  it("the normal opening-balance payment route reduces the old receivable and updates the suggestion", async () => {
    const paid = await authedMutation(
      "/api/payments",
      h.sessions.reception,
      "POST",
      JSON.stringify({
        patientId,
        amount: "30000",
        currency: "YER",
        openingCurrency: "YER",
        method: "cash",
      }),
    );
    expect(paid.status).toBe(201);

    const response = await authedGet(
      `/api/patients/${patientId}/legacy-balance-arrangement`,
      h.sessions.reception,
    );
    expect(response.status).toBe(200);
    const payload = await response.json() as {
      arrangements: Array<{
        progress: {
          currentOpeningDueMinor: number;
          arrangementRemainingMinor: number;
          suggestedMinor: number;
        };
      }>;
    };
    expect(payload.arrangements[0].progress).toMatchObject({
      currentOpeningDueMinor: 320000,
      arrangementRemainingMinor: 320000,
      suggestedMinor: 30000,
    });

    const ledger = await authedGet(`/api/patients/${patientId}/ledger`, h.sessions.reception);
    expect(ledger.status).toBe(200);
    const book = await ledger.json() as {
      legacyBalanceArrangements: Array<{ progress: { arrangementRemainingMinor: number } }>;
      legacyOpeningPositions: Array<{ currency: string; remainingMinor: number }>;
    };
    expect(book.legacyBalanceArrangements[0].progress.arrangementRemainingMinor).toBe(320000);
    expect(book.legacyOpeningPositions).toContainEqual(
      expect.objectContaining({ currency: "YER", remainingMinor: 320000 }),
    );
  });
});
