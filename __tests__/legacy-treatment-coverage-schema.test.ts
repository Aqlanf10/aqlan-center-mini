import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGACY_TREATMENT_COVERAGE_SQL } from "../lib/legacy-treatment-coverage-schema";

const blob = (path: string) => {
  const bytes = readFileSync(path);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
describe("immutable coverage0043 source contract", () => {
  it("keeps the additive migration body byte-equal to its runtime SQL source", () => {
    const lines = readFileSync("migrations/0043_legacy_treatment_coverage.sql", "utf8").split("\n");
    expect(lines.slice(lines.findIndex((line) => !line.startsWith("--"))).join("\n")).toBe(LEGACY_TREATMENT_COVERAGE_SQL);
    expect(LEGACY_TREATMENT_COVERAGE_SQL.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)).toEqual([
      "CREATE TABLE IF NOT EXISTS legacy_treatment_coverage_snapshots",
    ]);
    expect(LEGACY_TREATMENT_COVERAGE_SQL).not.toMatch(/\b(DROP|ALTER TABLE|TRUNCATE)\b|^\s*(UPDATE|DELETE|INSERT)\s/im);
    expect(LEGACY_TREATMENT_COVERAGE_SQL).not.toMatch(/amount_minor|currency|doctor_id|provider|consent|session_count|completed_at/);
  });
  it("does not rewrite the reviewed0041 and original0042 migration bytes", () => {
    expect(blob("migrations/0041_invoice_clinical_linkage.sql")).toBe("014ef89c56378cbbad389286c161c6c2b2286513");
    // This literal is the Git blob hash of the unchanged original0042 source, not an executed schema claim.
    expect(blob("migrations/0042_legacy_treatment_agreements.sql")).toBe("6d4bedc0ab7acb8da890f122908c172ed53a8de9");
  });
  it("binds a unique immutable snapshot to its agreement service and anchor", () => {
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("agreement_id          INTEGER PRIMARY KEY REFERENCES legacy_treatment_agreements(id) ON DELETE CASCADE");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("NEW.service_id IS DISTINCT FROM agreement_service");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("NEW.anchor_tooth_code IS DISTINCT FROM agreement_anchor");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("BEFORE INSERT OR UPDATE OR DELETE ON legacy_treatment_coverage_snapshots");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("updates and standalone deletes are forbidden");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("WHERE id = OLD.agreement_id");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("recorded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("format_version = 1");
  });
  it("requires complete canonical arrays and preserves category, scope and surface distinctions", () => {
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("teeth = ARRAY(SELECT DISTINCT tooth FROM unnest(teeth) AS tooth ORDER BY tooth)");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("cardinality(teeth) BETWEEN 0 AND 32");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("anchor = ANY(teeth)");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("surfaces ~ '^M?D?O?B?L?$'");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("WHEN category = 'whitening'");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("scope IN ('upper', 'lower', 'both')");
    expect(LEGACY_TREATMENT_COVERAGE_SQL).toContain("scope IN ('upper', 'lower', 'full_mouth')");
  });
});
