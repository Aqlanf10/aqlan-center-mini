import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { parseLegacyTreatmentRequest } from "../../lib/legacy-treatment";
import type { LegacyVoidMode } from "../../lib/legacy-treatment-void";
import type { Currency } from "../../lib/money";
import { openPeriodontalFixture } from "./_periodontal-fixture";

/** SOURCE ONLY. Real-writer tests for a separately authorized, pristine, owned PostgreSQL fixture.
 * No Production target, schema reset, guessed receipt allocation or proposal-schema activation.
 */
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
let db: typeof import("../../lib/db");
let legacy: typeof import("../../lib/legacy-treatment-db");
let service = 0, sequence = 0;
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows as T[];
const patient = async () => (await q<{ id: number }>("INSERT INTO patients (patient_number,full_name) VALUES ($1,'Synthetic two-level void') RETURNING id", [`SYN-VOID-${++sequence}`]))[0].id;
const actor = { actor: "synthetic-admin", actorRole: "admin" };
async function register(patientId: number, toothCode = 16, previouslyPaidAmount = "0", currency: Currency = "YER") {
  const parsed = parseLegacyTreatmentRequest({ serviceId: service, toothCode, currency, agreedAmount: "100000",
    previouslyPaidAmount, historicalAsOf: "2020-01-01" }, "2026-10-07");
  if (!parsed.ok) throw new Error(parsed.message);
  const result = await legacy.createLegacyTreatment({ patientId, request: parsed.value, ...actor,
    canEditOpening: true, templates: DEFAULT_SPECIALTY_TEMPLATES });
  if (!result.ok) throw new Error(result.reason);
  return result.agreement;
}
async function preview(patientId: number, agreementId: number, mode: LegacyVoidMode = "manager_authorized", username = actor.actor) {
  const result = await legacy.getLegacyVoidPreview({ patientId, agreementId, mode, ...actor, actor: username });
  if (!result.ok) throw new Error(result.reason);
  return result.preview;
}
const ordinary = (patientId: number, agreementId: number) => legacy.voidLegacyTreatment({ patientId, agreementId,
  reason: "Synthetic historical correction", ...actor });
async function manager(patientId: number, agreementId: number) {
  const reviewed = await preview(patientId, agreementId);
  return legacy.voidLegacyTreatment({ patientId, agreementId, reason: "Synthetic explicit manager correction",
    ...actor, mode: "manager_authorized", previewToken: reviewed.previewToken });
}
async function collect(patientId: number, amountMinor: number, currency: Currency = "YER", openingCurrency: Currency = "YER",
  exchangeRate = currency === "SAR" ? 150 : currency === "USD" ? 530 : 1) {
  const result = await db.recordPayment({ patientId, invoiceId: null, openingCurrency, kind: "payment", amountMinor,
    currency, baseCurrency: "YER", exchangeRate, method: "cash", note: null, createdBy: actor.actor });
  if (result.reason !== null || !result.payment) throw new Error(result.reason ?? "Missing synthetic receipt");
  return result.payment;
}
async function refund(payment: Awaited<ReturnType<typeof collect>>, amountMinor = payment.amountMinor) {
  const result = await db.recordPayment({ patientId: payment.patientId, invoiceId: null, kind: "refund", amountMinor,
    currency: payment.currency, baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null,
    createdBy: actor.actor, reversalOfId: payment.id });
  if (result.reason !== null) throw new Error(result.reason);
}
async function state(patientId: number) {
  return {
    agreements: await q("SELECT * FROM legacy_treatment_agreements WHERE patient_id=$1 ORDER BY id", [patientId]),
    items: await q("SELECT i.* FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1 ORDER BY i.id", [patientId]),
    openings: await q("SELECT * FROM patient_opening_balances WHERE patient_id=$1 ORDER BY currency", [patientId]),
    history: await q("SELECT * FROM patient_opening_balance_history WHERE patient_id=$1 ORDER BY id", [patientId]),
    receipts: await q("SELECT * FROM payments WHERE patient_id=$1 ORDER BY id", [patientId]),
    invoices: await q("SELECT * FROM invoices WHERE patient_id=$1 ORDER BY id", [patientId]),
    audit: await q("SELECT * FROM audit_log WHERE entity='patient' AND entity_id=$1::text ORDER BY id", [patientId]),
  };
}
beforeAll(async () => {
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  db = fixture.db;
  await db.ensureSchema();
  legacy = await import("../../lib/legacy-treatment-db");
  service = (await q<{ id: number }>("INSERT INTO services (name,category,price_minor,price_configured) VALUES ('Synthetic crown','crown',100000,TRUE) RETURNING id"))[0].id;
  await db.openShift({ openedBy: actor.actor, opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

describe("ordinary and explicit manager void share immutable financial lineage", () => {
  it("ordinary refuses any collection and manager permits exact cover with unchanged receipts and durable audit/history", async () => {
    const id = await patient(), first = await register(id), second = await register(id, 26);
    await collect(id, 100000);
    const before = await state(id);
    expect(await ordinary(id, first.id)).toEqual({ ok: false, reason: "opening_collected" });
    expect(await state(id)).toEqual(before);
    expect(await preview(id, first.id)).toMatchObject({ canVoid: true, openingPrincipalBeforeMinor: 200000,
      openingPrincipalAfterMinor: 100000, netCollectionsMinor: 100000, remainingDueAfterMinor: 0 });
    expect((await manager(id, first.id)).ok).toBe(true);
    const after = await state(id);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.history).toHaveLength(before.history.length + 1);
    expect(await q("SELECT status FROM legacy_treatment_agreements WHERE id=$1", [second.id])).toEqual([{ status: "live" }]);
    expect(await q(`SELECT i.billing_status, ${db.PLAN_ITEM_FINANCIAL_REVIEW_SQL} AS review
      FROM plan_items i JOIN treatment_plans t ON t.id=i.plan_id WHERE i.id=$1`, [first.planItemId]))
      .toEqual([{ billing_status: "needs_financial_review", review: true }]);
    const [audit] = await q<{ details: { void_mode: string; financial_impact: { netCollectionsMinor: number } } }>(
      "SELECT details FROM audit_log WHERE action='legacy_treatment.void' AND entity_id=$1::text", [id]);
    expect(audit.details).toMatchObject({ void_mode: "manager_authorized", financial_impact: { netCollectionsMinor: 100000 } });
    expect(await ordinary(id, first.id)).toEqual({ ok: false, reason: "already_void" });
  });
  it("manager cannot remove more principal than current collections leave covered", async () => {
    const id = await patient(), agreement = await register(id);
    await collect(id, 1);
    const before = await state(id);
    expect(await manager(id, agreement.id)).toEqual({ ok: false, reason: "opening_settled" });
    expect(await state(id)).toEqual(before);
  });
  it("fully historically paid agreements still reject ordinary void when another agreement's opening was collected", async () => {
    const id = await patient();
    await register(id);
    const fullyPaid = await register(id, 26, "100000");
    await collect(id, 1000);
    const before = await state(id);
    expect(await ordinary(id, fullyPaid.id)).toEqual({ ok: false, reason: "opening_collected" });
    expect(await state(id)).toEqual(before);
    expect(await preview(id, fullyPaid.id)).toMatchObject({ removedPrincipalMinor: 0, openingPrincipalAfterMinor: 100000, canVoid: true });
    expect((await manager(id, fullyPaid.id)).ok).toBe(true);
    const after = await state(id);
    expect(after.openings).toEqual(before.openings);
    expect(after.history).toEqual(before.history); // No fictional opening edit for a zero-effect agreement.
    expect(after.receipts).toEqual(before.receipts);
    expect(after.audit.length).toBeGreaterThan(before.audit.length);
  });
  it("missing opening rows cannot hide existing same-currency collections", async () => {
    const id = await patient(), agreement = await register(id, 16, "100000");
    await db.setPatientOpeningBalance({ patientId: id, currency: "YER", amountMinor: 100000,
      asOfDate: "2020-01-01", note: null, createdBy: actor.actor });
    await collect(id, 1000);
    await db.clearPatientOpeningBalance(id, actor.actor, "Synthetic missing-opening historical fixture", "YER");
    const before = await state(id);
    expect(await ordinary(id, agreement.id)).toEqual({ ok: false, reason: "opening_collected" });
    expect(await manager(id, agreement.id)).toEqual({ ok: false, reason: "opening_settled" });
    expect(await state(id)).toEqual(before);
  });
  it("unrelated opening currency does not block ordinary void", async () => {
    const id = await patient(), agreement = await register(id);
    await db.setPatientOpeningBalance({ patientId: id, currency: "SAR", amountMinor: 10000,
      asOfDate: "2020-01-01", note: null, createdBy: actor.actor });
    await collect(id, 100, "SAR", "SAR");
    expect((await ordinary(id, agreement.id)).ok).toBe(true);
    expect(await q("SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1 AND currency='SAR'", [id]))
      .toEqual([{ amount_minor: "10000" }]);
  });
  it("YER opening collections use the receipt's historical base amount; a full refund restores ordinary eligibility", async () => {
    const id = await patient(), agreement = await register(id);
    const payment = await collect(id, 100, "SAR", "YER");
    const [receipt] = await q<{ base_amount_minor: string }>("SELECT base_amount_minor::text FROM payments WHERE id=$1", [payment.id]);
    expect((await preview(id, agreement.id, "ordinary")).netCollectionsMinor).toBe(Number(receipt.base_amount_minor));
    expect(await ordinary(id, agreement.id)).toEqual({ ok: false, reason: "opening_collected" });
    await refund(payment);
    expect((await preview(id, agreement.id, "ordinary")).netCollectionsMinor).toBe(0);
    expect((await ordinary(id, agreement.id)).ok).toBe(true);
  });
  it("adds native YER and stored SAR/USD equivalents at each receipt's own rate and refund rounding", async () => {
    const id = await patient(), agreement = await register(id);
    await register(id, 26);
    await collect(id, 500);
    const sar = await collect(id, 101, "SAR", "YER", 150);
    await collect(id, 203, "SAR", "YER", 160);
    const usd = await collect(id, 105, "USD", "YER", 530);
    await refund(sar, 50);
    await refund(usd, 5);
    // 500 + round(1.01*150) + round(2.03*160) + round(1.05*530)
    //     - round(0.50*150) - round(0.05*530): no aggregate conversion or current rate.
    expect(await q("SELECT base_amount_minor::text FROM payments WHERE patient_id=$1 ORDER BY id", [id]))
      .toEqual(["500", "152", "325", "557", "75", "27"].map((base_amount_minor) => ({ base_amount_minor })));
    const before = await state(id);
    const reviewed = await preview(id, agreement.id);
    expect(reviewed).toMatchObject({ canVoid: true, netCollectionsMinor: 1432, openingPrincipalAfterMinor: 100000 });
    expect((await preview(id, agreement.id)).previewToken).toBe(reviewed.previewToken);
    expect(await ordinary(id, agreement.id)).toEqual({ ok: false, reason: "opening_collected" });
    expect((await manager(id, agreement.id)).ok).toBe(true);
    const after = await state(id);
    expect(after.receipts).toEqual(before.receipts);
    expect(after.invoices).toEqual(before.invoices);
  });
  it("preserves a negative foreign-base bucket caused by legitimate split-refund rounding", async () => {
    const id = await patient(), agreement = await register(id);
    await register(id, 26);
    await collect(id, 500);
    const payment = await collect(id, 2, "SAR", "YER", 150);
    await refund(payment, 1);
    await refund(payment, 1);
    // The original 0.02 SAR is 3 YER; each independently rounded 0.01 SAR refund is 2 YER.
    // Preserve the -1 YER SAR bucket: 500 + 3 - 2 - 2 = 499, without clamping or rebalancing.
    expect(await q("SELECT base_amount_minor::text FROM payments WHERE patient_id=$1 ORDER BY id", [id]))
      .toEqual(["500", "3", "2", "2"].map((base_amount_minor) => ({ base_amount_minor })));
    const before = await state(id);
    expect(await preview(id, agreement.id)).toMatchObject({ canVoid: true, netCollectionsMinor: 499 });
    expect(await ordinary(id, agreement.id)).toEqual({ ok: false, reason: "opening_collected" });
    expect((await manager(id, agreement.id)).ok).toBe(true);
    expect((await state(id)).receipts).toEqual(before.receipts);
  });
  it.each(["SAR", "USD"] as const)("keeps %s openings in native minor units through partial and full refunds", async (currency) => {
    const id = await patient(), agreement = await register(id, 16, "0", currency);
    const payment = await collect(id, 12345, currency, currency);
    await refund(payment, 345);
    expect(await preview(id, agreement.id, "ordinary")).toMatchObject({ currency, netCollectionsMinor: 12000,
      canVoid: false, refusal: "opening_collected" });
    expect(await manager(id, agreement.id)).toEqual({ ok: false, reason: "opening_settled" });
    await refund(payment, 12000);
    expect((await preview(id, agreement.id, "ordinary")).netCollectionsMinor).toBe(0);
    expect((await ordinary(id, agreement.id)).ok).toBe(true);
  });
});

// Persisted-corruption fixtures stay inside the isolated synthetic database. No guard is disabled,
// no historical receipt is edited, and production has no path that creates these unsupported rows.
async function historicalReceipt(patientId: number, openingCurrency: Currency, input: {
  currency: string; amountMinor: string; baseAmountMinor: string; baseCurrency?: string; kind?: string;
}) {
  await q(`INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency,
      exchange_rate, base_amount_minor, base_currency, opening_currency, method, created_by)
    SELECT $1, $2, id, $3, $4::bigint, $5, 1, $6::bigint, $7, $8, 'cash', $9
      FROM cashier_shifts WHERE status='open'`, [`SYN-CORRUPT-${++sequence}`, patientId,
    input.kind ?? "payment", input.amountMinor, input.currency, input.baseAmountMinor,
    input.baseCurrency ?? "YER", openingCurrency, actor.actor]);
}

describe("collection evidence fails closed before any void mutation", () => {
  it.each([
    { opening: "YER", currency: "USD", amountMinor: "100", baseAmountMinor: "530", baseCurrency: "SAR" },
    { opening: "YER", currency: "SAR", amountMinor: "100", baseAmountMinor: "-150" },
    { opening: "YER", currency: "USD", amountMinor: "100", baseAmountMinor: "9007199254740992" },
    { opening: "SAR", currency: "USD", amountMinor: "100", baseAmountMinor: "530" },
    { opening: "USD", currency: "SAR", amountMinor: "100", baseAmountMinor: "150" },
    { opening: "SAR", currency: "YER", amountMinor: "100", baseAmountMinor: "100" },
  ] as const)("refuses unsupported stored currency/base evidence %j", async ({ opening, ...receipt }) => {
    const id = await patient(), agreement = await register(id, 16, "0", opening);
    await historicalReceipt(id, opening, receipt);
    const before = await state(id);
    for (const mode of ["ordinary", "manager_authorized"] as const) {
      expect(await preview(id, agreement.id, mode)).toMatchObject({ canVoid: false, refusal: "opening_changed" });
    }
    expect(await ordinary(id, agreement.id)).toEqual({ ok: false, reason: "opening_changed" });
    expect(await manager(id, agreement.id)).toEqual({ ok: false, reason: "opening_changed" });
    expect(await state(id)).toEqual(before);
  });

  it.each([
    { currency: "EUR", amountMinor: "100", baseAmountMinor: "600", constraint: "payments_currency_known" },
    { currency: "YER", amountMinor: "100", baseAmountMinor: "100", kind: "adjustment", constraint: "payments_kind_known" },
  ])("existing checks reject impossible new corruption fixtures: %j", async ({ constraint, ...receipt }) => {
    const id = await patient();
    await register(id);
    const before = await state(id);
    await expect(historicalReceipt(id, "YER", receipt)).rejects.toMatchObject({ code: "23514", constraint });
    expect(await state(id)).toEqual(before);
  });

  it.each([
    [
      { currency: "YER", amountMinor: "4503599627370500", baseAmountMinor: "4503599627370500" },
      { currency: "YER", amountMinor: "4503599627370500", baseAmountMinor: "4503599627370500" },
    ],
    [
      { currency: "YER", amountMinor: "9007199254740900", baseAmountMinor: "9007199254740900" },
      { currency: "SAR", amountMinor: "100", baseAmountMinor: "100" },
    ],
    [
      { currency: "YER", amountMinor: "9007199254740992", baseAmountMinor: "9007199254740992" },
      { currency: "YER", amountMinor: "9007199254740992", baseAmountMinor: "9007199254740992", kind: "refund" },
    ],
  ])("refuses unsafe group totals, cross-group totals or cancelling unsafe receipts: %j", async (first, second) => {
    const id = await patient(), agreement = await register(id);
    await historicalReceipt(id, "YER", first);
    await historicalReceipt(id, "YER", second);
    const before = await state(id);
    expect(await preview(id, agreement.id)).toMatchObject({ canVoid: false, refusal: "opening_changed" });
    expect(await ordinary(id, agreement.id)).toEqual({ ok: false, reason: "opening_changed" });
    expect(await manager(id, agreement.id)).toEqual({ ok: false, reason: "opening_changed" });
    expect(await state(id)).toEqual(before);
  });
});

describe("explicit authority and optimistic snapshot checks", () => {
  it.each([null, "reception", "doctor", "cashier", "accountant", "assistant", "manager"])("writer and preview deny role %s", async (actorRole) => {
    const id = await patient(), agreement = await register(id);
    const before = await state(id);
    expect(await legacy.getLegacyVoidPreview({ patientId: id, agreementId: agreement.id, actor: "synthetic-user", actorRole }))
      .toEqual({ ok: false, reason: "void_forbidden" });
    expect(await legacy.voidLegacyTreatment({ patientId: id, agreementId: agreement.id, actor: "synthetic-user", actorRole,
      reason: "Synthetic correction", mode: "manager_authorized", previewToken: "a".repeat(64) }))
      .toEqual({ ok: false, reason: "void_forbidden" });
    expect(await state(id)).toEqual(before);
  });
  it("manager mode never silently upgrades an ordinary request or accepts another actor's preview", async () => {
    const id = await patient(), agreement = await register(id);
    const before = await state(id);
    const otherActor = await preview(id, agreement.id, "manager_authorized", "different-admin");
    const ordinaryPreview = await preview(id, agreement.id, "ordinary");
    const input = { patientId: id, agreementId: agreement.id, ...actor, reason: "Synthetic correction", mode: "manager_authorized" as const };
    expect(await legacy.voidLegacyTreatment(input)).toEqual({ ok: false, reason: "preview_required" });
    for (const previewToken of [otherActor.previewToken, ordinaryPreview.previewToken]) {
      expect(await legacy.voidLegacyTreatment({ ...input, previewToken })).toEqual({ ok: false, reason: "preview_stale" });
    }
    expect(await state(id)).toEqual(before);
  });
  it("a refund followed by a new equal payment invalidates a preview even when the net amount is unchanged", async () => {
    const id = await patient(), agreement = await register(id);
    await register(id, 26);
    const payment = await collect(id, 1000);
    const reviewed = await preview(id, agreement.id);
    await refund(payment);
    await collect(id, 1000);
    const before = await state(id);
    expect((await preview(id, agreement.id)).netCollectionsMinor).toBe(reviewed.netCollectionsMinor);
    expect(await legacy.voidLegacyTreatment({ patientId: id, agreementId: agreement.id, ...actor, reason: "Synthetic correction",
      mode: "manager_authorized", previewToken: reviewed.previewToken })).toEqual({ ok: false, reason: "preview_stale" });
    expect(await state(id)).toEqual(before);
  });
  it("recomputes collections after the patient-lock wait and rejects a now-stale manager preview", async () => {
    const id = await patient(), agreement = await register(id);
    await register(id, 26);
    const reviewed = await preview(id, agreement.id);
    const blocker = await db.getPool().connect();
    let pending: ReturnType<typeof legacy.voidLegacyTreatment> | undefined;
    try {
      await blocker.query("BEGIN");
      const { rows: [{ pid }] } = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      await blocker.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [id]);
      pending = legacy.voidLegacyTreatment({ patientId: id, agreementId: agreement.id, ...actor,
        mode: "manager_authorized", reason: "Synthetic stale-preview concurrency", previewToken: reviewed.previewToken });
      void pending.catch(() => undefined);
      let waiter: { query: string } | undefined;
      const deadline = Date.now() + 5000;
      while (!waiter && Date.now() < deadline) {
        [waiter] = await q<{ query: string }>(`SELECT query FROM pg_stat_activity
          WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))`, [pid]);
        if (!waiter) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiter?.query).toMatch(/FROM patients[\s\S]*FOR NO KEY UPDATE/);
      // Opening receipts can commit while the writer is waiting at the patient fence.
      await collect(id, 1000);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
      if (pending) expect(await pending).toEqual({ ok: false, reason: "preview_stale" });
    }
    expect(await q("SELECT status FROM legacy_treatment_agreements WHERE id=$1", [agreement.id])).toEqual([{ status: "live" }]);
    expect(await q("SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id=$1 AND currency='YER'", [id]))
      .toEqual([{ amount_minor: "200000" }]);
  }, 15000);
  it("preview and writer fail closed when the item's current plan belongs to another patient", async () => {
    const id = await patient(), agreement = await register(id), otherId = await patient(), other = await register(otherId);
    // Persisted drift fixture only: no repair or automatic reassignment is attempted by either operation.
    await q("UPDATE plan_items SET plan_id=$2 WHERE id=$1", [agreement.planItemId, other.planId]);
    const before = await state(id), otherBefore = await state(otherId);
    expect(await legacy.getLegacyVoidPreview({ patientId: id, agreementId: agreement.id, ...actor })).toEqual({ ok: false, reason: "opening_changed" });
    expect(await ordinary(id, agreement.id)).toEqual({ ok: false, reason: "opening_changed" });
    expect(await state(id)).toEqual(before);
    expect(await state(otherId)).toEqual(otherBefore);
  });
});
