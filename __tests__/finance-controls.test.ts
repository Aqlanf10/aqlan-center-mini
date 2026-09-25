import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FINANCE_CONTROLS_SQL } from "../lib/finance-controls-schema";

describe("finance controls schema (P2-5 + P2-9)", () => {
  it("keeps migration 0016 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0016_finance_controls.sql", "utf8").split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    expect(lines.slice(index).join("\n").trim()).toBe(FINANCE_CONTROLS_SQL.trim());
  });

  it("adds the money constraints NOT VALID so an old row cannot break the migration", () => {
    for (const name of ["payments_amount_positive", "payments_kind_known", "payments_currency_known",
      "invoices_amounts_sane", "invoices_currency_known", "expenses_currency_known"]) {
      expect(FINANCE_CONTROLS_SQL).toMatch(new RegExp(`${name}[\\s\\S]*?NOT VALID`));
    }
  });
});
