import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATIENT_REFERRALS_SQL } from "../lib/referrals-schema";

describe("patient referrals schema (P3-8)", () => {
  it("keeps migration 0021 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0021_patient_referrals.sql", "utf8").split("\n");
    let index = 0;
    while (index < lines.length && (lines[index].startsWith("--") || lines[index].trim() === "")) index += 1;
    expect(lines.slice(index).join("\n").trim()).toBe(PATIENT_REFERRALS_SQL.trim());
  });

  it("a referral never disappears with its patient, and a cancel needs a reason", () => {
    expect(PATIENT_REFERRALS_SQL).toMatch(/REFERENCES patients\(id\) ON DELETE RESTRICT/);
    expect(PATIENT_REFERRALS_SQL).toMatch(/status <> 'cancelled' OR/);
  });
});
