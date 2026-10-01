import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGACY_BALANCE_ARRANGEMENTS_SQL } from "../lib/legacy-balance-arrangements-schema";
import { RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("(P0-C) legacy balance arrangement schema", () => {
  it("keeps migration 0038 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0038_legacy_balance_arrangements.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(LEGACY_BALANCE_ARRANGEMENTS_SQL.trim());
  });

  it("is additive metadata only and never references invoice/payment/plan principal", () => {
    expect(LEGACY_BALANCE_ARRANGEMENTS_SQL).not.toMatch(/\bDROP\b/i);
    expect(LEGACY_BALANCE_ARRANGEMENTS_SQL).not.toMatch(/^\s*(DELETE|UPDATE|INSERT)\s/im);
    expect(LEGACY_BALANCE_ARRANGEMENTS_SQL).not.toMatch(/invoice_id|plan_id|payment_id/i);
    expect(LEGACY_BALANCE_ARRANGEMENTS_SQL).toMatch(/starting_due_minor/);
    expect(LEGACY_BALANCE_ARRANGEMENTS_SQL).toMatch(/installment_minor/);
  });

  it("allows only one active arrangement per patient and currency", () => {
    expect(LEGACY_BALANCE_ARRANGEMENTS_SQL).toMatch(
      /UNIQUE INDEX IF NOT EXISTS legacy_balance_arrangements_one_active_idx[\s\S]+WHERE cancelled_at IS NULL/,
    );
  });

  it("is wiped with patient financial data on clinic reset", () => {
    expect(RESET_WIPE_TABLES).toContain("legacy_balance_arrangements");
    expect(RESET_WIPE_TABLES.indexOf("legacy_balance_arrangements"))
      .toBeLessThan(RESET_WIPE_TABLES.indexOf("patients"));
  });
});
