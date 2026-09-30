import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PATIENT_FAMILIES_SQL } from "../lib/patient-families-schema";
import { RESET_WIPE_TABLES } from "../lib/clinic-reset";

describe("(PAT-4) patient families schema", () => {
  it("keeps migration 0037 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0037_patient_families.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(PATIENT_FAMILIES_SQL.trim());
  });

  it("is additive only: no DROP, no data rewrite, the new patient columns are nullable", () => {
    expect(PATIENT_FAMILIES_SQL).not.toMatch(/DROP\s/i);
    expect(PATIENT_FAMILIES_SQL).not.toMatch(/^\s*(DELETE|UPDATE|INSERT)\s/im);
    const columns = PATIENT_FAMILIES_SQL.match(/ADD COLUMN IF NOT EXISTS [^;]+;/g) ?? [];
    expect(columns).toHaveLength(2);
    for (const column of columns) expect(column).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it("holds no money: no amount/currency column anywhere", () => {
    expect(PATIENT_FAMILIES_SQL).not.toMatch(/minor|amount|currency|balance/i);
  });

  it("losing a guarantor or a family never blocks a patient delete (SET NULL both ways)", () => {
    expect(PATIENT_FAMILIES_SQL).toMatch(/guarantor_patient_id INTEGER\s+REFERENCES patients\(id\) ON DELETE SET NULL/);
    expect(PATIENT_FAMILIES_SQL).toMatch(/family_id INTEGER REFERENCES patient_families\(id\) ON DELETE SET NULL/);
    expect(PATIENT_FAMILIES_SQL).toMatch(/CHECK \(guarantor_patient_id IS NULL OR \(guarantor_name IS NULL AND guarantor_phone IS NULL\)\)/);
    expect(PATIENT_FAMILIES_SQL).toMatch(/CREATE INDEX IF NOT EXISTS patients_family_idx ON patients \(family_id\)/);
  });

  it("factory reset wipes families together with patients", () => {
    expect(RESET_WIPE_TABLES).toContain("patient_families");
    expect(RESET_WIPE_TABLES.indexOf("patient_families")).toBeLessThan(RESET_WIPE_TABLES.indexOf("patients"));
  });
});
