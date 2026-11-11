/** Review request 6801961109 on #483: a financial correction on the canonical runtime changes line
 * prices and the discount only by the price grants (G4-1), judged on what actually changed against
 * the values stored under the writer's locks. The correction grant (and, for a historical
 * document, opening management) is not a price exception. Real PostgreSQL, synthetic data only.
 * Both paths: an issued invoice and a historical treatment document. Each refusal leaves no
 * financial write behind. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-correction-price-authority-secret");
const db = await import("../../lib/db");
const fixes = await import("../../lib/canonical-invoice-corrections");
const history = await import("../../lib/canonical-history-documents");
const documents = await import("../../lib/legacy-treatment-document-db");

const CORRECT = { "finance.invoices.view": true, "finance.invoices.correct": true };
const HISTORY = { "patients.history.record": true, "patients.history.correct": true, "finance.patient-ledger.view": true, "finance.opening-balances.manage": true };
const APPLY = { "finance.discounts.apply": true }, OVERRIDE = { ...APPLY, "finance.discounts.override": true }, INCREASE = { "finance.price-increases.apply": true };
const ACCOUNTS = {
  owner: { username: "SYN-CP-OWNER", role: "admin" },
  plain: { username: "SYN-CP-PLAIN", role: "admin", patientScope: "all", grants: CORRECT },
  raiser: { username: "SYN-CP-RAISE", role: "accountant", patientScope: "all", grants: { ...CORRECT, ...INCREASE } },
  discounter: { username: "SYN-CP-DISC", role: "accountant", patientScope: "all", grants: { ...CORRECT, ...APPLY } },
  overrider: { username: "SYN-CP-OVER", role: "accountant", patientScope: "all", grants: { ...CORRECT, ...OVERRIDE } },
  doctor: { username: "SYN-CP-DR", role: "doctor", doctor: true, patientScope: "own", grants: { ...CORRECT, ...HISTORY, ...OVERRIDE, ...INCREASE } },
  hPlain: { username: "SYN-CP-HPLAIN", role: "admin", patientScope: "all", grants: HISTORY },
  hRaiser: { username: "SYN-CP-HRAISE", role: "reception", patientScope: "all", grants: { ...HISTORY, ...INCREASE } },
  hDiscounter: { username: "SYN-CP-HDISC", role: "reception", patientScope: "all", grants: { ...HISTORY, ...APPLY } },
  hOverrider: { username: "SYN-CP-HOVER", role: "reception", patientScope: "all", grants: { ...HISTORY, ...OVERRIDE } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
let blockers: Pool;
let serial = 0, service = 0, endo = 0;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; message?: string }) => error);
const unauthorized = (text: string) => ({ code: "unauthorized", message: expect.stringContaining(text) });
const patient = async (doctor: number | null = null) => (await q(
  "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES ($1,'SYN CP patient',$2) RETURNING id", [`SYN-CP-${++serial}`, doctor]))[0].id as number;

/** Every financial fact of the patient the correction could touch. */
async function facts(patientId: number) {
  return JSON.stringify(await q(`SELECT
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id) FROM invoices i WHERE i.patient_id=$1) AS invoices,
    (SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.id) FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.patient_id=$1) AS items,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.id) FROM payments p WHERE p.patient_id=$1) AS payments,
    (SELECT count(*) FROM invoice_corrections c WHERE c.patient_id=$1) AS corrections,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.currency) FROM patient_opening_balances o WHERE o.patient_id=$1) AS opening,
    (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM legacy_treatment_document_revisions r JOIN legacy_treatment_documents d ON d.id=r.document_id WHERE d.patient_id=$1) AS revisions,
    (SELECT count(*) FROM audit_log a WHERE a.action IN ('invoice.correct','legacy_document.correct')) AS audits`, [patientId]));
}

// ── issued invoice ──────────────────────────────────────────────────────────────────────────────
/** One catalogue line (catalogue 10,000) written at `unit`, quantity `quantity`, optionally discounted and part paid. */
async function invoice(options: { unit?: number; quantity?: number; discount?: number; paid?: number; doctor?: number | null; manual?: boolean } = {}) {
  const { unit = 10_000, quantity = 1, discount = 0, paid = 0, doctor = null, manual = false } = options;
  const patientId = await patient(doctor);
  const made = await db.createInvoice({ patientId, baseCurrency: "YER", discountMinor: discount, note: null, createdBy: "SYN-CP-OWNER",
    items: [{ serviceId: manual ? null : service, doctorId: null, description: "SYN CP work", quantity, unitPriceMinor: unit }] } as never);
  if (!made) throw new Error("SYN invoice missing");
  if (paid) expect((await db.recordPayment({ patientId, invoiceId: made.id, kind: "payment", amountMinor: paid, currency: "YER", baseCurrency: "YER",
    exchangeRate: 1, method: "cash", note: null, createdBy: "SYN-CP-OWNER", idempotencyKey: `syn-cp-paid-${++serial}` })).reason).toBeNull();
  return { invoiceId: made.id as number, patientId };
}
async function change(key: Key, invoiceId: number, next: { unit: number; quantity?: number; discount?: number }, idempotencyKey = `syn-cp-corr-${++serial}`) {
  const view = await fixes.readCanonicalInvoiceRevision(await fx.session(key), String(invoiceId)) as { sourceHash: string; settledMinor: number; invoice: { items: { id: number }[] } };
  const quantity = next.quantity ?? 1, discount = next.discount ?? 0, remaining = Math.max(0, next.unit * quantity - discount - view.settledMinor);
  return { idempotencyKey, expectedSourceHash: view.sourceHash, reason: "SYN correct the agreed amount",
    lines: view.invoice.items.map(item => ({ itemId: item.id, quantity, unitPrice: String(next.unit) })), discount: String(discount), discountReason: discount > 0 ? "SYN agreed discount" : null,
    repaymentTerms: remaining > 0 ? { mode: "installments", installments: [{ dueDate: "2026-12-14", kind: "installment", amountMinor: remaining }] } : { mode: "full", installments: [] },
    expectedRemainingMinor: remaining };
}
const correct = async (key: Key, invoiceId: number, request: Record<string, unknown>) => fixes.commandCanonicalInvoiceRevision(await fx.session(key), String(invoiceId), request);
const priceAudit = async (invoiceId: number) => (await q("SELECT details->'priceAuthority' AS p FROM audit_log WHERE action='invoice.correct' AND entity_id=$1::text ORDER BY id DESC LIMIT 1", [invoiceId]))[0]?.p;

// ── historical document ─────────────────────────────────────────────────────────────────────────
/** One line at the catalogue price 55,000, paid 10,000 before the system, remaining 45,000. */
async function document(doctor: number | null = null) {
  const p = await patient(doctor);
  const body = { patientId: p, currency: "YER", items: [{ serviceId: endo, quantity: 1, price: "55000", catalogPriceMinor: 55000, toothCode: 26 }],
    discount: "0", discountReason: null, previouslyPaidAmount: "10000", historicalAsOf: "2025-02-01", note: null, idempotencyKey: `syn-cp-doc-${++serial}`,
    repaymentTerms: { mode: "full", installments: [] }, repaymentRemainingMinor: 45000, repaymentVersion: 0, repaymentSourceHash: null };
  const made = await history.commandCanonicalHistoricalDocument(await fx.session("hPlain"), p, body);
  return { patientId: p, documentId: made.document.id as number };
}
async function historyChange(patientId: number, documentId: number, next: { price?: number; discount?: number; paid?: number }, idempotencyKey = `syn-cp-hcor-${++serial}`) {
  const [view] = await documents.listHistoricalDocuments(patientId);
  const current = view as unknown as { version: number; sourceHash: string; scheduleVersion: number; lines: { unitPriceMinor: number }[]; discountMinor: number; discountReason: string | null;
    previouslyPaidMinor: number; historicalAsOf: string; note: string | null };
  const price = next.price ?? current.lines[0].unitPriceMinor, discount = next.discount ?? current.discountMinor, paid = next.paid ?? current.previouslyPaidMinor;
  return { idempotencyKey, expectedVersion: current.version, expectedSourceHash: current.sourceHash, prices: [String(price)], discount: String(discount),
    discountReason: discount > 0 ? (current.discountReason ?? "SYN agreed discount") : null, previouslyPaidAmount: String(paid), historicalAsOf: current.historicalAsOf, note: current.note,
    reason: "SYN corrected historical facts", repaymentTerms: { mode: "full", installments: [] }, repaymentRemainingMinor: price - discount - paid, repaymentVersion: current.scheduleVersion };
}
const correctHistory = async (key: Key, patientId: number, documentId: number, request: Record<string, unknown>) =>
  history.commandCanonicalHistoricalCorrection(await fx.session(key), patientId, documentId, request);

/** Holds the patient row, runs `during` once the writer waits for it, then releases. */
async function whileWaitingForPatient<T>(patientId: number, start: () => Promise<T>, during: () => Promise<void>): Promise<T> {
  const blocker: PoolClient = await blockers.connect();
  let pending: Promise<T> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("UPDATE patients SET full_name=full_name WHERE id=$1", [patientId]);
    pending = start();
    let waiting = false;
    for (let i = 0; i < 500 && !waiting; i++) {
      waiting = (await q("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM patients WHERE id=$1 FOR NO KEY UPDATE%'")).length > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await during();
    await blocker.query("COMMIT");
    return await pending;
  } finally { await blocker.query("ROLLBACK"); blocker.release(); await pending?.catch(() => undefined); }
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  blockers = new Pool({ connectionString: fx.pool.options.connectionString, ssl: false, max: 3 });
  service = (await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('SYN CP filling','restorative',10000,TRUE,TRUE) RETURNING id"))[0].id;
  endo = (await q("INSERT INTO services(name,category,price_minor,price_configured,is_active) VALUES('SYN CP endo','rct',55000,TRUE,TRUE) RETURNING id"))[0].id;
  await q(`INSERT INTO settings(key,value) VALUES('billing.max_discount_percent','10') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`);
  await db.openShift({ openedBy: "SYN-CP-OWNER", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await blockers?.end(); await fx?.close(); });

describe("issued invoice: the correction grant alone changes no price and no discount", () => {
  it("refuses a price above the catalogue, a price below it and a new discount, and writes nothing", async () => {
    const o = await invoice({ paid: 4_000 }), before = await facts(o.patientId);
    expect(await refusal(correct("plain", o.invoiceId, await change("plain", o.invoiceId, { unit: 12_000 })))).toMatchObject(unauthorized("صلاحية تطبيق زيادة السعر"));
    expect(await refusal(correct("plain", o.invoiceId, await change("plain", o.invoiceId, { unit: 9_500 })))).toMatchObject(unauthorized("صلاحية تطبيق الخصم"));
    expect(await refusal(correct("plain", o.invoiceId, await change("plain", o.invoiceId, { unit: 10_000, discount: 500 })))).toMatchObject(unauthorized("صلاحية تطبيق الخصم"));
    expect(await facts(o.patientId)).toBe(before);
  });

  it("a correction that keeps every amount needs no price grant: quantity, a kept off-catalogue price, a kept discount, removing the discount", async () => {
    const quantity = await invoice();
    expect(await correct("plain", quantity.invoiceId, await change("plain", quantity.invoiceId, { unit: 10_000, quantity: 2 }))).toMatchObject({ replayed: false, afterMinor: 20_000 });
    expect(await priceAudit(quantity.invoiceId)).toMatchObject({ changedLines: 0, discountChanged: false, overrides: [] });
    const kept = await invoice({ unit: 7_000, discount: 700 });
    expect(await correct("plain", kept.invoiceId, await change("plain", kept.invoiceId, { unit: 7_000, quantity: 2, discount: 700 }))).toMatchObject({ replayed: false, afterMinor: 13_300 });
    const removed = await invoice({ discount: 3_000 });
    expect(await correct("plain", removed.invoiceId, await change("plain", removed.invoiceId, { unit: 10_000, discount: 0 }))).toMatchObject({ replayed: false, afterMinor: 10_000 });
    const restored = await invoice({ unit: 7_000 });
    expect(await correct("plain", restored.invoiceId, await change("plain", restored.invoiceId, { unit: 10_000 }))).toMatchObject({ replayed: false, afterMinor: 10_000 });
  });

  it("a kept discount that becomes a higher share of a smaller invoice is decided again", async () => {
    const o = await invoice({ quantity: 2, discount: 1_500 }), before = await facts(o.patientId);
    expect(await refusal(correct("plain", o.invoiceId, await change("plain", o.invoiceId, { unit: 10_000, quantity: 1, discount: 1_500 })))).toMatchObject(unauthorized("صلاحية تطبيق الخصم"));
    expect(await refusal(correct("discounter", o.invoiceId, await change("discounter", o.invoiceId, { unit: 10_000, quantity: 1, discount: 1_500 })))).toMatchObject(unauthorized("يتجاوز الحد"));
    expect(await facts(o.patientId)).toBe(before);
  });

  it("the increase grant raises a price, with the override recorded in the audit; it gives no discount", async () => {
    const o = await invoice({ paid: 4_000 });
    expect(await refusal(correct("raiser", o.invoiceId, await change("raiser", o.invoiceId, { unit: 9_500 })))).toMatchObject(unauthorized("صلاحية تطبيق الخصم"));
    const receipts = await q("SELECT to_jsonb(p) AS r FROM payments p WHERE patient_id=$1 ORDER BY id", [o.patientId]);
    expect(await correct("raiser", o.invoiceId, await change("raiser", o.invoiceId, { unit: 12_000 }))).toMatchObject({ replayed: false, beforeMinor: 10_000, afterMinor: 12_000, settledMinor: 4_000 });
    expect(await priceAudit(o.invoiceId)).toMatchObject({ changedLines: 1, overrides: [{ kind: "increase", catalogMinor: 10_000, requestedMinor: 12_000 }] });
    expect(await q("SELECT to_jsonb(p) AS r FROM payments p WHERE patient_id=$1 ORDER BY id", [o.patientId])).toEqual(receipts);
  });

  it("the discount grant acts within the limit; beyond it only the override grant; neither raises a price", async () => {
    const line = await invoice(), before = await facts(line.patientId);
    expect(await refusal(correct("discounter", line.invoiceId, await change("discounter", line.invoiceId, { unit: 8_000 })))).toMatchObject(unauthorized("يتجاوز الحد"));
    expect(await refusal(correct("discounter", line.invoiceId, await change("discounter", line.invoiceId, { unit: 9_200, discount: 400 })))).toMatchObject(unauthorized("مجموع الخصم"));
    expect(await refusal(correct("overrider", line.invoiceId, await change("overrider", line.invoiceId, { unit: 12_000 })))).toMatchObject(unauthorized("صلاحية تطبيق زيادة السعر"));
    expect(await facts(line.patientId)).toBe(before);
    expect(await correct("discounter", line.invoiceId, await change("discounter", line.invoiceId, { unit: 9_000 }))).toMatchObject({ replayed: false, afterMinor: 9_000 });
    expect(await priceAudit(line.invoiceId)).toMatchObject({ overrides: [{ kind: "discount", discountPercent: 10 }] });
    const invoiceDiscount = await invoice();
    expect(await refusal(correct("discounter", invoiceDiscount.invoiceId, await change("discounter", invoiceDiscount.invoiceId, { unit: 10_000, discount: 2_000 })))).toMatchObject(unauthorized("يتجاوز الحد"));
    expect(await correct("discounter", invoiceDiscount.invoiceId, await change("discounter", invoiceDiscount.invoiceId, { unit: 10_000, discount: 1_000 }))).toMatchObject({ replayed: false, afterMinor: 9_000 });
    const beyond = await invoice();
    expect(await correct("overrider", beyond.invoiceId, await change("overrider", beyond.invoiceId, { unit: 6_000, discount: 1_000 }))).toMatchObject({ replayed: false, afterMinor: 5_000 });
  });

  it("a manual line without a catalogue service has no reference price and stays free, as on a new invoice", async () => {
    const o = await invoice({ manual: true });
    expect(await correct("plain", o.invoiceId, await change("plain", o.invoiceId, { unit: 14_000 }))).toMatchObject({ replayed: false, afterMinor: 14_000 });
  });

  it("retry: a refused key is not consumed; the stored receipt replays without the price grant", async () => {
    const o = await invoice(), key = `syn-cp-retry-${++serial}`;
    expect(await refusal(correct("plain", o.invoiceId, await change("plain", o.invoiceId, { unit: 12_000 }, key)))).toMatchObject({ code: "unauthorized" });
    const request = await change("raiser", o.invoiceId, { unit: 12_000 }, key);
    const done = await correct("raiser", o.invoiceId, request);
    expect(done).toMatchObject({ replayed: false, afterMinor: 12_000 });
    await fx.setGrants("raiser", CORRECT, { patientScope: "all" });
    try { expect(await correct("raiser", o.invoiceId, request)).toEqual({ ...done, replayed: true }); }
    finally { await fx.setGrants("raiser", { ...CORRECT, ...INCREASE }, { patientScope: "all" }); }
    expect(await q("SELECT count(*)::int AS n FROM invoice_corrections WHERE original_invoice_id=$1", [o.invoiceId])).toEqual([{ n: 1 }]);
  });

  it("a withdrawal of the price grant waits for the admitted correction; once it lands, the next price change is refused and writes nothing", async () => {
    const o = await invoice({ paid: 4_000 }), request = await change("raiser", o.invoiceId, { unit: 12_000 });
    let revoked = false, revoke: Promise<void> | undefined;
    try {
      const outcome = await whileWaitingForPatient(o.patientId, () => correct("raiser", o.invoiceId, request), async () => {
        revoke = fx.setGrants("raiser", CORRECT, { patientScope: "all" }).then(() => { revoked = true; });
        await new Promise(resolve => setTimeout(resolve, 300));
        // The operation holds its account: the grant cannot disappear under an admitted writer.
        expect(revoked).toBe(false);
      });
      expect(outcome).toMatchObject({ replayed: false, afterMinor: 12_000 });
      await revoke;
      expect(revoked).toBe(true);
      const corrected = (outcome as { corrected: { id: number } }).corrected.id, before = await facts(o.patientId);
      expect(await refusal(correct("raiser", corrected, await change("raiser", corrected, { unit: 13_000 })))).toMatchObject(unauthorized("صلاحية تطبيق زيادة السعر"));
      expect(await facts(o.patientId)).toBe(before);
    } finally { await revoke?.catch(() => undefined); await fx.setGrants("raiser", { ...CORRECT, ...INCREASE }, { patientScope: "all" }); }
  });

  it("outside the actor's scope reads as missing before any price decision; inside it the grants act", async () => {
    const outside = await invoice(), mine = await invoice({ doctor: fx.parties.doctor! }), before = await facts(outside.patientId);
    const request = await change("raiser", outside.invoiceId, { unit: 12_000 });
    const refused = await refusal(correct("doctor", outside.invoiceId, request));
    const missing = await refusal(correct("doctor", 2_000_000_000, request));
    expect(refused).toMatchObject({ code: "missing" });
    expect(refused?.message).toBe(missing?.message);
    expect(await facts(outside.patientId)).toBe(before);
    expect(await correct("doctor", mine.invoiceId, await change("doctor", mine.invoiceId, { unit: 12_000 }))).toMatchObject({ replayed: false, afterMinor: 12_000 });
  });
});

describe("historical document: correction and opening management alone change no price and no discount", () => {
  it("refuses a raised price, a lowered price and a new discount, and writes nothing", async () => {
    const d = await document(), before = await facts(d.patientId);
    expect(await refusal(correctHistory("hPlain", d.patientId, d.documentId, await historyChange(d.patientId, d.documentId, { price: 60_000 })))).toMatchObject(unauthorized("صلاحية تطبيق زيادة السعر"));
    expect(await refusal(correctHistory("hPlain", d.patientId, d.documentId, await historyChange(d.patientId, d.documentId, { price: 52_000 })))).toMatchObject(unauthorized("صلاحية تطبيق الخصم"));
    expect(await refusal(correctHistory("hPlain", d.patientId, d.documentId, await historyChange(d.patientId, d.documentId, { discount: 2_000 })))).toMatchObject(unauthorized("صلاحية تطبيق الخصم"));
    expect(await facts(d.patientId)).toBe(before);
  });

  it("a correction of the paid amount that keeps prices and discount needs no price grant", async () => {
    const d = await document();
    const corrected = await correctHistory("hPlain", d.patientId, d.documentId, await historyChange(d.patientId, d.documentId, { paid: 15_000 }));
    expect(corrected).toMatchObject({ replayed: false, document: { version: 2, previouslyPaidMinor: 15_000, totalMinor: 55_000 } });
    expect((await q("SELECT details->'priceAuthority' AS p FROM audit_log WHERE action='legacy_document.correct' AND entity_id=$1::text ORDER BY id DESC LIMIT 1", [d.patientId]))[0].p)
      .toMatchObject({ changedLines: 0, discountChanged: false, overrides: [] });
  });

  it("the increase grant raises a price; the discount grant acts within the limit; beyond it only the override grant", async () => {
    const raised = await document();
    expect(await refusal(correctHistory("hRaiser", raised.patientId, raised.documentId, await historyChange(raised.patientId, raised.documentId, { price: 52_000 })))).toMatchObject(unauthorized("صلاحية تطبيق الخصم"));
    expect(await correctHistory("hRaiser", raised.patientId, raised.documentId, await historyChange(raised.patientId, raised.documentId, { price: 60_000 })))
      .toMatchObject({ replayed: false, document: { version: 2, totalMinor: 60_000, remainingMinor: 50_000 } });
    const lowered = await document(), before = await facts(lowered.patientId);
    expect(await refusal(correctHistory("hDiscounter", lowered.patientId, lowered.documentId, await historyChange(lowered.patientId, lowered.documentId, { price: 40_000 })))).toMatchObject(unauthorized("يتجاوز الحد"));
    expect(await refusal(correctHistory("hDiscounter", lowered.patientId, lowered.documentId, await historyChange(lowered.patientId, lowered.documentId, { price: 60_000 })))).toMatchObject(unauthorized("صلاحية تطبيق زيادة السعر"));
    expect(await refusal(correctHistory("hDiscounter", lowered.patientId, lowered.documentId, await historyChange(lowered.patientId, lowered.documentId, { discount: 11_000 })))).toMatchObject(unauthorized("يتجاوز الحد"));
    expect(await facts(lowered.patientId)).toBe(before);
    expect(await correctHistory("hDiscounter", lowered.patientId, lowered.documentId, await historyChange(lowered.patientId, lowered.documentId, { discount: 5_500 })))
      .toMatchObject({ replayed: false, document: { version: 2, discountMinor: 5_500, remainingMinor: 39_500 } });
    const beyond = await document();
    expect(await correctHistory("hOverrider", beyond.patientId, beyond.documentId, await historyChange(beyond.patientId, beyond.documentId, { price: 40_000 })))
      .toMatchObject({ replayed: false, document: { version: 2, totalMinor: 40_000, remainingMinor: 30_000 } });
  });

  it("retry: a refused key is not consumed; the stored revision replays without the price grant", async () => {
    const d = await document(), key = `syn-cp-hretry-${++serial}`;
    expect(await refusal(correctHistory("hPlain", d.patientId, d.documentId, await historyChange(d.patientId, d.documentId, { price: 60_000 }, key)))).toMatchObject({ code: "unauthorized" });
    const request = await historyChange(d.patientId, d.documentId, { price: 60_000 }, key);
    const done = await correctHistory("hRaiser", d.patientId, d.documentId, request);
    expect(done).toMatchObject({ replayed: false, document: { version: 2 } });
    await fx.setGrants("hRaiser", HISTORY, { patientScope: "all" });
    try { expect(await correctHistory("hRaiser", d.patientId, d.documentId, request)).toEqual({ document: done.document, replayed: true }); }
    finally { await fx.setGrants("hRaiser", { ...HISTORY, ...INCREASE }, { patientScope: "all" }); }
    expect(await q("SELECT count(*)::int AS n FROM legacy_treatment_document_revisions WHERE document_id=$1", [d.documentId])).toEqual([{ n: 2 }]);
  });

  it("a withdrawal of the price grant waits for the admitted correction; once it lands, the next price change is refused and writes nothing", async () => {
    const d = await document(), request = await historyChange(d.patientId, d.documentId, { price: 60_000 });
    let revoked = false, revoke: Promise<void> | undefined;
    try {
      const outcome = await whileWaitingForPatient(d.patientId, () => correctHistory("hRaiser", d.patientId, d.documentId, request), async () => {
        revoke = fx.setGrants("hRaiser", HISTORY, { patientScope: "all" }).then(() => { revoked = true; });
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(revoked).toBe(false);
      });
      expect(outcome).toMatchObject({ replayed: false, document: { version: 2, totalMinor: 60_000 } });
      await revoke;
      expect(revoked).toBe(true);
      const before = await facts(d.patientId);
      expect(await refusal(correctHistory("hRaiser", d.patientId, d.documentId, await historyChange(d.patientId, d.documentId, { price: 65_000 })))).toMatchObject(unauthorized("صلاحية تطبيق زيادة السعر"));
      expect(await facts(d.patientId)).toBe(before);
    } finally { await revoke?.catch(() => undefined); await fx.setGrants("hRaiser", { ...HISTORY, ...INCREASE }, { patientScope: "all" }); }
  });

  it("outside the actor's scope reads as missing before any price decision; inside it the grants act", async () => {
    const outside = await document(), mine = await document(fx.parties.doctor!), before = await facts(outside.patientId);
    const refused = await refusal(correctHistory("doctor", outside.patientId, outside.documentId, await historyChange(outside.patientId, outside.documentId, { price: 60_000 })));
    const missing = await refusal(correctHistory("doctor", 2_000_000_000, outside.documentId, { idempotencyKey: `syn-cp-hcor-${++serial}` }));
    expect(refused).toMatchObject({ code: "missing" });
    expect(refused?.message).toBe(missing?.message);
    expect(await facts(outside.patientId)).toBe(before);
    expect(await correctHistory("doctor", mine.patientId, mine.documentId, await historyChange(mine.patientId, mine.documentId, { price: 60_000 })))
      .toMatchObject({ replayed: false, document: { version: 2, totalMinor: 60_000 } });
  });
});
