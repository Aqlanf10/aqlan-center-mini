import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { dropPublicSchema, stubPostgresEnv } from "./_setup";

// Validate the original environment before touching an explicitly isolated,
// synthetic PostgreSQL test database. Never connect to a Production target.
const target = validatePostgresTestTarget(process.env);
stubPostgresEnv();
const auth = vi.hoisted(() => ({ session: { username: "synthetic-admin", role: "admin" } as
  { username: string; role: string } | null }));
vi.mock("@/lib/session", () => ({ requireSession: async () => auth.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: async () => false }));
const db = await import("../../lib/db");
const { POST } = await import("../../app/api/inventory/[id]/movements/route");
let serial = 0;

beforeAll(async () => { await dropPublicSchema(target.testUrl.toString()); await db.ensureSchema(); });
beforeEach(() => { auth.session = { username: "synthetic-admin", role: "admin" }; });
afterAll(async () => { await db.resetPoolForTesting(); });

async function fixture() {
  const name = `Synthetic supplier validation ${++serial}`;
  const { rows: [item] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO inventory_items(name,created_by) VALUES ($1,'synthetic') RETURNING id", [name]);
  const { rows: [party] } = await db.getPool().query<{ id: number }>(
    "INSERT INTO parties(name,kind) VALUES ($1,'supplier') RETURNING id", [name]);
  return { itemId: item.id, supplierId: party.id };
}

async function state(f: Awaited<ReturnType<typeof fixture>>) {
  const { rows: movements } = await db.getPool().query(
    "SELECT * FROM inventory_movements WHERE item_id=$1 ORDER BY id", [f.itemId]);
  // Inspect every payable and movement audit, not just the intended supplier:
  // coercion to a different valid ID must not hide an unintended liability.
  const { rows: payables } = await db.getPool().query("SELECT * FROM payables ORDER BY id");
  const { rows: audit } = await db.getPool().query(
    "SELECT * FROM audit_log WHERE action='inventory.move' ORDER BY id");
  const { rows: [stock] } = await db.getPool().query(
    "SELECT COALESCE(SUM(CASE WHEN kind='out' THEN -qty ELSE qty END),0)::text AS balance FROM inventory_movements WHERE item_id=$1", [f.itemId]);
  return { movements, payables, audit, balance: stock.balance };
}

function request(f: Awaited<ReturnType<typeof fixture>>, supplier: Record<string, unknown>,
  changes: Record<string, unknown> = {}) {
  return POST(new Request(`http://test.invalid/api/inventory/${f.itemId}/movements`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "in", qty: 2, unitCost: "100", ...supplier, ...changes }),
  }), { params: Promise.resolve({ id: String(f.itemId) }) });
}

describe("supplier ID validation through the real purchase writer", () => {
  it.each([
    true, false, [], [42], ["42"], {}, { id: 42 }, 0, -1, 1.5,
    2147483648, Number.MAX_SAFE_INTEGER + 1, "not-an-id", "0", "-1",
    "1.5", "2147483648", "9007199254740993", "9".repeat(400), " ",
    " 42 ", "+42", "4.2e1", "0x2a", "42.0",
  ].map(value => ({ value })))("rejects $value with zero stock, payable or audit writes", async ({ value }) => {
    const f = await fixture(); const before = await state(f);
    expect(before.movements).toHaveLength(0);
    expect(Number(before.balance)).toBe(0);
    expect((await request(f, { supplierPartyId: value })).status).toBe(400);
    expect(await state(f)).toEqual(before);
  });

  it("rejects an array containing an existing supplier without creating its payable", async () => {
    const f = await fixture(); const before = await state(f);
    expect((await request(f, { supplierPartyId: [f.supplierId] })).status).toBe(400);
    expect(await state(f)).toEqual(before);
  });

  it.each(["number", "decimal string", "zero-padded decimal string"] as const)(
    "commits exactly one linked YER payable, movement and audit for a valid %s", async format => {
      const f = await fixture(); const before = await state(f);
      const value = format === "number" ? f.supplierId
        : format === "decimal string" ? String(f.supplierId) : `000${f.supplierId}`;
      const response = await request(f, { supplierPartyId: value }, { supplierDueDate: "2026-12-31" });
      expect(response.status).toBe(201);
      const result = await response.json();
      expect(result).toMatchObject({ ok: true, balance: 2, movement: { partyId: f.supplierId } });
      const saved = await state(f);
      expect(saved.movements).toEqual([expect.objectContaining({
        id: result.movement.id, qty: "2.000", party_id: f.supplierId, payable_id: result.movement.payableId,
      })]);
      expect(Number(saved.balance)).toBe(2);
      expect(saved.payables.slice(before.payables.length)).toEqual([expect.objectContaining({
        id: result.movement.payableId, party_id: f.supplierId, category: "supplier",
        amount_minor: "200", base_amount_minor: "200", currency: "YER", base_currency: "YER",
        exchange_rate: "1.000000",
      })]);
      expect(saved.audit.slice(before.audit.length)).toEqual([expect.objectContaining({
        entity_id: String(result.movement.id), actor: "synthetic-admin",
        details: expect.objectContaining({ الكمية: 2, الرصيد_قبل: 0, الرصيد_بعد: 2,
          التزام_المورّد: result.movement.payableId }),
      })]);
    },
  );

  it.each(["number", "string"] as const)("keeps the audit atomic for a valid %s ID", async format => {
    const f = await fixture(); const before = await state(f);
    const supplierPartyId = format === "number" ? f.supplierId : String(f.supplierId);
    await db.getPool().query(`CREATE FUNCTION synthetic_reject_supplier_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='inventory.move' THEN RAISE EXCEPTION 'synthetic supplier audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_reject_supplier_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_reject_supplier_audit()`);
    try {
      expect((await request(f, { supplierPartyId })).status).toBe(500);
      expect(await state(f)).toEqual(before);
    } finally {
      await db.getPool().query("DROP TRIGGER synthetic_reject_supplier_audit ON audit_log; DROP FUNCTION synthetic_reject_supplier_audit()");
    }
    expect((await request(f, { supplierPartyId })).status).toBe(201);
    const saved = await state(f);
    expect(saved.movements).toHaveLength(1);
    expect(saved.payables).toHaveLength(before.payables.length + 1);
    expect(saved.audit).toHaveLength(before.audit.length + 1);
  });

  for (const unitCost of [undefined, "100"]) {
    it.each([
      { label: "omitted", supplier: {} },
      { label: "null", supplier: { supplierPartyId: null } },
      { label: "empty string", supplier: { supplierPartyId: "" } },
    ])(`preserves $label no-supplier receipt, unit cost ${unitCost}`, async ({ supplier }) => {
      const f = await fixture(); const before = await state(f);
      expect((await request(f, supplier, { unitCost })).status).toBe(201);
      const saved = await state(f);
      expect(saved.movements).toEqual([expect.objectContaining({
        party_id: null, payable_id: null, unit_cost_minor: unitCost ? "100" : null,
      })]);
      expect(Number(saved.balance)).toBe(2);
      expect(saved.payables).toEqual(before.payables);
      expect(saved.audit).toHaveLength(before.audit.length + 1);
      expect(saved.audit.at(-1).details).not.toHaveProperty("التزام_المورّد");
    });
  }

  it.each(["unknown", "inactive", "doctor"] as const)("preserves %s party rejection with no writes", async kind => {
    const f = await fixture();
    if (kind === "inactive") await db.getPool().query("UPDATE parties SET is_active=false WHERE id=$1", [f.supplierId]);
    if (kind === "doctor") await db.getPool().query("UPDATE parties SET kind='doctor' WHERE id=$1", [f.supplierId]);
    const before = await state(f);
    expect((await request(f, { supplierPartyId: kind === "unknown" ? 2147483647 : f.supplierId })).status).toBe(409);
    expect(await state(f)).toEqual(before);
  });

  it.each(["supplier", "lab", "other"])("preserves the existing allowed %s party kind", async kind => {
    const f = await fixture();
    await db.getPool().query("UPDATE parties SET kind=$1 WHERE id=$2", [kind, f.supplierId]);
    expect((await request(f, { supplierPartyId: f.supplierId })).status).toBe(201);
    const saved = await state(f);
    expect(saved.movements).toHaveLength(1);
    expect(saved.movements[0].party_id).toBe(f.supplierId);
  });

  it.each(["doctor", "cashier", "accountant", "assistant", null])("preserves %s purchase authorization", async role => {
    const f = await fixture(); const before = await state(f);
    auth.session = role ? { username: "synthetic-user", role } : null;
    expect((await request(f, { supplierPartyId: f.supplierId })).status).toBe(role ? 403 : 401);
    expect(await state(f)).toEqual(before);
  });

  it.each(["admin", "reception"])("preserves %s supplier purchase authorization", async role => {
    const f = await fixture(); const before = await state(f);
    auth.session = { username: "synthetic-user", role };
    expect((await request(f, { supplierPartyId: String(f.supplierId) })).status).toBe(201);
    const saved = await state(f);
    expect(saved.movements).toHaveLength(1);
    expect(saved.payables).toHaveLength(before.payables.length + 1);
    expect(saved.audit).toHaveLength(before.audit.length + 1);
  });
});
