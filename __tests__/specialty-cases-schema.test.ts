import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SPECIALTY_CASES_SQL } from "../lib/specialty-cases-schema";
import { RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("(CASE-MODEL-1) specialty cases schema", () => {
  it("keeps migration 0032 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0032_specialty_cases.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(SPECIALTY_CASES_SQL.trim());
  });

  it("is additive only: no DROP, no DELETE/UPDATE of data, new columns nullable", () => {
    expect(SPECIALTY_CASES_SQL).not.toMatch(/DROP\s+(TABLE|COLUMN|CONSTRAINT)/i);
    expect(SPECIALTY_CASES_SQL).not.toMatch(/^\s*(DELETE|UPDATE)\s/im);
    for (const column of SPECIALTY_CASES_SQL.match(/ADD COLUMN IF NOT EXISTS [^;]+;/g) ?? []) {
      expect(column).not.toMatch(/NOT NULL/);
    }
  });

  it("keeps clinical records: patient and case references restrict deletion", () => {
    expect(SPECIALTY_CASES_SQL).toMatch(/patient_id\s+INTEGER\s+NOT NULL REFERENCES patients\(id\) ON DELETE RESTRICT/);
    expect(SPECIALTY_CASES_SQL).toMatch(/status <> 'cancelled' OR length\(btrim/);
    expect(SPECIALTY_CASES_SQL).toMatch(/CHECK \(item_id <> requires_item_id\)/);
  });

  it("factory reset wipes the new clinical tables before what they reference", () => {
    expect(RESET_WIPE_TABLES).toEqual(expect.arrayContaining(["clinical_cases", "patient_problems", "plan_item_dependencies"]));
    expect(RESET_WIPE_TABLES.indexOf("plan_item_dependencies")).toBeLessThan(RESET_WIPE_TABLES.indexOf("plan_items"));
    expect(RESET_WIPE_TABLES.indexOf("patient_problems")).toBeLessThan(RESET_WIPE_TABLES.indexOf("clinical_cases"));
    expect(RESET_WIPE_TABLES.indexOf("clinical_cases")).toBeLessThan(RESET_WIPE_TABLES.indexOf("patients"));
  });
});
