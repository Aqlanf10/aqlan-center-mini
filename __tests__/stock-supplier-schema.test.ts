import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { STOCK_SUPPLIER_SQL } from "../lib/stock-supplier-schema";

describe("stock supplier link schema (P2-10)", () => {
  it("keeps migration 0017 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0017_stock_supplier_link.sql", "utf8").split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    expect(lines.slice(index).join("\n").trim()).toBe(STOCK_SUPPLIER_SQL.trim());
  });

  it("allows one payable per stock movement", () => {
    expect(STOCK_SUPPLIER_SQL).toMatch(/UNIQUE INDEX IF NOT EXISTS inventory_movements_payable_uniq/);
  });
});
