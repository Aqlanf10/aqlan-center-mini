/** Inventory DATE columns are calendar values (stand-in batch, 2026-11-09). node-postgres
 * returns a DATE as a local-midnight Date; serializing it through UTC moves the civil day
 * east of UTC (Asia/Aden), and String(Date) is not a date at all. Synthetic data only. */
vi.mock("server-only", () => ({}));
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-inventory-date-only-2026-xyz");
const db = await import("../../lib/db");

const ACCOUNTS = { owner: { username: "SYN-INVD-OWNER", role: "admin" } } as const;
let fx: CanonicalInventoryDatabase<keyof typeof ACCOUNTS>;
const originalZone = process.env.TZ;
const ZONES = ["Asia/Aden", "Pacific/Kiritimati", "America/Los_Angeles", "UTC"] as const;
const ctx = { item: 0, patient: 0 };

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  ctx.item = (await fx.pool.query<{ id: number }>("INSERT INTO inventory_items(name,unit,created_by) VALUES('SYN INVD resin','tube','synthetic') RETURNING id")).rows[0].id;
  ctx.patient = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number, full_name) VALUES('SYN-INVD-1','SYN INVD patient') RETURNING id")).rows[0].id;
}, 180_000);
afterEach(() => { if (originalZone === undefined) delete process.env.TZ; else process.env.TZ = originalZone; });
afterAll(async () => { await fx?.close(); });

describe("inventory batch expiry dates keep their civil day in every process zone", () => {
  for (const zone of ZONES) {
    it(`movement writer/reader in ${zone}`, async () => {
      process.env.TZ = zone;
      const result = await db.createInventoryMovement({ itemId: ctx.item, kind: "in", qty: 1, expiryDate: "2026-11-11", createdBy: "SYN-INVD" });
      if (!result.ok) throw new Error(result.message);
      expect(result.movement.expiryDate).toBe("2026-11-11");
      const detail = await db.getInventoryItemDetail(ctx.item);
      expect(detail?.movements.find(row => row.id === result.movement.id)?.expiryDate).toBe("2026-11-11");
      expect(detail?.batches.batches.find(batch => batch.id === result.movement.id)?.expiryDate).toBe("2026-11-11");
    });
    it(`patient materials read (M2 slice 82) in ${zone}`, async () => {
      process.env.TZ = zone;
      await fx.pool.query("INSERT INTO inventory_movements(item_id, kind, qty, expiry_date, patient_id, created_by) VALUES($1,'out',1,'2026-12-31',$2,'SYN-INVD')", [ctx.item, ctx.patient]);
      const rows = await db.listPatientMaterialsWith(fx.pool, ctx.patient);
      expect(rows.map(row => row.expiryDate)).toContain("2026-12-31");
      for (const row of rows) if (row.expiryDate !== null) expect(row.expiryDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  }
});
