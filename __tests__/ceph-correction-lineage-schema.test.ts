import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CEPH_CORRECTION_LINEAGE_SQL } from "../lib/ceph-correction-lineage-schema";

describe("(ORTHO-ID-2) Ceph correction lineage schema", () => {
  it("keeps migration 0047 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0047_ceph_correction_lineage.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(CEPH_CORRECTION_LINEAGE_SQL.trim());
  });

  it("is additive only: no DROP/DELETE/UPDATE/INSERT, a nullable column without default", () => {
    expect(CEPH_CORRECTION_LINEAGE_SQL).not.toMatch(/DROP\s/i);
    expect(CEPH_CORRECTION_LINEAGE_SQL).not.toMatch(/^\s*(DELETE|UPDATE|INSERT)\s/im);
    // The new column itself is nullable with no default (the partial-index predicate legitimately says IS NOT NULL).
    expect(CEPH_CORRECTION_LINEAGE_SQL.split("\n")[0]).toBe("ALTER TABLE ceph_analyses ADD COLUMN IF NOT EXISTS corrects_analysis_id BIGINT;");
    expect(CEPH_CORRECTION_LINEAGE_SQL).not.toMatch(/DEFAULT/i);
    expect(CEPH_CORRECTION_LINEAGE_SQL.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(1);
    expect(CEPH_CORRECTION_LINEAGE_SQL).toMatch(/corrects_analysis_id < id/);
    expect(CEPH_CORRECTION_LINEAGE_SQL).toMatch(/FOREIGN KEY \(patient_id, corrects_analysis_id\) REFERENCES ceph_analyses \(patient_id, id\)/);
  });

  it("every statement is re-runnable", () => {
    for (const statement of CEPH_CORRECTION_LINEAGE_SQL.match(/^(ALTER TABLE ceph_analyses ADD COLUMN|CREATE (UNIQUE )?INDEX)[^;]*/gm) ?? []) {
      expect(statement).toMatch(/IF NOT EXISTS/);
    }
    expect(CEPH_CORRECTION_LINEAGE_SQL.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g)).toHaveLength(2);
  });
});
