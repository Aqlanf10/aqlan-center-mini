import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INVOICE_ADMIN_DISCOUNT_SQL } from "../lib/invoice-admin-discount-schema";
import { RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("(FIN-DISC) admin discount allocation schema", () => {
  it("keeps migration 0044 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0044_invoice_admin_discount_lines.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(INVOICE_ADMIN_DISCOUNT_SQL.trim());
  });

  it("is additive only: one new table, no DROP, no rewrite of existing data or columns", () => {
    expect(INVOICE_ADMIN_DISCOUNT_SQL).not.toMatch(/DROP\s/i);
    expect(INVOICE_ADMIN_DISCOUNT_SQL).not.toMatch(/^\s*(DELETE|UPDATE|INSERT)\s/im);
    expect(INVOICE_ADMIN_DISCOUNT_SQL).not.toMatch(/ALTER TABLE/i);
    expect(INVOICE_ADMIN_DISCOUNT_SQL.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)?.map((m) => m.split(" ").pop()))
      .toEqual(["invoice_admin_discount_lines"]);
  });

  it("is wiped by the factory reset before its invoice rows", () => {
    expect(RESET_WIPE_TABLES.indexOf("invoice_admin_discount_lines")).toBeLessThan(RESET_WIPE_TABLES.indexOf("invoice_items"));
  });
});
