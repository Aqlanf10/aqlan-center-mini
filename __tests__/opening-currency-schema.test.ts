import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPENING_CURRENCY_SQL } from "../lib/opening-currency-schema";

describe("(P1-5b) opening balance currency schema", () => {
  it("keeps migration 0023 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0023_opening_balance_currency.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(OPENING_CURRENCY_SQL.trim());
  });
});
