import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { COMMISSION_CASE_OVERRIDES_SQL } from "../lib/commission-overrides-schema";
import { RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("(COMM-DETAIL-1) commission case overrides schema", () => {
  it("keeps migration 0035 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0035_commission_case_overrides.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(COMMISSION_CASE_OVERRIDES_SQL.trim());
  });

  it("is additive and append-only: a new table, no data rewrite, UPDATE/DELETE rejected by trigger", () => {
    expect(COMMISSION_CASE_OVERRIDES_SQL).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i);
    expect(COMMISSION_CASE_OVERRIDES_SQL).not.toMatch(/^\s*(DELETE|UPDATE|ALTER)\s/im);
    expect(COMMISSION_CASE_OVERRIDES_SQL).toMatch(/BEFORE UPDATE OR DELETE ON commission_case_overrides/);
    expect(COMMISSION_CASE_OVERRIDES_SQL).toMatch(/reason\s+TEXT\s+NOT NULL/);
    expect(COMMISSION_CASE_OVERRIDES_SQL).toMatch(/CHECK \(\(case_id IS NULL\) <> \(plan_id IS NULL\)\)/);
    expect(COMMISSION_CASE_OVERRIDES_SQL).toMatch(/CHECK \(action IN \('set', 'void'\)\)/);
  });

  it("factory reset wipes the overrides before the cases and plans they reference", () => {
    expect(RESET_WIPE_TABLES).toContain("commission_case_overrides");
    for (const table of ["clinical_cases", "treatment_plans", "plan_items"] as const) {
      expect(RESET_WIPE_TABLES.indexOf("commission_case_overrides")).toBeLessThan(RESET_WIPE_TABLES.indexOf(table));
    }
  });
});
