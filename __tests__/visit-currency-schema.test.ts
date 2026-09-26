import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VISIT_CURRENCY_SQL } from "../lib/visit-currency-schema";

describe("(DAY1) visit currency schema", () => {
  it("keeps migration 0026 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0026_visit_currency.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(VISIT_CURRENCY_SQL.trim());
  });
});
