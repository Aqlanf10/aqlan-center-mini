import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";

// Check the original environment before normalizing it. Only synthetic fixtures
// on an explicitly isolated PostgreSQL test target may reset the schema.
const target = validatePostgresTestTarget(process.env);
stubPostgresEnv();
const auth = vi.hoisted(() => ({ session: { username: "synthetic-admin", role: "admin" } as
  { username: string; role: string } | null }));
vi.mock("@/lib/session", () => ({ requireSession: async () => auth.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => false }));
const db = await import("../../lib/db");
const { POST } = await import("../../app/api/inventory/[id]/movements/route");
type MovementInput = Parameters<typeof db.createInventoryMovement>[0];
let serial = 0;
beforeAll(async () => { await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema(); });
beforeEach(() => { auth.session = { username: "synthetic-admin", role: "admin" }; });
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture() {
  const name = `Synthetic purchase ${++serial}`;
  const { rows: [item] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO inventory_items(name,created_by) VALUES ($1,'synthetic') RETURNING id", [name]);
  const { rows: [party] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO parties(name,kind) VALUES ($1,'supplier') RETURNING id", [name]);
  return { itemId: item.id, supplierPartyId: party.id, kind: "in" as const,
    qty: 1, unitCostMinor: 10000, createdBy: `synthetic-purchase-${serial}` };
}
async function state(f: Awaited<ReturnType<typeof fixture>>) {
  const { rows: movements } = await db.getPool().query(
    "SELECT * FROM inventory_movements WHERE item_id=$1 ORDER BY id", [f.itemId]);
  const { rows: payables } = await db.getPool().query(
    "SELECT * FROM payables WHERE party_id=$1 ORDER BY id", [f.supplierPartyId]);
  const { rows: audit } = await db.getPool().query(
    "SELECT * FROM audit_log WHERE action='inventory.move' AND actor=$1 ORDER BY id", [f.createdBy]);
  return { movements, payables, audit };
}
function request(f: Awaited<ReturnType<typeof fixture>>, changes: Record<string, unknown> = {}) {
  return POST(new Request("http://localhost/api/inventory/movements", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "in", qty: 1, unitCost: "10000", supplierPartyId: f.supplierPartyId, ...changes }),
  }), { params: Promise.resolve({ id: String(f.itemId) }) });
}
async function failingAudit(run: () => Promise<void>) {
  await db.getPool().query(`CREATE FUNCTION synthetic_fail_inventory_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='inventory.move' THEN RAISE EXCEPTION 'synthetic inventory audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER synthetic_fail_inventory_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_fail_inventory_audit()`);
  try { await run(); }
  finally { await db.getPool().query("DROP TRIGGER synthetic_fail_inventory_audit ON audit_log; DROP FUNCTION synthetic_fail_inventory_audit()"); }
}

describe("legacy purchase atomicity", () => {
  it("commits stock, its YER supplier payable and one linked audit before returning success", async () => {
    const f = await fixture();
    const result = await db.createInventoryMovement({ ...f, qty: 1.235, supplierDueDate: "2026-12-31" });
    expect(result).toMatchObject({ ok: true, balance: 1.235, movement: { qty: 1.235, partyId: f.supplierPartyId } });
    if (!result.ok) throw new Error("fixture purchase failed");
    const saved = await state(f);
    expect(saved.movements).toHaveLength(1);
    expect(saved.payables).toEqual([expect.objectContaining({ id: result.movement.payableId,
      amount_minor: "12350", base_amount_minor: "12350", currency: "YER", base_currency: "YER", exchange_rate: "1.000000" })]);
    expect(saved.audit).toEqual([expect.objectContaining({ entity_id: String(result.movement.id), actor: f.createdBy,
      details: expect.objectContaining({ الكمية: 1.235, الرصيد_قبل: 0, الرصيد_بعد: 1.235, التزام_المورّد: result.movement.payableId }) })]);
  });
  it("rolls back stock and payable when audit insertion fails, then permits a clean retry", async () => {
    const f = await fixture(); const before = await state(f);
    await failingAudit(async () => {
      await expect(db.createInventoryMovement(f)).rejects.toThrow("synthetic inventory audit failure");
      expect(await state(f)).toEqual(before);
    });
    expect((await db.createInventoryMovement(f)).ok).toBe(true);
    const saved = await state(f);
    expect(saved.movements).toHaveLength(1); expect(saved.payables).toHaveLength(1); expect(saved.audit).toHaveLength(1);
  });
  it("returns HTTP failure without committed purchase rows on audit failure", async () => {
    const f = await fixture(); const before = await state(f);
    await failingAudit(async () => {
      expect((await request(f)).status).toBe(500);
      expect(await state(f)).toEqual(before);
    });
    expect((await request(f)).status).toBe(201);
  });
  it.each([
    { kind: "out", qty: 0.125 }, { kind: "adjust", qty: -0.125, reason: "Synthetic loss" },
    { kind: "adjust", qty: 0.125, reason: "Synthetic surplus" }, { kind: "in", qty: 0.125, isReturn: true },
  ] as const)("keeps $kind movements atomic as well", async extra => {
    const f = await fixture(); await db.createInventoryMovement(f); const before = await state(f);
    await failingAudit(async () => {
      await expect(db.createInventoryMovement({ ...f, ...extra, supplierPartyId: null })).rejects.toThrow("synthetic inventory audit failure");
      expect(await state(f)).toEqual(before);
    });
  });
  it("rolls back the already inserted supplier payable if stock insertion fails", async () => {
    const f = await fixture(); const before = await state(f);
    await expect(db.createInventoryMovement({ ...f, visitId: 2147483647 })).rejects.toThrow();
    expect(await state(f)).toEqual(before);
  });
});

describe("exact supported quantity and money boundaries", () => {
  it.each([1.2345, 0.0001, 999999999.9999, 1000000000, NaN, Infinity])("rejects quantity %s with no writes", async qty => {
    const f = await fixture(); const before = await state(f);
    expect((await db.createInventoryMovement({ ...f, qty })).ok).toBe(false);
    expect(await state(f)).toEqual(before);
  });
  it.each([0.001, 0.145, 1.001, 1.235, 999999999.999])("stores supported quantity %s unchanged", async qty => {
    const f = await fixture();
    const result = await db.createInventoryMovement({ ...f, qty, unitCostMinor: 100 });
    expect(result).toMatchObject({ ok: true, movement: { qty }, balance: qty });
    const saved = await state(f); expect(Number(saved.movements[0].qty)).toBe(qty);
  });
  it.each([
    { qty: 0.145, price: 100, total: "15" }, // JS float multiplication incorrectly rounds 14.499999999999998 down.
    { qty: 0.004, price: 100, total: "0" }, // Preserve established final-total rounding, including zero.
    { qty: 0.005, price: 100, total: "1" },
    { qty: 0.006, price: 100, total: "1" },
    { qty: 1, price: Number.MAX_SAFE_INTEGER, total: String(Number.MAX_SAFE_INTEGER) },
    { qty: 0.001, price: Number.MAX_SAFE_INTEGER, total: "9007199254741" },
  ])("values $qty × $price by exact half-up minor rounding", async ({ qty, price, total }) => {
    const f = await fixture(); expect((await db.createInventoryMovement({ ...f, qty, unitCostMinor: price })).ok).toBe(true);
    const saved = await state(f); expect(saved.payables[0].amount_minor).toBe(total); expect(saved.payables[0].base_amount_minor).toBe(total);
  });
  for (const linked of [true, false]) {
    it.each([0.5, 100.25, Number.MAX_SAFE_INTEGER + 1])(`rejects unsafe or fractional price %s, supplier=${linked}`, async unitCostMinor => {
      const f = await fixture(); const before = await state(f);
      expect((await db.createInventoryMovement({ ...f, unitCostMinor, supplierPartyId: linked ? f.supplierPartyId : null })).ok).toBe(false);
      expect(await state(f)).toEqual(before);
    });
    it(`rejects an unsafe extended value with supplier=${linked}`, async () => {
      const f = await fixture(); const before = await state(f);
      expect((await db.createInventoryMovement({ ...f, qty: 1.001, unitCostMinor: Number.MAX_SAFE_INTEGER,
        supplierPartyId: linked ? f.supplierPartyId : null })).ok).toBe(false);
      expect(await state(f)).toEqual(before);
    });
  }
  it.each(["1.2345", "0.0001"])("rejects HTTP quantity %s without writes", async qty => {
    const f = await fixture(); const before = await state(f);
    expect((await request(f, { qty })).status).toBe(409); expect(await state(f)).toEqual(before);
  });
  it("preserves HTTP YER amount parsing and rounding before safe minor-unit validation", async () => {
    const f = await fixture(); expect((await request(f, { qty: 2, unitCost: "100.5" })).status).toBe(201);
    expect((await state(f)).payables[0].amount_minor).toBe("202");
  });
});

describe("existing purchase, return and authorization contracts", () => {
  it.each([null, undefined, -5, NaN, Infinity])("preserves unpriced legacy receipt for ignored price %s", async unitCostMinor => {
    const f = await fixture();
    expect(await db.createInventoryMovement({ ...f, unitCostMinor, supplierPartyId: null })).toMatchObject({ ok: true, movement: { unitCostMinor: null } });
    const saved = await state(f); expect(saved.payables).toHaveLength(0); expect(saved.audit).toHaveLength(1);
  });
  it("preserves explicit zero-cost unlinked purchases but not supplier billing without positive unit cost", async () => {
    const f = await fixture();
    expect(await db.createInventoryMovement({ ...f, unitCostMinor: 0, supplierPartyId: null })).toMatchObject({ ok: true, movement: { unitCostMinor: 0 } });
    const before = await state(f);
    expect((await db.createInventoryMovement({ ...f, unitCostMinor: 0 })).ok).toBe(false);
    expect(await state(f)).toEqual(before);
  });
  it.each([
    { kind: "out", qty: 0.125 }, { kind: "adjust", qty: -0.125, reason: "Synthetic loss" },
    { kind: "adjust", qty: 0.125, reason: "Synthetic surplus" }, { kind: "in", qty: 0.125, isReturn: true },
  ] as const)("preserves ignored price and no extra payable for $kind", async extra => {
    const f = await fixture(); await db.createInventoryMovement(f);
    expect(await db.createInventoryMovement({ ...f, ...extra, supplierPartyId: null, unitCostMinor: Number.MAX_SAFE_INTEGER + 1 }))
      .toMatchObject({ ok: true, movement: { unitCostMinor: null } });
    const saved = await state(f); expect(saved.payables).toHaveLength(1); expect(saved.movements).toHaveLength(2); expect(saved.audit).toHaveLength(2);
  });
  it.each([
    { qty: 0 }, { qty: -1 }, { kind: "out", qty: -1 }, { kind: "out", qty: 2 },
    { kind: "adjust", qty: 0, reason: "Synthetic" }, { kind: "adjust", qty: -1, reason: null },
    { kind: "adjust", qty: -2, reason: "Synthetic loss" }, { kind: "adjust", qty: -0.1234, reason: "Synthetic loss" },
  ] as Partial<MovementInput>[])("preserves rejection and no writes for %j", async extra => {
    const f = await fixture(); await db.createInventoryMovement(f); const before = await state(f);
    expect((await db.createInventoryMovement({ ...f, ...extra, supplierPartyId: null })).ok).toBe(false);
    expect(await state(f)).toEqual(before);
  });
  it.each(["doctor", "accountant", "cashier"])("retains %s purchase authorization denial", async role => {
    const f = await fixture(); const before = await state(f);
    auth.session = { role, username: f.createdBy };
    expect((await request(f)).status).toBe(403); expect(await state(f)).toEqual(before);
  });
  it("retains logged-out and patient-access denials", async () => {
    const f = await fixture(); const before = await state(f);
    auth.session = null; expect((await request(f)).status).toBe(401);
    auth.session = { role: "doctor", username: f.createdBy };
    expect((await request(f, { kind: "out", supplierPartyId: null, patientId: 123 })).status).toBe(403);
    expect(await state(f)).toEqual(before);
  });
  it.each(["admin", "reception"])("retains successful %s purchase and audit", async role => {
    const f = await fixture(); auth.session = { role, username: f.createdBy };
    expect((await request(f)).status).toBe(201);
    const saved = await state(f); expect(saved.movements).toHaveLength(1); expect(saved.payables).toHaveLength(1); expect(saved.audit).toHaveLength(1);
  });
  it("does not bill a supplier for a return, issue or adjustment", async () => {
    const f = await fixture(); await db.createInventoryMovement(f); const before = await state(f);
    for (const extra of [{ isReturn: true }, { kind: "out" as const }, { kind: "adjust" as const, reason: "Synthetic" }]) {
      expect((await db.createInventoryMovement({ ...f, ...extra })).ok).toBe(false);
      expect(await state(f)).toEqual(before);
    }
  });
});
