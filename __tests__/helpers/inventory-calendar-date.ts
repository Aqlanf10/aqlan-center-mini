import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expiryState } from "../../lib/inventory";
import { costNow } from "../../lib/inventoryCost";
import { CLINIC_BASE_CURRENCY } from "../../lib/money";

type Database = typeof import("../../lib/db");
type MovementInput = Parameters<Database["createInventoryMovement"]>[0];

// One contract for both supported drivers. All assertions below use actual SQL
// results and the public application writer/readers, not a mocked DATE value.
export function inventoryCalendarDateContract(driver: "PGlite" | "PostgreSQL", getDb: () => Database) {
  const originalTimeZone = process.env.TZ;
  const run = randomUUID().slice(0, 8);
  let sequence = 0;

  async function fixture() {
    const actor = `synthetic-inventory-date-${run}-${++sequence}`;
    const { rows: [item] } = await getDb().getPool().query<{ id: number }>(
      `INSERT INTO inventory_items (name, unit, is_active, created_by)
       VALUES ($1, 'box', TRUE, $2) RETURNING id`, [actor, actor],
    );
    return { itemId: item.id, actor };
  }

  async function write(input: MovementInput) {
    const result = await getDb().createInventoryMovement(input);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    // Audit is deliberately post-commit. Await the actual durable row before
    // finishing a case so teardown or timezone restoration cannot race it.
    await expect.poll(async () => {
      const { rows } = await getDb().getPool().query(
        `SELECT id FROM audit_log WHERE action = 'inventory.move'
         AND entity_id = $1 AND actor = $2`, [String(result.movement.id), input.createdBy],
      );
      return rows.length;
    }, { timeout: 5_000, interval: 10 }).toBe(1);
    return result;
  }

  afterEach(() => {
    if (originalTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimeZone;
  });

  describe.each([
    { zone: "UTC", januaryOffset: 0 },
    { zone: "Asia/Aden", januaryOffset: -180 },
  ])(`inventory calendar dates on ${driver} in $zone`, ({ zone, januaryOffset }) => {
    beforeEach(() => {
      process.env.TZ = zone;
      // Fail closed if this runner cannot exercise a different Date parser zone.
      expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(januaryOffset);
    });

    it.each(["2026-11-11", "2026-01-01", "2028-02-29", null])(
      "round-trips calendar DATE %s through INSERT RETURNING, list and detail",
      async expiryDate => {
        const { itemId, actor } = await fixture();
        const result = await write({ itemId, kind: "in", qty: 2.5, expiryDate,
          unitCostMinor: 1400, createdBy: actor });
        const { rows: [stored] } = await getDb().getPool().query<{
          expiry_date: Date | null; expiry_date_text: string | null; date_type: string;
          created_at: Date; qty: string; unit_cost_minor: string;
        }>(`SELECT expiry_date, expiry_date::text AS expiry_date_text,
             pg_typeof(expiry_date)::text AS date_type, created_at, qty, unit_cost_minor
           FROM inventory_movements WHERE id = $1`, [result.movement.id]);
        expect(stored).toMatchObject({ expiry_date_text: expiryDate, date_type: "date" });
        expect(Number(stored.qty)).toBe(2.5);
        expect(Number(stored.unit_cost_minor)).toBe(1400);
        if (expiryDate !== null) {
          expect(stored.expiry_date).toBeInstanceOf(Date);
          if (driver === "PostgreSQL") {
            expect(stored.expiry_date!.getHours()).toBe(0);
            expect(stored.expiry_date!.getFullYear()).toBe(Number(expiryDate.slice(0, 4)));
            expect(stored.expiry_date!.getMonth() + 1).toBe(Number(expiryDate.slice(5, 7)));
            expect(stored.expiry_date!.getDate()).toBe(Number(expiryDate.slice(8, 10)));
          } else {
            expect(stored.expiry_date!.toISOString()).toBe(`${expiryDate}T00:00:00.000Z`);
          }
        } else {
          expect(stored.expiry_date).toBeNull();
        }
        const listed = await getDb().listInventoryMovements(itemId);
        const detail = await getDb().getInventoryItemDetail(itemId);
        expect(listed).toHaveLength(1);
        expect(detail).not.toBeNull();
        for (const movement of [result.movement, listed[0], detail!.movements[0]]) {
          expect.soft(movement.expiryDate).toBe(expiryDate);
          expect(movement.createdAt.toISOString()).toBe(stored.created_at.toISOString());
        }
        expect(detail!.batches.batches).toEqual([
          { id: result.movement.id, expiryDate, inQty: 2.5, remaining: 2.5 },
        ]);
        expect(result.balance).toBe(2.5);
        expect(costNow(listed)).toEqual({ qty: 2.5, valueMinor: 3500, unitCostMinor: 1400 });
        const { rows: [audit] } = await getDb().getPool().query<{ details: Record<string, unknown> }>(
          `SELECT details FROM audit_log WHERE action = 'inventory.move' AND entity_id = $1`,
          [String(result.movement.id)],
        );
        if (expiryDate !== null) expect(audit.details["الصلاحية"]).toBe(expiryDate);
        else expect(audit.details).not.toHaveProperty("الصلاحية");
      },
    );

    it("reads the same stored DATE after a process timezone change without rewriting it", async () => {
      const { itemId, actor } = await fixture();
      const result = await write({ itemId, kind: "in", qty: 1,
        expiryDate: "2028-02-29", createdBy: actor });
      const readStored = async () => (await getDb().getPool().query(
        `SELECT id, expiry_date::text AS expiry_date_text, qty, created_at,
           unit_cost_minor, is_return, party_id, payable_id
         FROM inventory_movements WHERE id = $1`, [result.movement.id],
      )).rows;
      const before = await readStored();
      process.env.TZ = zone === "UTC" ? "Asia/Aden" : "UTC";
      expect((await getDb().listInventoryMovements(itemId))[0].expiryDate).toBe("2028-02-29");
      expect(await readStored()).toEqual(before);
    });

    it("keeps expiry-day alerts, FEFO quantities, descending reads and WAC intact", async () => {
      const { itemId, actor } = await fixture();
      const today = "2026-11-11";
      // Insert the later-expiring batch first to distinguish FEFO from id order.
      const later = await write({ itemId, kind: "in", qty: 4,
        expiryDate: today, unitCostMinor: 1000, createdBy: actor });
      const earlier = await write({ itemId, kind: "in", qty: 4,
        expiryDate: "2026-11-10", unitCostMinor: 2000, createdBy: actor });
      const undated = await write({ itemId, kind: "in", qty: 2,
        expiryDate: null, unitCostMinor: 1500, createdBy: actor });
      const before = await getDb().inventoryAlerts(today);
      expect(before.expired.filter(row => row.itemId === itemId)).toMatchObject([
        { batchId: earlier.movement.id, expiryDate: "2026-11-10", remaining: 4 },
      ]);
      expect(before.soon.filter(row => row.itemId === itemId)).toMatchObject([
        { batchId: later.movement.id, expiryDate: today, remaining: 4 },
      ]);
      expect(expiryState(later.movement.expiryDate!, today)).toBe("soon");
      const issued = await write({ itemId, kind: "out", qty: 5,
        expiryDate: "2099-01-01", createdBy: actor });
      expect(issued).toMatchObject({ balance: 5, movement: { expiryDate: null } });
      const movements = await getDb().listInventoryMovements(itemId, null);
      expect(movements.map(row => row.id)).toEqual([
        issued.movement.id, undated.movement.id, earlier.movement.id, later.movement.id,
      ]);
      expect(costNow([...movements].reverse())).toEqual({ qty: 5, valueMinor: 7500, unitCostMinor: 1500 });
      const detail = await getDb().getInventoryItemDetail(itemId);
      expect(detail!.batches).toEqual({ adjustTotal: 0, batches: [
        { id: earlier.movement.id, expiryDate: "2026-11-10", inQty: 4, remaining: 0 },
        { id: later.movement.id, expiryDate: today, inQty: 4, remaining: 3 },
        { id: undated.movement.id, expiryDate: null, inQty: 2, remaining: 2 },
      ] });
      const after = await getDb().inventoryAlerts(today);
      expect(after.expired.filter(row => row.itemId === itemId)).toEqual([]);
      expect(after.soon.filter(row => row.itemId === itemId)).toMatchObject([
        { batchId: later.movement.id, expiryDate: today, remaining: 3 },
      ]);
    });

    it("retains supplier payable and audit facts with the unshifted returned expiry", async () => {
      const { itemId, actor } = await fixture();
      const { rows: [supplier] } = await getDb().getPool().query<{ id: number }>(
        `INSERT INTO parties (name, kind, is_active) VALUES ($1, 'supplier', TRUE) RETURNING id`, [actor],
      );
      const result = await write({ itemId, kind: "in", qty: 2.5,
        expiryDate: "2028-02-29", unitCostMinor: 1400, supplierPartyId: supplier.id,
        supplierDueDate: "2028-03-01", createdBy: actor });
      expect(result.movement).toMatchObject({ expiryDate: "2028-02-29", partyId: supplier.id });
      const { rows: payables } = await getDb().getPool().query<{
        id: number; party_id: number; amount: string; currency: string;
        base_amount: string; base_currency: string; due_date_text: string;
      }>(`SELECT id, party_id, amount_minor::text AS amount, currency,
           base_amount_minor::text AS base_amount, base_currency, due_date::text AS due_date_text
         FROM payables WHERE created_by = $1`, [actor]);
      expect(payables).toEqual([{ id: result.movement.payableId, party_id: supplier.id,
        amount: "3500", currency: CLINIC_BASE_CURRENCY, base_amount: "3500",
        base_currency: CLINIC_BASE_CURRENCY, due_date_text: "2028-03-01" }]);
      const { rows: [audit] } = await getDb().getPool().query<{ details: Record<string, unknown> }>(
        `SELECT details FROM audit_log WHERE action = 'inventory.move' AND entity_id = $1`,
        [String(result.movement.id)],
      );
      expect(audit.details).toMatchObject({ الصلاحية: "2028-02-29", الكمية: 2.5,
        الرصيد_قبل: 0, الرصيد_بعد: 2.5, تكلفة_الوحدة: 1400,
        المورّد: actor, التزام_المورّد: result.movement.payableId });
    });
  });
}
