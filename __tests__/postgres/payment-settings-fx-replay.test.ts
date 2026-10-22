import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

assertRealPostgresUrl();
stubPostgresEnv();

const auth = vi.hoisted(() => ({
  session: { username: "ci-settings-fx", role: "admin", userId: 1 } as {
    username: string;
    role: string;
    userId: number;
    financeAccess?: { collectPayments: boolean };
  } | null,
}));
vi.mock("@/lib/session", () => ({ requireSession: async () => auth.session }));

const db = await import("../../lib/db");
const { POST } = await import("../../app/api/payments/route");
const { answeringSimilarReview } = await import("./_similar-review");
// FX/audit replay is this suite's subject; equal amounts for one synthetic patient answer the advisory review as the operator would.
const reviewedPOST = (request: Request) => answeringSimilarReview(POST, request);
const { POST: correctPOST } = await import("../../app/api/payments/[id]/correct/route");
const actor = "ci-settings-fx";
const rawRate = 140.1234567;
const storedRate = 140.123457;
let patientId: number;
let otherPatientId: number;
let otherInvoiceId: number;
let planId: number;
let sequence = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await db.ensureSchema();
  ({ rows: [{ id: patientId }] } = await db.getPool().query(
    "INSERT INTO patients(patient_number,full_name) VALUES('CI-SETTINGS-FX','Synthetic FX patient') RETURNING id",
  ));
  ({ rows: [{ id: otherPatientId }] } = await db.getPool().query(
    "INSERT INTO patients(patient_number,full_name) VALUES('CI-SETTINGS-FX-OTHER','Synthetic other FX patient') RETURNING id",
  ));
  ({ rows: [{ id: otherInvoiceId }] } = await db.getPool().query(
    "INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES('CI-FX-OTHER-INVOICE',$1,10000,0,'YER') RETURNING id",
    [patientId],
  ));
  ({ rows: [{ id: planId }] } = await db.getPool().query(
    "INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,status) VALUES($1,'Synthetic non-installment target',10000,'YER','active') RETURNING id",
    [patientId],
  ));
  await db.getPool().query(
    "INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES($1,'YER',10000,'2026-10-01',$2)",
    [patientId, actor],
  );
  await openShift();
}, 180000);

beforeEach(async () => {
  auth.session = { username: actor, role: "admin", userId: 1 };
  await setRate(String(rawRate));
});
afterEach(() => {
  vi.restoreAllMocks();
  auth.session = { username: actor, role: "admin", userId: 1 };
});
afterAll(async () => { await db.resetPoolForTesting(); });

async function setRate(value: string) {
  // Synthetic settings only. Invalid settings intentionally bypass save validation
  // so the HTTP reader's existing defaults/invalid-value contract is exercised.
  await db.getPool().query(
    "INSERT INTO settings(key,value) VALUES('finance.rate.SAR',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
    [value],
  );
  db.invalidateSettingsCache();
}

async function openShift() {
  await db.getPool().query(
    "INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) VALUES($1,0,0,0)",
    [actor],
  );
}

async function fixture() {
  const key = `ci-settings-fx-${++sequence}`;
  const { rows: [invoice] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency) VALUES($1,$2,10000,0,'YER') RETURNING id",
    [key, patientId],
  );
  const { rows: [item] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO invoice_items(invoice_id,description,quantity,unit_price_minor,total_minor) VALUES($1,'Synthetic FX service',1,10000,10000) RETURNING id",
    [invoice.id],
  );
  return { key, invoiceId: invoice.id, itemId: item.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function request(f: Fixture, overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/payments", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": f.key },
    body: JSON.stringify({
      patientId, invoiceId: f.invoiceId, kind: "payment",
      amount: "0.81", currency: "SAR", method: "cash", note: "Original synthetic note",
      ...overrides,
    }),
  });
}

function explicitInput(f: Fixture, exchangeRate = rawRate) {
  return {
    patientId, invoiceId: f.invoiceId, kind: "payment" as const,
    amountMinor: 81, currency: "SAR" as const, baseCurrency: "YER" as const,
    exchangeRate, method: "cash", note: "Original synthetic note",
    createdBy: actor, actorRole: "admin", idempotencyKey: f.key,
  };
}

function historicalV1Hash(f: Fixture, exchangeRate = rawRate) {
  // Literal old v1 field order, independent of the production matcher.
  return createHash("sha256").update(JSON.stringify({
    v: 1, actor, patientId, invoiceId: f.invoiceId, kind: "payment",
    amountMinor: 81, currency: "SAR", baseCurrency: "YER",
    exchangeRate, method: "cash", reversalOfId: null,
  }), "utf8").digest("hex");
}

async function insertHistorical(
  f: Fixture,
  hash: string | null = historicalV1Hash(f),
  exchangeRate = rawRate,
  baseAmountMinor = 113,
) {
  // Only INSERT synthetic historical evidence. Never UPDATE a receipt/hash or
  // disable an append-only trigger to manufacture a compatibility case.
  const { rows: [row] } = await db.getPool().query<{ id: number }>(
    `INSERT INTO payments(
       receipt_number,patient_id,invoice_id,shift_id,kind,amount_minor,currency,
       exchange_rate,base_amount_minor,base_currency,method,note,created_by,
       idempotency_key,idempotency_request_hash)
     SELECT $1,$2,$3,id,'payment',81,'SAR',$4,$5,'YER','cash',
            'Original synthetic note',$6,$7,$8
       FROM cashier_shifts WHERE status='open' RETURNING id`,
    [`LEGACY-${f.key}`, patientId, f.invoiceId, exchangeRate, baseAmountMinor, actor, f.key, hash],
  );
  return row.id;
}

async function createHttp(f: Fixture, overrides: Record<string, unknown> = {}) {
  const response = await reviewedPOST(request(f, overrides));
  expect(response.status).toBe(201);
  return response.json();
}

async function storedRow(id: number) {
  return (await db.getPool().query("SELECT * FROM payments WHERE id=$1", [id])).rows[0];
}

async function snapshot() {
  const { rows: [row] } = await db.getPool().query(`
    SELECT
      (SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM payments p) AS payments,
      (SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM audit_log a) AS audits,
      (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY id),'[]'::jsonb) FROM invoices i) AS invoices,
      (SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY id),'[]'::jsonb) FROM invoice_corrections c) AS corrections,
      (SELECT COALESCE(jsonb_agg(to_jsonb(d) ORDER BY id),'[]'::jsonb) FROM invoice_settlement_reclassifications d) AS documents,
      (SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM invoice_settlement_reclassification_events e) AS events,
      (SELECT COALESCE(jsonb_agg(to_jsonb(i) ORDER BY id),'[]'::jsonb) FROM inventory_items i) AS stock_items,
      (SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY id),'[]'::jsonb) FROM inventory_movements m) AS stock_movements,
      (SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM cashier_shifts s) AS shifts,
      (SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY currency),'[]'::jsonb) FROM (
         SELECT currency,
           SUM(CASE WHEN kind='refund' THEN -amount_minor ELSE amount_minor END)::text AS native,
           SUM(CASE WHEN kind='refund' THEN -base_amount_minor ELSE base_amount_minor END)::text AS base
         FROM payments GROUP BY currency
       ) b) AS balances`);
  return row;
}

async function expectHttpReplay(f: Fixture, id: number, overrides: Record<string, unknown> = {}) {
  const before = await snapshot();
  const response = await reviewedPOST(request(f, overrides));
  expect(response.status).toBe(200);
  expect((await response.json()).id).toBe(id);
  const after = await snapshot();
  const { audits: oldAudits, ...oldFinancial } = before;
  const { audits: newAudits, ...newFinancial } = after;
  expect(newFinancial).toEqual(oldFinancial);
  expect(newAudits).toHaveLength(oldAudits.length + 1);
  expect(newAudits.slice(0, oldAudits.length)).toEqual(oldAudits);
  expect(newAudits.at(-1)).toMatchObject({
    action: "payment.idempotent_replay", entity: "payment", entity_id: String(id),
    actor, details: { المريض: patientId, مفتاح_الإعادة: f.key },
  });
}

async function expectHttpRefusal(f: Fixture, overrides: Record<string, unknown> = {}, status = 409) {
  const before = await snapshot();
  const response = await reviewedPOST(request(f, overrides));
  expect(response.status).toBe(status);
  expect(await snapshot()).toEqual(before);
  return response.json();
}

describe("A01–A06: bounded settings-owned FX proof, not repricing", () => {
  it("A01: replays a synthetic old raw-rate 81/113 receipt without changing its hash or inventing creation evidence", async () => {
    const f = await fixture();
    const id = await insertHistorical(f);
    const original = await storedRow(id);
    expect(Number(original.exchange_rate)).toBe(storedRate);
    expect(Number(original.base_amount_minor)).toBe(113);
    expect(original.idempotency_request_hash).toBe(historicalV1Hash(f));
    await expectHttpReplay(f, id);
    expect(await storedRow(id)).toEqual(original);
    expect((await db.getPool().query(
      "SELECT id FROM audit_log WHERE action='payment.create' AND entity_id=$1", [String(id)],
    )).rows).toHaveLength(0);
  });

  it("A02: conflicts after the original raw observation is lost instead of guessing from stored FX", async () => {
    const f = await fixture();
    await insertHistorical(f);
    await setRate("175.9876543");
    expect((await expectHttpRefusal(f)).message).toContain("مفتاح الإعادة");
  });

  it.each([
    ["changed", "175.9876543"],
    ["blank default", ""],
    ["invalid", "not-a-rate"],
  ])("A03: a six-digit success replays using its frozen snapshot with %s settings", async (_label, value) => {
    const f = await fixture();
    await setRate(String(storedRate));
    const original = await createHttp(f);
    expect(original.baseAmountMinor).toBe(114);
    await setRate(value);
    await expectHttpReplay(f, original.id);
  });

  it.each([
    [rawRate, true],
    [storedRate, false],
    [141, false],
    [140.1234568, false],
  ])("A04: direct explicit raw-rate intent retains strict comparison at %s", async (rate, exact) => {
    const f = await fixture();
    const first = await db.recordPayment(explicitInput(f));
    expect(first.reason).toBeNull();
    const before = await snapshot();
    const result = await db.recordPayment(explicitInput(f, rate));
    expect(result.reason).toBe(exact ? null : "idempotency_conflict");
    if (exact) expect(result).toMatchObject({ replayed: true, payment: { id: first.payment!.id } });
    else expect(result.payment).toBeNull();
    expect(await snapshot()).toEqual(before);
  });

  it("A05: an explicit six-digit original never admits a changed numeric intent through stored-rate fallback", async () => {
    const f = await fixture();
    expect((await db.recordPayment(explicitInput(f, storedRate))).reason).toBeNull();
    const before = await snapshot();
    expect(await db.recordPayment(explicitInput(f, 141))).toMatchObject({
      payment: null, reason: "idempotency_conflict",
    });
    expect(await snapshot()).toEqual(before);
  });

  it("A06: body exchangeRate, fxMode and candidate arrays cannot control pricing or replay", async () => {
    const f = await fixture();
    const created = await createHttp(f, {
      exchangeRate: 1, fxMode: "explicit-v1", compatibilityRates: [1, 999],
    });
    expect(created).toMatchObject({ amountMinor: 81, baseAmountMinor: 113, exchangeRate: storedRate });
    expect((await storedRow(created.id)).idempotency_request_hash).toBe(historicalV1Hash(f));
    await expectHttpReplay(f, created.id, {
      exchangeRate: 999, fxMode: "settings-owned-v2", compatibilityRates: [rawRate],
    });
    await setRate("175.9876543");
    await expectHttpRefusal(f, { exchangeRate: rawRate, fxMode: "settings-owned", compatibilityRates: [rawRate] });
  });
});

describe("A07–A08: every original identity/authorization gate stays in force", () => {
  it.each([
    "actor", "patient", "amount", "currency", "invoice", "plan", "opening", "method", "kind", "origin",
  ])("A07: changing %s cannot replay or write financial evidence", async field => {
    const f = await fixture();
    const original = await createHttp(f);
    const overrides: Record<string, unknown> = {};
    let status = 409;
    if (field === "actor") auth.session = { username: "ci-other-actor", role: "admin", userId: 2 };
    if (field === "patient") overrides.patientId = otherPatientId;
    if (field === "amount") overrides.amount = "0.82";
    if (field === "currency") overrides.currency = "USD";
    if (field === "invoice") overrides.invoiceId = otherInvoiceId;
    if (field === "plan") Object.assign(overrides, { invoiceId: null, planId });
    if (field === "opening") Object.assign(overrides, { invoiceId: null, openingCurrency: "YER" });
    if (field === "method") overrides.method = "transfer";
    if (field === "kind") { overrides.kind = "refund"; status = 400; }
    if (field === "origin") overrides.reversalOfId = original.id;
    await expectHttpRefusal(f, overrides, status);
  });

  it("A07: expired sessions, nonfinancial roles and restricted cashiers remain rejected on an exact successful key", async () => {
    const f = await fixture();
    await createHttp(f);
    for (const [session, status] of [
      [null, 401],
      [{ username: actor, role: "doctor", userId: 1 }, 403],
      [{ username: actor, role: "cashier", userId: 1, financeAccess: { collectPayments: false } }, 403],
    ] as const) {
      auth.session = session;
      await expectHttpRefusal(f, {}, status);
    }
  });

  it("A08: changing only note retains v1 identity without rewriting the saved note", async () => {
    const f = await fixture();
    const original = await createHttp(f);
    await expectHttpReplay(f, original.id, { note: "A different retry note" });
    expect((await storedRow(original.id)).note).toBe("Original synthetic note");
  });
});

describe("A13–A14: invalid new-write FX and existing admission gates", () => {
  it.each(["not-a-rate", "0"])("A13: a genuinely new key with invalid FX %s refuses before any money or audit", async value => {
    const f = await fixture();
    await setRate(value);
    expect(await expectHttpRefusal(f)).toMatchObject({ reason: "exchange_rate_required" });
  });

  it("A13: a blank setting retains the existing default 140 and ordinary v1 pricing", async () => {
    const f = await fixture();
    await setRate("");
    const created = await createHttp(f);
    expect(created).toMatchObject({ exchangeRate: 140, baseAmountMinor: 113 });
    expect((await storedRow(created.id)).idempotency_request_hash).toBe(historicalV1Hash(f, 140));
    await expectHttpReplay(f, created.id);
  });

  it("A14: exact replay survives shift closure while a new request still requires an open shift", async () => {
    const f = await fixture();
    const original = await createHttp(f);
    await db.getPool().query(
      "UPDATE cashier_shifts SET status='closed',closed_at=NOW(),closed_by=$1 WHERE status='open'", [actor],
    );
    try {
      await expectHttpReplay(f, original.id);
      expect((await expectHttpRefusal({ ...f, key: `${f.key}-new` })).message).toContain("وردية");
    } finally {
      // Never reopen or edit a closed shift.
      await openShift();
    }
  });

  it("A14: exact replay survives canonical invoice cancellation while new money remains refused", async () => {
    const f = await fixture();
    const original = await createHttp(f);
    const corrected = await db.correctInvoice({
      invoiceId: f.invoiceId, reason: "Synthetic invoice correction for replay",
      actor, actorRole: "admin", lines: [{ itemId: f.itemId, quantity: 1, unitPriceMinor: 9000 }],
    });
    expect(corrected.ok).toBe(true);
    await expectHttpReplay(f, original.id);
    expect((await expectHttpRefusal({ ...f, key: `${f.key}-new` })).message).toContain("الفاتورة");
  });
});

describe("A17–A20: opaque purpose hashes and excluded lanes remain distinct", () => {
  it.each([
    ["null", null],
    ["malformed", "not-a-v1-fingerprint"],
    ["other purpose", createHash("sha256").update('{"purpose":"reversed-installment-recovery","v":1}').digest("hex")],
  ])("A17: an occupied %s fingerprint conflicts despite matching stored fields", async (_label, hash) => {
    const f = await fixture();
    await insertHistorical(f, hash);
    expect((await expectHttpRefusal(f)).message).toContain("مفتاح الإعادة");
  });

  it("A18: inherited refund replay remains stable after later refunds exhaust the conserved source", async () => {
    const f = await fixture();
    const original = await createHttp(f);
    const first = { ...f, key: `${f.key}-refund-first` };
    const refundBody = { invoiceId: null, kind: "refund", reversalOfId: original.id, amount: "0.40" };
    const part = await createHttp(first, refundBody);
    expect(part).toMatchObject({ amountMinor: 40, baseAmountMinor: 56, exchangeRate: storedRate });
    const rest = await createHttp({ ...f, key: `${f.key}-refund-rest` }, { ...refundBody, amount: "0.41" });
    expect(rest.baseAmountMinor).toBe(57);
    await setRate("175.9876543");
    await expectHttpReplay(first, part.id, { ...refundBody, exchangeRate: 999, fxMode: "explicit-v1" });
    const before = await snapshot();
    const directReplay = await db.recordPayment({
      ...explicitInput(first, 999), invoiceId: null, kind: "refund", amountMinor: 40, reversalOfId: original.id,
    });
    expect(directReplay).toMatchObject({ reason: null, replayed: true, payment: { id: part.id, baseAmountMinor: 56 } });
    expect(await snapshot()).toEqual(before);
    expect((await db.getPool().query(
      "SELECT SUM(amount_minor)::text AS native,SUM(base_amount_minor)::text AS base FROM payments WHERE reversal_of_id=$1",
      [original.id],
    )).rows[0]).toEqual({ native: "81", base: "113" });
  });

  it("A19: direct raw-rate correction retry still conflicts while the HTTP saved-rate contract replays", async () => {
    const f = await fixture();
    const original = await createHttp(f);
    const key = `${f.key}-correct`;
    const reason = "Synthetic raw correction contract";
    const correction = {
      paymentId: original.id, reason, actor, actorRole: "admin", idempotencyKey: key,
      replacement: {
        amountMinor: 81, currency: "SAR" as const, exchangeRate: rawRate,
        method: "cash", target: { kind: "original" as const },
      },
    };
    const made = await db.correctPayment(correction);
    expect(made.reason).toBeNull();
    if (made.reason !== null) throw new Error(made.reason);
    expect(made.replacement).toMatchObject({ baseAmountMinor: 113, exchangeRate: storedRate });
    expect(made.reversal).toMatchObject({ baseAmountMinor: 113 });
    const before = await snapshot();
    expect(await db.correctPayment(correction)).toMatchObject({ reason: "idempotency_conflict" });
    expect(await snapshot()).toEqual(before);
    await setRate("175.9876543");
    const retry = await correctPOST(new Request(`http://localhost/api/payments/${original.id}/correct`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ mode: "correct", reason, amount: "0.81", currency: "SAR", method: "cash", target: "original" }),
    }), { params: Promise.resolve({ id: String(original.id) }) });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      replayed: true, replacement: { id: made.replacement!.id }, reversal: { id: made.reversal!.id },
    });
    expect(await snapshot()).toEqual(before);
  });

  it("A20: new overprecision HTTP writes still use raw v1 pricing and audit the returned stored snapshot", async () => {
    const f = await fixture();
    const created = await createHttp(f);
    expect(created).toMatchObject({ amountMinor: 81, baseAmountMinor: 113, exchangeRate: storedRate });
    const stored = await storedRow(created.id);
    expect(stored.idempotency_request_hash).toBe(historicalV1Hash(f, rawRate));
    expect(stored.idempotency_request_hash).not.toBe(historicalV1Hash(f, storedRate));
    const { rows: audits } = await db.getPool().query(
      "SELECT details FROM audit_log WHERE action='payment.create' AND entity='payment' AND entity_id=$1",
      [String(created.id)],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].details).toMatchObject({ المبلغ: 81, سعر_الصرف: storedRate, المكافئ: 113 });
    await expectHttpReplay(f, created.id);
    expect(await storedRow(created.id)).toEqual(stored);
  });
});
