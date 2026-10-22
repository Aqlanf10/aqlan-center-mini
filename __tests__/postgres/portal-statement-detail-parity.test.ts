import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

/**
 * Portal statement detail parity on PostgreSQL 18: the patient portal feed and the printed
 * statement read the same stored data through the same readers. The portal shows each
 * current invoice's treatment lines at their stored prices and each active agreement's
 * total / paid / remaining from the canonical plan progress, in its own currency. A
 * cancelled invoice and its lines, an item-summed plan and other patients' data never
 * appear. Only the session gates are stubbed. Synthetic data only.
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_portal_statement_detail_test");

const gates = vi.hoisted(() => ({ portalPatientId: 0 }));
vi.mock("@/lib/portal-server", () => ({ requirePortalSession: async () => (gates.portalPatientId ? { patientId: gates.portalPatientId } : null) }));
vi.mock("@/lib/session", () => ({ requireSession: async () => ({ role: "admin", username: "synthetic-print", userId: 1 }) }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: ({ title }: { title: string }) => createElement("h1", null, title), PrintFooter: () => null }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));

const db = await import("../../lib/db");
const { GET } = await import("../../app/api/portal/statement/route");
const { default: StatementPage } = await import("../../app/print/statement/[id]/page");
const { formatMoney } = await import("../../lib/money");
const { clinicDateString } = await import("../../lib/schedule");
const { statementPaymentLabel } = await import("../../lib/statement-lines");

const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
let patientId = 0, otherPatientId = 0, cancelledNumber = "", agreementPlanId = 0;

async function pay(input: { invoiceId?: number | null; planId?: number | null; amountMinor: number; currency: "YER" | "SAR"; kind?: "payment" | "refund"; reversalOfId?: number }) {
  const result = await db.recordPayment({ patientId, invoiceId: input.invoiceId ?? null, planId: input.planId ?? null, kind: input.kind ?? "payment",
    reversalOfId: input.reversalOfId, amountMinor: input.amountMinor, currency: input.currency, baseCurrency: "YER",
    exchangeRate: input.currency === "SAR" ? 140 : 1, method: "cash", note: "INTERNAL-RECEIPT-NOTE", createdBy: "STAFF-USERNAME-SECRET",
    idempotencyKey: `portal-detail-${input.kind ?? "payment"}-${input.amountMinor}-${input.invoiceId ?? input.planId}` });
  expect(result.reason).toBeNull(); if (!result.payment) throw new Error("Synthetic payment failed"); return result.payment;
}

beforeAll(async () => {
  await db.ensureSchema();
  await db.openShift({ openedBy: "portal-detail-cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  [{ id: patientId }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('PORTAL-DETAIL-1', 'Synthetic portal patient') RETURNING id`);
  [{ id: otherPatientId }] = await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('PORTAL-DETAIL-2', 'Synthetic other patient') RETURNING id`);
  const invoice = async (owner: number, currency: "YER" | "SAR", discountMinor: number, lines: [string, number, number][]) => {
    const created = await db.createInvoice({ patientId: owner, baseCurrency: currency, discountMinor, note: "INTERNAL-INVOICE-NOTE", createdBy: "STAFF-USERNAME-SECRET",
      items: lines.map(([description, quantity, unitPriceMinor]) => ({ serviceId: null, doctorId: null, description, quantity, unitPriceMinor })) });
    if (!created) throw new Error("Synthetic invoice failed"); return created;
  };
  // A discounted two-line SAR invoice, partly paid then partly refunded.
  const discounted = await invoice(patientId, "SAR", 2_000, [["Synthetic crown #14", 1, 15_000], ["Synthetic temporary crown", 2, 2_500]]);
  const receipt = await pay({ invoiceId: discounted.id, amountMinor: 10_000, currency: "SAR" });
  await pay({ invoiceId: discounted.id, amountMinor: 1_000, currency: "SAR", kind: "refund", reversalOfId: receipt.id });
  // A YER invoice that is later cancelled: neither it nor its line may reach the patient copy.
  const cancelled = await invoice(patientId, "YER", 0, [["CANCELLED-OLD-TREATMENT", 1, 40_000]]);
  cancelledNumber = cancelled.invoiceNumber;
  expect(await db.setInvoiceStatus(cancelled.id, "cancelled", { actor: "synthetic-admin", actorRole: "admin" })).toBeTruthy();
  // A paid YER invoice without discount.
  const paid = await invoice(patientId, "YER", 0, [["Synthetic scaling", 1, 9_000]]);
  await pay({ invoiceId: paid.id, amountMinor: 9_000, currency: "YER" });
  // An agreed SAR treatment total with installments, paid on account against the agreement.
  const plan = await db.createPlan({ patientId, title: "Synthetic orthodontic agreement", totalMinor: 300_000, baseCurrency: "SAR",
    startDate: "2026-10-01", note: "INTERNAL-PLAN-NOTE", createdBy: "STAFF-USERNAME-SECRET",
    installments: [{ number: 1, dueDate: "2026-10-15", amountMinor: 150_000 }, { number: 2, dueDate: "2027-01-15", amountMinor: 150_000 }] });
  if (plan === null) throw new Error("Synthetic agreement failed");
  agreementPlanId = plan;
  expect((await db.recordPlanConsent({ planId: plan, actor: "synthetic-doctor", note: null })).ok).toBe(true);
  await pay({ planId: plan, amountMinor: 120_000, currency: "SAR" });
  // Another patient's line must never leak into this patient's copy.
  await invoice(otherPatientId, "YER", 0, [["OTHER-PATIENT-LINE", 1, 7_000]]);
}, 240_000);
afterAll(async () => { await db.resetPoolForTesting(); });

async function portalFeed() {
  gates.portalPatientId = patientId;
  const response = await GET();
  expect(response.status).toBe(200);
  return { body: await response.clone().text(), feed: await response.json() };
}
async function printed() {
  return renderToStaticMarkup(await StatementPage({ params: Promise.resolve({ id: String(patientId) }) }));
}

describe("portal statement detail matches the printed statement on real data", () => {
  it("current invoices carry their stored treatment lines; the cancelled invoice and its line do not appear", async () => {
    const { feed } = await portalFeed();
    const ledger = await db.patientLedger(patientId);
    const current = ledger.invoices.filter(row => row.status !== "cancelled");
    expect(feed.invoices.map((row: { invoiceNumber: string }) => row.invoiceNumber)).toEqual(current.map(row => row.invoiceNumber));
    feed.invoices.forEach((row: { items: unknown[]; totalMinor: number; discountMinor: number; netMinor: number }, index: number) => {
      expect(row.items).toEqual(current[index].items.map(({ description, quantity, unitPriceMinor, totalMinor }) => ({ description, quantity, unitPriceMinor, totalMinor })));
      expect(row.totalMinor - row.discountMinor).toBe(row.netMinor);
    });
    expect(feed.invoices.find((row: { invoiceNumber: string }) => row.invoiceNumber === cancelledNumber)).toBeUndefined();
    const html = await printed();
    for (const row of feed.invoices) for (const line of row.items) {
      expect(html).toContain(line.description);
      expect(html).toContain(formatMoney(line.totalMinor, row.baseCurrency));
    }
    expect(html).not.toContain("CANCELLED-OLD-TREATMENT");
  });

  it("the active agreement shows the canonical total, paid and remaining in its own currency, as printed", async () => {
    const { feed } = await portalFeed();
    const plans = await db.listPatientPlans(patientId, clinicDateString(new Date(), db.CLINIC_TIME_ZONE));
    const agreement = plans.find(plan => plan.id === agreementPlanId)!;
    expect(agreement.totalFromItems).toBe(false);
    expect(feed.agreements).toEqual([{ title: "Synthetic orthodontic agreement", currency: "SAR", totalMinor: 300_000,
      paidMinor: agreement.progress.paidMinor, remainingMinor: agreement.progress.remainingMinor }]);
    expect(feed.agreements[0].paidMinor).toBe(120_000);
    expect(feed.agreements[0].remainingMinor).toBe(180_000);
    const html = await printed();
    expect(html).toContain("Synthetic orthodontic agreement");
    for (const amount of [300_000, 120_000, 180_000]) expect(html).toContain(formatMoney(amount, "SAR"));
  });

  it("balances stay per currency and are the canonical ones; refunds and reversals keep their printed labels", async () => {
    const { feed } = await portalFeed();
    const ledger = await db.patientLedger(patientId);
    expect(feed.balances).toEqual(JSON.parse(JSON.stringify(db.ledgerBalancesByCurrency(patientId, ledger, await db.patientPlanCurrencies(patientId)))));
    const labels = feed.payments.map((row: { label: string }) => row.label);
    expect(labels).toEqual(ledger.payments.map(row => statementPaymentLabel(row, ledger.payments)));
    const reversal = ledger.payments.find(row => row.reversalOfId !== null)!;
    const original = ledger.payments.find(row => row.id === reversal.reversalOfId)!;
    expect(labels).toContain(`عكس سند ${original.receiptNumber}`);
  });

  it("nothing internal and nothing from another patient reaches the portal", async () => {
    const { body } = await portalFeed();
    for (const secret of ["STAFF-USERNAME-SECRET", "INTERNAL-RECEIPT-NOTE", "INTERNAL-INVOICE-NOTE", "INTERNAL-PLAN-NOTE",
      "CANCELLED-OLD-TREATMENT", "OTHER-PATIENT-LINE", "PORTAL-DETAIL-2"]) expect(body).not.toContain(secret);
    gates.portalPatientId = 0;
    const refused = await GET();
    expect(refused.status).toBe(401);
    expect((await refused.json()).message).toMatch(/[؀-ۿ]/);
  });
});
