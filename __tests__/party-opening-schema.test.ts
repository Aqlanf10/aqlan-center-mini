import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PARTY_OPENING_SQL } from "../lib/party-opening-schema";
import { RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("(FIA-1) party opening balances schema", () => {
  it("keeps migration 0030 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0030_party_opening_balances.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(PARTY_OPENING_SQL.trim());
  });

  it("is additive only: no DROP TABLE/COLUMN, no DELETE, no UPDATE of data", () => {
    expect(PARTY_OPENING_SQL).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    expect(PARTY_OPENING_SQL).not.toMatch(/^\s*(DELETE|UPDATE)\s/im);
  });

  it("factory reset wipes the new financial tables with the payables they belong to", () => {
    expect(RESET_WIPE_TABLES).toEqual(expect.arrayContaining(["payable_adjustments", "party_opening_advances"]));
    expect(RESET_WIPE_TABLES.indexOf("payable_adjustments")).toBeLessThan(RESET_WIPE_TABLES.indexOf("payables"));
  });
});
