import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INTERNAL_REFERRALS_SQL } from "../lib/internal-referrals-schema";

describe("REF-1 internal referral schema", () => {
  it("keeps migration 0033 byte-equal to ensureSchema", () => {
    const lines = readFileSync("migrations/0033_internal_referral_foundation.sql", "utf8").replace(/\r\n/g, "\n").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(INTERNAL_REFERRALS_SQL.trim());
  });

  it("only adds fields and indexes to the existing referral table", () => {
    expect(INTERNAL_REFERRALS_SQL).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i);
    expect(INTERNAL_REFERRALS_SQL).not.toMatch(/^\s*(DELETE|UPDATE)\s/im);
    expect(INTERNAL_REFERRALS_SQL).not.toMatch(/CREATE TABLE/i);
    expect(INTERNAL_REFERRALS_SQL).toMatch(/DEFAULT 'external'/);
    expect(INTERNAL_REFERRALS_SQL).toMatch(/UNIQUE INDEX IF NOT EXISTS patient_referrals_internal_request_idx/);
  });
});
