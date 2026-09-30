import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VISIT_CLEARANCE_SQL } from "../lib/visit-clearance-schema";

describe("(CHAIR-1) visit clearance schema", () => {
  it("keeps migration 0037 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0037_visit_clearance.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(VISIT_CLEARANCE_SQL.trim());
  });

  it("is additive only: two nullable visit columns, no DROP, no data rewrite, no status change", () => {
    expect(VISIT_CLEARANCE_SQL).not.toMatch(/DROP\s/i);
    expect(VISIT_CLEARANCE_SQL).not.toMatch(/^\s*(DELETE|UPDATE|INSERT)\s/im);
    expect(VISIT_CLEARANCE_SQL).not.toMatch(/NOT NULL|DEFAULT|CHECK|status/i);
    expect(VISIT_CLEARANCE_SQL.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(2);
    expect(VISIT_CLEARANCE_SQL).toMatch(/visits ADD COLUMN IF NOT EXISTS cleared_at TIMESTAMPTZ;/);
    expect(VISIT_CLEARANCE_SQL).toMatch(/visits ADD COLUMN IF NOT EXISTS cleared_by TEXT;/);
  });
});
