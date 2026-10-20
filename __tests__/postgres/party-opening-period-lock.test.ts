import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";

// Synthetic, isolated PostgreSQL only. Validate before normalizing environment.
const target = validatePostgresTestTarget(process.env);
stubPostgresEnv();
const db = await import("../../lib/db");
const AS_OF = "2026-08-31";
const cases: Array<{ currency: "YER" | "SAR" | "USD"; payableId: number; advanceId: number }> = [];

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  for (const currency of ["YER", "SAR", "USD"] as const) {
    const { rows: [party] } = await db.getPool().query<{ id: number }>(
      "INSERT INTO parties(name, kind) VALUES ($1, 'supplier') RETURNING id", [`Synthetic period lock ${currency}`]);
    const common = { partyId: party.id, currency, amountMinor: 10000,
      exchangeRate: currency === "YER" ? 1 : currency === "SAR" ? 140 : 530,
      asOfDate: AS_OF, reference: `SYNTHETIC-LOCK-${currency}`, note: null,
      reason: "Synthetic fixture", actor: "synthetic-admin", actorRole: "admin" };
    const payable = await db.createPartyOpeningPayable({ ...common, dueDate: null });
    const advance = await db.createPartyOpeningAdvance(common);
    if (!payable.ok || !advance.ok) throw new Error("Synthetic fixture creation failed");
    cases.push({ currency, payableId: payable.value.id, advanceId: advance.value.id });
  }
  await db.saveSettings({ "finance.locked_before": "2026-09-01" });
  expect(await db.isPeriodLocked(AS_OF)).toBe(true);
});
afterAll(async () => { await db.resetPoolForTesting(); });

async function historicEntry(reference: string) {
  return (await db.journalEntries(AS_OF, AS_OF)).find(entry => entry.reference === reference);
}

describe("party opening mutations preserve the configured locked period", () => {
  for (const currency of ["YER", "SAR", "USD"] as const) {
    it(`rejects ${currency} opening adjustment without changing historical journal or audit`, async () => {
      const fixture = cases.find(row => row.currency === currency)!;
      const reference = `OP-${fixture.payableId}`;
      const before = await historicEntry(reference);
      expect(before).toBeDefined();
      const auditBefore = await auditCount();
      const result = await db.adjustPartyOpeningPayable({ payableId: fixture.payableId, newAmountMinor: 12000,
        reason: "Synthetic locked correction", actor: "synthetic-admin", actorRole: "admin" });
      expect.soft(result).toMatchObject({ ok: false, status: 409 });
      expect.soft(await historicEntry(reference)).toEqual(before);
      const { rows: [row] } = await db.getPool().query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM payable_adjustments WHERE payable_id=$1", [fixture.payableId]);
      expect.soft(row.count).toBe("0");
      expect.soft(await auditCount()).toBe(auditBefore);
    });
    it(`rejects ${currency} opening advance void without removing historical journal`, async () => {
      const fixture = cases.find(row => row.currency === currency)!;
      const before = (await db.journalEntries(AS_OF, AS_OF)).filter(entry => entry.source === "opening_advance");
      expect(before.some(entry => entry.lines.some(line => line.currency === currency))).toBe(true);
      const auditBefore = await auditCount();
      const result = await db.voidPartyOpeningAdvance({ id: fixture.advanceId,
        reason: "Synthetic locked void", actor: "synthetic-admin", actorRole: "admin" });
      expect.soft(result).toMatchObject({ ok: false, status: 409 });
      expect.soft((await db.journalEntries(AS_OF, AS_OF)).filter(entry => entry.source === "opening_advance")).toEqual(before);
      const { rows: [row] } = await db.getPool().query<{ voided_at: Date | null }>(
        "SELECT voided_at FROM party_opening_advances WHERE id=$1", [fixture.advanceId]);
      expect.soft(row.voided_at).toBeNull();
      expect.soft(await auditCount()).toBe(auditBefore);
    });
  }
});

async function auditCount() {
  const { rows: [row] } = await db.getPool().query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM audit_log WHERE action IN ('party_opening.adjust', 'party_advance.void')");
  return row.count;
}

async function makePair(asOfDate: string) {
  const { rows: [party] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO parties(name, kind) VALUES ('Synthetic acceptance control', 'supplier') RETURNING id");
  const common = { partyId: party.id, currency: "SAR" as const, amountMinor: 10000, exchangeRate: 140,
    asOfDate, reference: null, note: null, reason: "Synthetic control", actor: "synthetic-admin", actorRole: "admin" };
  const payable = await db.createPartyOpeningPayable({ ...common, dueDate: null });
  const advance = await db.createPartyOpeningAdvance(common);
  if (!payable.ok || !advance.ok) throw new Error("Synthetic control creation failed");
  return { payableId: payable.value.id, advanceId: advance.value.id };
}

async function mutatePair(pair: { payableId: number; advanceId: number }) {
  const common = { reason: "Synthetic correction", actor: "synthetic-admin", actorRole: "admin" };
  return [
    await db.adjustPartyOpeningPayable({ ...common, payableId: pair.payableId, newAmountMinor: 12000 }),
    await db.voidPartyOpeningAdvance({ ...common, id: pair.advanceId }),
  ];
}

describe("period lock boundaries and uncached domain reads", () => {
  it.each(["2026-09-01", "2026-09-02"])("allows both mutations on unlocked source date %s", async (date) => {
    await db.saveSettings({ "finance.locked_before": "2026-09-01" });
    const results = await mutatePair(await makePair(date));
    expect(results.map(result => result.ok)).toEqual([true, true]);
  });
  it("allows both mutations when there is no period cutoff", async () => {
    await db.saveSettings({ "finance.locked_before": "" });
    expect((await mutatePair(await makePair(AS_OF))).map(result => result.ok)).toEqual([true, true]);
  });
  it("rejects both mutations when process cache predates the stored period close", async () => {
    await db.saveSettings({ "finance.locked_before": "" });
    const pair = await makePair(AS_OF);
    expect((await db.getSettings())["finance.locked_before"]).toBe("");
    await db.getPool().query("UPDATE settings SET value='2026-09-01' WHERE key='finance.locked_before'");
    // A separate app instance can close the period without invalidating this cache.
    expect((await db.getSettings())["finance.locked_before"]).toBe("");
    const auditBefore = await auditCount();
    const entriesBefore = await db.journalEntries(AS_OF, AS_OF);
    expect(await mutatePair(pair)).toEqual([
      expect.objectContaining({ ok: false, status: 409 }), expect.objectContaining({ ok: false, status: 409 }),
    ]);
    expect(await auditCount()).toBe(auditBefore);
    expect(await db.journalEntries(AS_OF, AS_OF)).toEqual(entriesBefore);
  });
});
