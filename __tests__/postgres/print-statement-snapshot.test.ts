import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

/**
 * The current (no-query) printed patient statement reads its ledger, plan currencies and
 * agreement progress in one snapshot: a payment committed meanwhile shows in the receipts,
 * balances and agreement together or not at all. The dated print path is unchanged. Only
 * the staff session gate is stubbed. Synthetic data only.
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_print_statement_snapshot_test");

vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "synthetic-print", userId: 1 }) }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: ({ title }: { title: string }) => createElement("h1", null, title), PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));

const db = await import("../../lib/db");
const { default: StatementPage } = await import("../../app/print/statement/[id]/page");
const { formatMoney } = await import("../../lib/money");

const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
let patientId = 0, otherPatientId = 0, planId = 0, serial = 0;

async function pay(input: { invoiceId?: number | null; planId?: number | null; amountMinor: number; kind?: "payment" | "refund"; reversalOfId?: number }) {
  const result = await db.recordPayment({ patientId, invoiceId: input.invoiceId ?? null, planId: input.planId ?? null, kind: input.kind ?? "payment",
    reversalOfId: input.reversalOfId, amountMinor: input.amountMinor, currency: "SAR", baseCurrency: "YER", exchangeRate: 140,
    method: "cash", note: null, createdBy: "synthetic-cashier", idempotencyKey: `print-snapshot-${++serial}` });
  expect(result.reason).toBeNull(); if (!result.payment) throw new Error("Synthetic payment failed"); return result.payment;
}

beforeAll(async () => {
  await db.ensureSchema();
  await db.openShift({ openedBy: "synthetic-cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  [{ id: patientId }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('PRINT-SNAP-1', 'Synthetic print patient') RETURNING id`);
  [{ id: otherPatientId }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('PRINT-SNAP-2', 'Synthetic other patient') RETURNING id`);
  const invoice = await db.createInvoice({ patientId, baseCurrency: "SAR", discountMinor: 2_000, note: null, createdBy: "synthetic-reception",
    items: [{ serviceId: null, doctorId: null, description: "Synthetic crown #14", quantity: 1, unitPriceMinor: 15_000 },
      { serviceId: null, doctorId: null, description: "Synthetic temporary crown", quantity: 2, unitPriceMinor: 2_500 }] });
  if (!invoice) throw new Error("Synthetic invoice failed");
  const receipt = await pay({ invoiceId: invoice.id, amountMinor: 10_000 });
  await pay({ invoiceId: invoice.id, amountMinor: 1_000, kind: "refund", reversalOfId: receipt.id });
  const cancelled = await db.createInvoice({ patientId, baseCurrency: "SAR", discountMinor: 0, note: null, createdBy: "synthetic-reception",
    items: [{ serviceId: null, doctorId: null, description: "CANCELLED-PRINT-LINE", quantity: 1, unitPriceMinor: 40_000 }] });
  if (!cancelled) throw new Error("Synthetic cancelled invoice failed");
  expect(await db.setInvoiceStatus(cancelled.id, "cancelled", { actor: "synthetic-admin", actorRole: "admin" })).toBeTruthy();
  const plan = await db.createPlan({ patientId, title: "Synthetic print agreement", totalMinor: 300_000, baseCurrency: "SAR",
    startDate: "2026-10-01", note: null, createdBy: "synthetic-doctor",
    installments: [{ number: 1, dueDate: "2026-10-15", amountMinor: 150_000 }, { number: 2, dueDate: "2027-01-15", amountMinor: 150_000 }] });
  if (plan === null) throw new Error("Synthetic agreement failed");
  planId = plan;
  expect((await db.recordPlanConsent({ planId, actor: "synthetic-doctor", note: null })).ok).toBe(true);
  await pay({ planId, amountMinor: 120_000 });
  const other = await db.createInvoice({ patientId: otherPatientId, baseCurrency: "SAR", discountMinor: 0, note: null, createdBy: "synthetic-reception",
    items: [{ serviceId: null, doctorId: null, description: "OTHER-PATIENT-PRINT-LINE", quantity: 1, unitPriceMinor: 7_000 }] });
  if (!other) throw new Error("Synthetic other invoice failed");
}, 240_000);
afterAll(async () => { await db.resetPoolForTesting(); });

const printCurrent = async () => renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ id: String(patientId) }) }));
const sqlOf = (args: unknown[]) => typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string }).text ?? "");
const until = async (ready: () => boolean) => { for (let i = 0; i < 500 && !ready(); i++) await new Promise(r => setTimeout(r, 10)); expect(ready()).toBe(true); };

/** Commits a real on-account agreement payment after the receipts are listed and before the plans are read. */
async function interleavedPrint(amountMinor: number) {
  const pool = db.getPool();
  const original = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  let paymentsListed = false, injected = false;
  const spy = vi.spyOn(pool, "connect").mockImplementation(((...args: unknown[]) => {
    // pool.query() connects in callback style; pass those through uninstrumented.
    if (typeof args[0] === "function") return original(...args);
    return instrument(original() as Promise<PoolClient>);
  }) as unknown as typeof pool.connect);
  async function instrument(pending: Promise<PoolClient>) {
    const client = await pending;
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    const release = client.release.bind(client);
    client.query = (async (...args: unknown[]) => {
      const sql = sqlOf(args);
      if (sql.includes("WHERE y.patient_id = $1 ORDER BY y.created_at DESC, y.id DESC")) {
        const result = await query(...args); paymentsListed = true; return result;
      }
      if (!injected && sql.includes("t.total_from_items, t.consent_at") && sql.includes("t.patient_id=$1")) {
        injected = true;
        await until(() => paymentsListed);
        await pay({ planId, amountMinor });
      }
      return query(...args);
    }) as typeof client.query;
    client.release = ((destroy?: boolean | Error) => { client.query = query as typeof client.query; client.release = release; return release(destroy); }) as typeof client.release;
    return client;
  }
  try {
    const html = await printCurrent();
    expect(injected).toBe(true);
    return html;
  } finally { spy.mockRestore(); }
}

describe("current printed statement reads one coherent snapshot", () => {
  it("a payment committed between the reads never splits receipts and balances from agreement progress", async () => {
    // Before: SAR collected 10,000 − 1,000 + 120,000 = 129,000; agreement paid 120,000.
    const before = await printCurrent();
    expect(before).toContain(formatMoney(129_000, "SAR"));
    expect(before).toContain(formatMoney(120_000, "SAR"));
    const during = await interleavedPrint(7_000);
    // One snapshot: the in-between payment is in neither the balances nor the agreement.
    expect(during).toContain(formatMoney(129_000, "SAR"));
    expect(during).toContain(formatMoney(120_000, "SAR"));
    expect(during).not.toContain(formatMoney(127_000, "SAR"));
    expect(during).not.toContain(formatMoney(136_000, "SAR"));
    // The next request shows the payment in the receipts, the balances and the agreement together.
    const after = await printCurrent();
    for (const amount of [136_000, 127_000, 173_000]) expect(after).toContain(formatMoney(amount, "SAR"));
  });

  it("the current print keeps its content: lines, discount, cancelled filtering, labels and no other patient", async () => {
    const html = await printCurrent();
    for (const text of ["Synthetic crown #14", "Synthetic temporary crown", formatMoney(2_000, "SAR"), formatMoney(18_000, "SAR"),
      "Synthetic print agreement", formatMoney(300_000, "SAR")]) expect(html).toContain(text);
    const [original] = await q<{ receipt_number: string }>(`SELECT receipt_number FROM payments WHERE patient_id = $1 AND kind = 'payment' ORDER BY id LIMIT 1`, [patientId]);
    expect(html).toContain(original.receipt_number);
    expect(html).toContain("استرداد");
    expect(html).not.toContain("عكس سند");
    expect(html).not.toContain("CANCELLED-PRINT-LINE");
    expect(html).not.toContain("OTHER-PATIENT-PRINT-LINE");
  });

  it("a read failure whose ROLLBACK also fails keeps the original error and discards the client", async () => {
    const pool = db.getPool();
    const original = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
    const released: unknown[] = [];
    const spy = vi.spyOn(pool, "connect").mockImplementation(((...args: unknown[]) => {
      if (typeof args[0] === "function") return original(...args);
      return (async () => {
        const client = await (original() as Promise<PoolClient>);
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        const release = client.release.bind(client);
        let began = false;
        client.query = (async (...args: unknown[]) => {
          const sql = sqlOf(args);
          if (sql.startsWith("BEGIN")) { began = true; return query(...args); }
          if (sql === "ROLLBACK") throw new Error("synthetic rollback failure");
          if (began && sql.includes("t.total_from_items, t.consent_at")) throw new Error("synthetic print read failure");
          return query(...args);
        }) as typeof client.query;
        client.release = ((destroy?: boolean | Error) => { released.push(destroy); client.query = query as typeof client.query; client.release = release; return release(destroy); }) as typeof client.release;
        return client;
      })();
    }) as unknown as typeof pool.connect);
    try {
      await expect(printCurrent()).rejects.toThrow("synthetic print read failure");
      expect(released).toContain(true);
      expect((await pool.query<{ ok: number }>("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally { spy.mockRestore(); }
  });
});
