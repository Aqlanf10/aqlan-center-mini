import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ORTHO_BILLING_DECISION_SQL } from "../lib/ortho-billing-decision-schema";

describe("(P1-C) ortho adjustment billing decision schema", () => {
  it("keeps migration 0039 byte-equal to the runtime schema SQL", () => {
    const lines = readFileSync("migrations/0039_ortho_adjustment_billing_decision.sql", "utf8").split("\n");
    const index = lines.findIndex((line) => !line.startsWith("--"));
    expect(lines.slice(index).join("\n").trim()).toBe(ORTHO_BILLING_DECISION_SQL.trim());
  });

  it("is additive only: nullable columns, no DROP, no data rewrite, no default", () => {
    expect(ORTHO_BILLING_DECISION_SQL).not.toMatch(/DROP\s/i);
    expect(ORTHO_BILLING_DECISION_SQL).not.toMatch(/^\s*(DELETE|UPDATE|INSERT)\s/im);
    expect(ORTHO_BILLING_DECISION_SQL).not.toMatch(/NOT NULL|DEFAULT/i);
    expect(ORTHO_BILLING_DECISION_SQL.match(/ADD COLUMN IF NOT EXISTS/g)).toHaveLength(6);
    expect(ORTHO_BILLING_DECISION_SQL).toMatch(/CHECK \(billing_decision IN \('billed', 'no_charge'\)\)/);
  });
});
