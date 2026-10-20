import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";

// Synthetic, isolated PostgreSQL only. Validate before normalizing environment.
const target = validatePostgresTestTarget(process.env);
stubPostgresEnv();
vi.mock("@/lib/session", () => ({ requireSession: vi.fn(async () => ({ username: "synthetic-admin", role: "admin" })) }));
const db = await import("../../lib/db");
const { PATCH } = await import("../../app/api/party-openings/route");
const AS_OF = "2026-08-31";
let serial = 0;
beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  await db.openShift({ openedBy: "synthetic-admin", opening: { YER: 1000000, SAR: 1000000, USD: 1000000 } });
});
afterAll(async () => { await db.resetPoolForTesting(); });
async function opening(currency: "YER" | "SAR" | "USD") {
  const { rows: [party] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO parties(name, kind) VALUES ($1, 'supplier') RETURNING id", [`Synthetic currency ${++serial}`]);
  const result = await db.createPartyOpeningPayable({ partyId: party.id, currency, amountMinor: 50000,
    exchangeRate: currency === "YER" ? 1 : currency === "SAR" ? 140 : 530,
    asOfDate: AS_OF, dueDate: null, reference: null, note: null,
    reason: "Synthetic fixture", actor: "synthetic-admin", actorRole: "admin" });
  if (!result.ok) throw new Error("Synthetic fixture failed");
  return result.value.id;
}
const adjust = (id: number, currency?: unknown, amount: unknown = "100") => PATCH(new Request("http://localhost/api/party-openings", {
  method: "PATCH", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "adjust", payableId: id, amount, reason: "Synthetic correction", ...(currency === undefined ? {} : { currency }) }),
}));
async function state(id: number) {
  const { rows: source } = await db.getPool().query("SELECT * FROM payables WHERE id=$1", [id]);
  const { rows } = await db.getPool().query("SELECT * FROM payable_adjustments WHERE payable_id=$1 ORDER BY id", [id]);
  const { rows: audit } = await db.getPool().query("SELECT * FROM audit_log WHERE action='party_opening.adjust' AND entity_id=$1 ORDER BY id", [String(id)]);
  const entry = (await db.journalEntries(AS_OF, AS_OF)).find(row => row.reference === `OP-${id}`);
  return { source, rows, audit, entry };
}
describe("HTTP opening adjustments bind units to the stored payable currency", () => {
  it.each(["YER", "SAR", "USD"] as const)("parses omitted body currency in stored %s units", async currency => {
    const id = await opening(currency);
    const before = await state(id);
    const amountMinor = currency === "YER" ? 100 : 10000;
    const response = await adjust(id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currency, amountMinor, originalAmountMinor: 50000 });
    const after = await state(id);
    expect(after.source).toEqual(before.source);
    expect(after.rows).toEqual([expect.objectContaining({ delta_minor: String(amountMinor - 50000), created_by: "synthetic-admin" })]);
    expect(after.audit).toEqual([expect.objectContaining({ actor: "synthetic-admin", action: "party_opening.adjust" })]);
    expect(after.entry?.lines).toEqual([
      { accountCode: "3101", currency, amountMinor, side: "debit" },
      { accountCode: "2101", currency, amountMinor, side: "credit" },
    ]);
  });
  it.each([["YER", "SAR"], ["YER", "USD"], ["SAR", "YER"], ["USD", "YER"], ["SAR", "USD"], ["USD", "SAR"]] as const)(
    "rejects stored %s with conflicting body %s without writes", async (stored, requested) => {
      const id = await opening(stored); const before = await state(id);
      expect.soft((await adjust(id, requested)).status).toBe(409);
      expect.soft(await state(id)).toEqual(before);
    });
  it.each(["invalid", null, "", 1, true])("rejects explicitly invalid currency %s without writes", async currency => {
    const id = await opening("SAR"); const before = await state(id);
    expect.soft((await adjust(id, currency)).status).toBe(400);
    expect.soft(await state(id)).toEqual(before);
  });
});

describe("currency-bound amount validation and preserved guards", () => {
  it.each(["YER", "SAR", "USD"] as const)("accepts matching %s and existing fractional rounding semantics", async currency => {
    const id = await opening(currency);
    const response = await adjust(id, currency, "100.5");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currency, amountMinor: currency === "YER" ? 101 : 10050 });
  });
  it.each(["YER", "SAR", "USD"] as const)("accepts zero %s when nothing is settled", async currency => {
    const id = await opening(currency);
    const response = await adjust(id, currency, "0");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currency, amountMinor: 0 });
    expect((await state(id)).entry).toBeUndefined();
  });
  for (const currency of ["YER", "SAR", "USD"] as const) {
    it.each(["-1", "9007199254740992", "not-money", "", null])(`rejects invalid/unsafe amount %s in ${currency} without writes`, async amount => {
      const id = await opening(currency); const before = await state(id);
      expect((await adjust(id, currency, amount)).status).toBe(400);
      expect(await state(id)).toEqual(before);
    });
  }
  it("rejects runtime input containing both raw and minor representations", async () => {
    const id = await opening("SAR"); const before = await state(id);
    const result = await db.adjustPartyOpeningPayable({ payableId: id, amount: "100", newAmountMinor: 100,
      reason: "Synthetic ambiguous request", actor: "synthetic-admin", actorRole: "admin" } as never);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await state(id)).toEqual(before);
  });
  it.each(["EUR", null, 1])("rejects invalid expected currency %s at the domain boundary", async expectedCurrency => {
    const id = await opening("SAR"); const before = await state(id);
    const result = await db.adjustPartyOpeningPayable({ payableId: id, amount: "100", expectedCurrency,
      reason: "Synthetic invalid currency", actor: "synthetic-admin", actorRole: "admin" } as never);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await state(id)).toEqual(before);
  });
  it.each(["YER", "SAR", "USD"] as const)("rejects a no-op %s correction without writes", async currency => {
    const id = await opening(currency); const before = await state(id);
    expect((await adjust(id, currency, currency === "YER" ? "50000" : "500")).status).toBe(400);
    expect(await state(id)).toEqual(before);
  });
  it.each([
    { currency: "YER", paidCurrency: "YER", paidMinor: 15000, settledMinor: 15000, below: "14999", exact: "15000" },
    { currency: "SAR", paidCurrency: "SAR", paidMinor: 15000, settledMinor: 15000, below: "149.99", exact: "150" },
    { currency: "USD", paidCurrency: "YER", paidMinor: 26500, settledMinor: 5000, below: "49.99", exact: "50" },
  ] as const)("preserves the settled floor in $currency after a $paidCurrency payment", async fixture => {
    const id = await opening(fixture.currency);
    const { rows: [payable] } = await db.getPool().query<{ party_id: number }>("SELECT party_id FROM payables WHERE id=$1", [id]);
    const rates = { YER: 1, SAR: 140, USD: 530 };
    const paid = await db.recordExpense({ category: "supplier", partyId: payable.party_id, payeeText: null,
      amountMinor: fixture.paidMinor, currency: fixture.paidCurrency, baseCurrency: "YER",
      exchangeRate: rates[fixture.paidCurrency], payableId: id, note: null,
      createdBy: "synthetic-admin", rates });
    expect(paid.reason).toBeNull();
    const before = await state(id);
    expect((await adjust(id, undefined, fixture.below)).status).toBe(400);
    expect(await state(id)).toEqual(before);
    const exact = await adjust(id, undefined, fixture.exact);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ currency: fixture.currency, amountMinor: fixture.settledMinor,
      settledMinor: fixture.settledMinor, remainingMinor: 0, originalAmountMinor: 50000 });
    expect((await state(id)).source).toEqual(before.source);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])("rejects invalid internal minor amount %s", async newAmountMinor => {
    const id = await opening("SAR"); const before = await state(id);
    const result = await db.adjustPartyOpeningPayable({ payableId: id, newAmountMinor,
      reason: "Synthetic invalid minor", actor: "synthetic-admin", actorRole: "admin" });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(await state(id)).toEqual(before);
  });
  it("preserves the period guard for raw HTTP amounts without source/audit changes", async () => {
    const id = await opening("SAR"); const before = await state(id);
    await db.saveSettings({ "finance.locked_before": "2026-09-01" });
    try {
      expect((await adjust(id, "SAR", "100")).status).toBe(409);
      expect(await state(id)).toEqual(before);
    } finally { await db.saveSettings({ "finance.locked_before": "" }); }
  });
  it("resolves the source before parsing the amount", async () => {
    expect((await adjust(2147483647, "SAR", "not-money")).status).toBe(404);
  });
  it("keeps the admin-only mutation gate", async () => {
    const { requireSession } = await import("../../lib/session");
    const id = await opening("SAR"); const before = await state(id);
    vi.mocked(requireSession).mockResolvedValueOnce({ username: "synthetic-cashier", role: "cashier" } as never);
    expect((await adjust(id, "SAR")).status).toBe(403);
    expect(await state(id)).toEqual(before);
  });
});
