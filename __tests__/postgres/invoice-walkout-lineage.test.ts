import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import { toInputAmount, type Currency } from "../../lib/money";
import { readInvoiceSettlementPosition } from "../../lib/invoice-settlement-position";
import { readReceptionHandoff } from "../../lib/reception-handoff-db";
import { visitCheckoutSummary } from "../../lib/checkout-db";

assertRealPostgresUrl(); stubPostgresEnv();
const db = await import("../../lib/db"), auth = await import("../../lib/auth");
const revision = await import("../../lib/invoice-revision-db");
const history = await import("../../lib/legacy-treatment-document-db");
let session: SessionPayload, doctorId: number, serviceId: number, serial = 0;
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!); await db.ensureSchema();
  const hash = await auth.hashPassword("synthetic-invoice-consumer");
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('invoice-consumer','Synthetic invoice consumer',$1,'admin',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "invoice-consumer", role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: auth.sessionCredentialVersion(hash) };
  doctorId = (await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic invoice consumer doctor') RETURNING id"))[0].id;
  serviceId = (await q("INSERT INTO services(name,category,price_minor,price_sar_minor,price_usd_minor,price_configured,is_active) VALUES('Synthetic historical group','ortho',1500,1500,1500,TRUE,TRUE) RETURNING id"))[0].id;
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180000);
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(currency: Currency) {
  const patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic invoice consumer') RETURNING id", [`CONSUMER-${++serial}`]))[0].id as number;
  const invoice = await db.createInvoice({ patientId, baseCurrency: currency, discountMinor: 0, note: null, createdBy: session.username,
    items: [{ serviceId: null, doctorId: null, description: "Synthetic immutable invoice", quantity: 1, unitPriceMinor: 1000 }] });
  if (!invoice) throw new Error("Synthetic invoice failed");
  const visitId = (await q("INSERT INTO visits(patient_id,patient_name,doctor_id,diagnosis,treatment_done,invoice_id) VALUES($1,'Synthetic invoice consumer',$2,'Synthetic review','Synthetic no additional fees',$3) RETURNING id", [patientId, doctorId, invoice.id]))[0].id as number;
  return { patientId, visitId, invoice };
}
async function pay(patientId: number, invoiceId: number | null, currency: Currency, amountMinor: number, reversalOfId?: number) {
  const result = await db.recordPayment({ patientId, invoiceId, ...(invoiceId === null ? { openingCurrency: currency } : {}),
    kind: reversalOfId ? "refund" : "payment", amountMinor, currency, baseCurrency: "YER", exchangeRate: currency === "SAR" ? 140 : currency === "USD" ? 530 : 1,
    method: "cash", note: null, createdBy: session.username, reversalOfId, idempotencyKey: `consumer-payment-${++serial}` });
  expect(result.reason).toBeNull(); if (!result.payment) throw new Error("Synthetic payment failed"); return result.payment;
}
async function correct(invoiceId: number, amount: number, currency: Currency) {
  const view = await revision.readInvoiceRevision(invoiceId, session);
  const result = await revision.reviseInvoice(invoiceId, { idempotencyKey: `consumer-correction-${++serial}`, expectedSourceHash: view.sourceHash,
    reason: "Synthetic release integration correction", lines: view.invoice.items.map(item => ({ itemId: item.id, quantity: 1, unitPrice: toInputAmount(amount, currency) })),
    discount: "0", discountReason: null, repaymentTerms: { mode: "full", installments: [] }, expectedRemainingMinor: Math.max(0, amount - view.settledMinor) }, session);
  if (!("corrected" in result) || !result.corrected) throw new Error("Synthetic correction failed"); return result.corrected;
}
async function position(patientId: number, invoiceId: number, currency: Currency) {
  const client = await db.getPool().connect();
  try { await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); const value = await readInvoiceSettlementPosition(client, { patientId, invoiceId, currency }); await client.query("COMMIT"); return value; }
  finally { await client.query("ROLLBACK").catch(() => undefined); client.release(); }
}
async function walkout(visitId: number) { const value = await db.visitWalkout(visitId); if (!value) throw new Error("Synthetic walkout missing"); return value; }
async function footprint(patientId: number) { return q("SELECT to_jsonb(p) AS value FROM payments p WHERE patient_id=$1 ORDER BY id", [patientId]); }

describe("invoice release integration with signing and canonical walkout lineage", () => {
  it.each(["YER", "SAR", "USD"] as const)("retains explicit %s invoice on no-fee signing without another invoice or receipt", async currency => {
    const f = await fixture(currency), before = await footprint(f.patientId);
    const result = await db.signClinicalVisit({ visitId: f.visitId, baseCurrency: "YER", signedBy: session.username, signerRole: "admin", signerDoctorPartyId: doctorId });
    expect(result).toMatchObject({ reason: null, invoiceId: null, invoiceCurrency: currency, duesMinor: 0, visit: { invoiceId: f.invoice.id } });
    expect((await q("SELECT invoice_id FROM visits WHERE id=$1", [f.visitId]))[0].invoice_id).toBe(f.invoice.id);
    expect(await footprint(f.patientId)).toEqual(before);
    expect(await q("SELECT id FROM invoices WHERE patient_id=$1", [f.patientId])).toEqual([{ id: f.invoice.id }]);
  });
  it.each((["YER", "SAR", "USD"] as const).flatMap(currency => [0, 400, 1000].map(paid => ({ currency, paid }))))("$currency carries original paid$paid through two corrections and ancestor refunds", async ({ currency, paid }) => {
    const f = await fixture(currency);
    const receipt = paid ? await pay(f.patientId, f.invoice.id, currency, paid) : null;
    // A receipt from a prior day must not become unrelated previous credit when
    // its principal is excluded from the visit's previous-balance projection.
    if (receipt) await q("UPDATE payments SET created_at=NOW()-INTERVAL '3 days' WHERE id=$1", [receipt.id]);
    await q("UPDATE visits SET signed_at=NOW(),status='done' WHERE id=$1", [f.visitId]);
    const first = await correct(f.invoice.id, 950, currency), current = await correct(first.id, 900, currency);
    const before = await footprint(f.patientId), value = await walkout(f.visitId), summary = await visitCheckoutSummary(value);
    expect(value.invoice).toMatchObject({ id: current.id, currency, netMinor: 900 });
    expect(value.checkout.invoicePaidMinor).toBe(paid);
    expect(value.checkout.current[currency]).toBe(900 - paid);
    expect(value.checkout.previous[currency]).toBe(0);
    expect(summary.find(row => row.currency === currency)).toMatchObject({ todayRemainingMinor: Math.max(0, 900 - paid), dueNowMinor: Math.max(0, 900 - paid) });
    expect((await readReceptionHandoff(f.visitId, value))?.status).toBe(paid === 1000 ? "collected" : "pending");
    const proof = await position(f.patientId, current.id, currency);
    expect(proof).toMatchObject({ settledMinor: paid, remainingMinor: Math.max(0, 900 - paid), creditMinor: Math.max(0, paid - 900) });
    expect(await footprint(f.patientId)).toEqual(before);
    if (receipt) {
      const refund = await pay(f.patientId, f.invoice.id, currency, Math.min(200, paid), receipt.id);
      const after = await walkout(f.visitId), next = await position(f.patientId, current.id, currency);
      expect(after.checkout.invoicePaidMinor).toBe(paid - Math.min(200, paid));
      expect(after.checkout.current[currency]).toBe(900 - paid + Math.min(200, paid));
      expect(next.proofHash).not.toBe(proof.proofHash);
      expect((await readReceptionHandoff(f.visitId, after))?.status).toBe("pending");
      expect(await q("SELECT invoice_id FROM payments WHERE id=ANY($1::int[]) ORDER BY id", [[receipt.id, refund.id]])).toEqual([{ invoice_id: f.invoice.id }, { invoice_id: f.invoice.id }]);
    }
  });
  it("refuses additional billable work on an already linked visit without partial signature or duplicate invoice", async () => {
    const f = await fixture("YER");
    await db.setVisitProcedures({ visitId: f.visitId, procedures: [{ serviceId, doctorId, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 1500, priceReason: null, note: null, planItemId: null }] });
    const before = await footprint(f.patientId);
    await expect(db.signClinicalVisit({ visitId: f.visitId, baseCurrency: "YER", signedBy: session.username, signerRole: "admin", signerDoctorPartyId: doctorId })).rejects.toThrow(/فاتورة مرتبطة/);
    expect(await q("SELECT invoice_id,signed_at FROM visits WHERE id=$1", [f.visitId])).toEqual([{ invoice_id: f.invoice.id, signed_at: null }]);
    expect(await q("SELECT id FROM invoices WHERE patient_id=$1", [f.patientId])).toEqual([{ id: f.invoice.id }]); expect(await footprint(f.patientId)).toEqual(before);
  });
  it("refuses a zero-valued plan milestone that would lose its separate commission source behind an existing invoice link", async () => {
    const f = await fixture("YER");
    const plan = await db.createPlanV2({ patientId: f.patientId, title: "Synthetic completion milestone", specialty: null, primaryDoctorId: doctorId,
      billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-10-01", note: null, createdBy: session.username,
      items: [{ serviceId, serviceName: "Synthetic historical group", category: "ortho", toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 1500,
        billingRule: "on_completion", sessionCount: 2, note: null }], installments: [] });
    if (!plan.ok) throw new Error(plan.message);
    expect(await db.recordPlanConsent({ planId: plan.planId, actor: session.username, note: null })).toMatchObject({ ok: true });
    const itemId = (await q("SELECT id FROM plan_items WHERE plan_id=$1", [plan.planId]))[0].id as number;
    await db.setVisitProcedures({ visitId: f.visitId, procedures: [{ serviceId, doctorId, toothCode: null, surfaces: null, quantity: 1, unitPriceMinor: 0, priceReason: null, note: null, planItemId: itemId }] });
    const state = () => q(`SELECT jsonb_build_object(
      'item',(SELECT to_jsonb(i) FROM plan_items i WHERE id=$1),
      'sessions',(SELECT jsonb_agg(s ORDER BY id) FROM treatment_sessions s WHERE visit_id=$2),
      'visit',(SELECT to_jsonb(v) FROM visits v WHERE id=$2),
      'invoices',(SELECT jsonb_agg(i ORDER BY id) FROM invoices i WHERE patient_id=$3),
      'payments',(SELECT jsonb_agg(p ORDER BY id) FROM payments p WHERE patient_id=$3)) AS value`, [itemId, f.visitId, f.patientId]);
    const before = await state();
    await expect(db.signClinicalVisit({ visitId: f.visitId, baseCurrency: "YER", signedBy: session.username, signerRole: "admin", signerDoctorPartyId: doctorId })).rejects.toThrow(/مصدر.*استحقاق|مصدر.*عمولة/);
    expect(await state()).toEqual(before);
  });
  it.each(["YER", "SAR", "USD"] as const)("keeps historical %s opening-only facts and corrections separate from a visit invoice", async currency => {
    const f = await fixture(currency);
    await q("UPDATE visits SET invoice_id=NULL WHERE id=$1", [f.visitId]);
    await db.setInvoiceStatus(f.invoice.id, "cancelled", { actor: session.username, actorRole: "admin" });
    const source = { patientId: f.patientId, currency, items: [{ serviceId, quantity: 1, price: toInputAmount(1500, currency), catalogPriceMinor: 1500, scope: "both" }], discount: "0", discountReason: null,
      previouslyPaidAmount: toInputAmount(500, currency), historicalAsOf: "2026-10-01", note: null, idempotencyKey: `consumer-history-${++serial}`,
      repaymentTerms: { mode: "full", installments: [] }, repaymentRemainingMinor: 1000, repaymentVersion: 0, repaymentSourceHash: null };
    const saved = await history.createHistoricalDocument(f.patientId, source, session);
    await pay(f.patientId, null, currency, 400);
    const [view] = await history.listHistoricalDocuments(f.patientId);
    await history.correctHistoricalDocument(f.patientId, saved.document.id, { idempotencyKey: `consumer-history-fix-${++serial}`, expectedVersion: view.version, expectedSourceHash: view.sourceHash,
      prices: [toInputAmount(1400, currency)], discount: "0", discountReason: null, previouslyPaidAmount: toInputAmount(500, currency), historicalAsOf: "2026-10-01", note: null,
      reason: "Synthetic historical consumer correction", repaymentTerms: { mode: "full", installments: [] }, repaymentRemainingMinor: 500, repaymentVersion: view.scheduleVersion }, session);
    const signed = await db.signClinicalVisit({ visitId: f.visitId, baseCurrency: currency, signedBy: session.username, signerRole: "admin", signerDoctorPartyId: doctorId });
    expect(signed).toMatchObject({ reason: null, invoiceId: null, visit: { invoiceId: null } });
    const value = await walkout(f.visitId); expect(value.invoice).toBeNull(); expect(value.checkout.invoicePaidMinor).toBe(0); expect(value.checkout.current[currency]).toBe(500);
    expect((await q("SELECT count(*)::int AS n FROM invoices WHERE patient_id=$1", [f.patientId]))[0].n).toBe(1); // only the cancelled unrelated fixture, never historical cash
    expect((await q("SELECT count(*)::int AS n FROM payments WHERE patient_id=$1", [f.patientId]))[0].n).toBe(1);
    expect(await q("SELECT invoice_id,opening_currency FROM payments WHERE patient_id=$1", [f.patientId])).toEqual([{ invoice_id: null, opening_currency: currency }]);
  });
  it("does not borrow another invoice or currency's settlement and rejects foreign lineage", async () => {
    const f = await fixture("SAR"), other = await fixture("USD");
    await pay(other.patientId, other.invoice.id, "USD", 1000);
    expect((await walkout(f.visitId)).checkout.invoicePaidMinor).toBe(0);
    await q("UPDATE visits SET invoice_id=$2 WHERE id=$1", [f.visitId, other.invoice.id]);
    await expect(db.visitWalkout(f.visitId)).rejects.toMatchObject({ code: "missing" });
  });
  it("keeps the visit link, invoice amounts, ledger and ancestor settlement in one snapshot during a real concurrent correction/refund", async () => {
    const f = await fixture("YER"), paid = await pay(f.patientId, f.invoice.id, "YER", 400);
    let observed!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { observed = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
    const original = Client.prototype.query;
    // Only pause real reads; no synthetic rows or successful responses replace
    // the database. Canonical correction/refund writers use other connections.
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function(this: Client, ...args: unknown[]) {
      const text = typeof args[0] === "string" ? args[0].replace(/\s+/g, " ") : "", values = Array.isArray(args[1]) ? args[1] : [];
      const ownerRead = values[0] === f.visitId && text.includes("FROM visits v") && text.includes("WHERE v.id = $1");
      const heldRead = values[0] === f.visitId && text.includes("FROM visit_procedures pr");
      const invoke = (call: unknown[]) => Reflect.apply(original, this, call);
      if (!ownerRead && !heldRead) return invoke(args);
      const callback = typeof args.at(-1) === "function" ? args.at(-1) as (error: unknown, value?: unknown) => void : null;
      if (callback) {
        const execute = () => invoke([...args.slice(0, -1), (error: unknown, value: unknown) => { if (ownerRead && !error) observed(); callback(error, value); }]);
        if (heldRead) { void proceed.then(execute).catch(callback); return undefined; } return execute();
      }
      const execute = async () => { const value = await invoke(args); if (ownerRead) observed(); return value; };
      return heldRead ? proceed.then(execute) : execute();
    } as typeof original);
    const pending = db.visitWalkout(f.visitId); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([started, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error("Walkout owner read did not finish")), 5000); })]);
      const changed = await correct(f.invoice.id, 900, "YER"); await pay(f.patientId, f.invoice.id, "YER", 200, paid.id);
      release(); const old = await pending, fresh = await walkout(f.visitId);
      expect(old).toMatchObject({ invoice: { id: f.invoice.id, netMinor: 1000 }, checkout: { invoicePaidMinor: 400, current: { YER: 600 } } });
      expect(fresh).toMatchObject({ invoice: { id: changed.id, netMinor: 900 }, checkout: { invoicePaidMinor: 200, current: { YER: 700 } } });
    } finally { clearTimeout(timer); release(); await pending.catch(() => undefined); spy.mockRestore(); }
  });
});
