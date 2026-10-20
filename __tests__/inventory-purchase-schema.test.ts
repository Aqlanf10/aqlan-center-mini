import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checksumOf, loadMigrationFiles } from "../lib/migration-files";
import { INVENTORY_PURCHASE_RECEIPTS_SQL } from "../lib/inventory-purchase-schema";

describe("inventory purchase receipt migration provenance", () => {
  it("uses exactly the same bytes and checksum for numbered and runtime installation", async () => {
    const sql = readFileSync("migrations/0065_inventory_purchase_receipts.sql", "utf8");
    expect(sql).toBe(INVENTORY_PURCHASE_RECEIPTS_SQL);
    const file = (await loadMigrationFiles()).find(file => file.version === "0065");
    expect(file).toEqual({
      version: "0065",
      name: "inventory_purchase_receipts",
      filename: "0065_inventory_purchase_receipts.sql",
      sql,
      checksum: checksumOf(INVENTORY_PURCHASE_RECEIPTS_SQL),
    });
  });

  it("registers through the existing checksum/transaction lock discipline", () => {
    const db = readFileSync("lib/db.ts", "utf8");
    expect(db).toMatch(/applyRuntimeMigrationFiles\(getPool\(\),\s*\[\{\s*version:\s*"0065"/);
    expect(db).toContain("checksum: checksumOf(INVENTORY_PURCHASE_RECEIPTS_SQL)");
    expect(INVENTORY_PURCHASE_RECEIPTS_SQL).not.toMatch(/\b(?:INSERT INTO|UPDATE inventory_|DELETE FROM|DROP TABLE|ALTER TABLE)\b/i);
  });
});
