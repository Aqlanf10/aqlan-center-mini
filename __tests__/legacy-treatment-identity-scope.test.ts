import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Read-only source contracts supplement the isolated PostgreSQL identity-drift regressions. */
const db = readFileSync("lib/db.ts", "utf8");
const invoice = readFileSync("lib/invoice-linkage-db.ts", "utf8");
const registration = readFileSync("lib/legacy-treatment-db.ts", "utf8");
function body(source: string, name: string) {
  const start = source.search(new RegExp(`(?:export )?(?:async )?function ${name}\\(`));
  if (start < 0) throw new Error(`Missing function: ${name}`);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

describe("immutable agreement patient/service selection", () => {
  it.each([
    { source: invoice, name: "inspectExistingWork" }, { source: invoice, name: "financialOnlyLineRefusal" },
    { source: registration, name: "decideLegacyTreatment" },
  ])("retains immutable identity in the $name reader", ({ source, name }) => {
    const reader = body(source, name);
    expect(reader).toMatch(/\(t\.patient_id = \$1 AND i\.service_id = \$2\) OR EXISTS/);
    const immutable = reader.match(/SELECT 1 FROM legacy_treatment_agreements legacy_identity([^)]*)\)/)?.[1];
    expect(immutable).toBeDefined();
    expect(immutable).toContain("legacy_identity.plan_item_id = i.id");
    expect(immutable).toContain("legacy_identity.patient_id = $1");
    expect(immutable).toContain("legacy_identity.service_id = $2");
    expect(immutable).not.toMatch(/(?:t\.patient_id|i\.service_id|\.status|\.currency|\.tooth_code)/);
  });

  it.each(["financialWorkIdentities", "unlinkedPlanSessionConflicts"])("projects immutable services before %s compares work", (name) => {
    const reader = body(db, name);
    expect(reader).toContain("SELECT i.id, work_identity.service_id");
    expect(reader).toMatch(/SELECT current_item\.id, current_item\.service_id[\s\S]*current_plan\.patient_id = \$1\s+UNION\s+SELECT legacy_identity\.plan_item_id, legacy_identity\.service_id/);
    expect(reader).toMatch(/FROM legacy_treatment_agreements legacy_identity\s+WHERE legacy_identity\.patient_id = \$1\s+\) work_identity ON work_identity\.id = i\.id/);
    expect(reader).not.toMatch(/legacy_identity\.(?:status|currency|tooth_code)\s*=/);
    expect(reader).toContain("PLAN_ITEM_FINANCIAL_LINEAGE_SQL");
    expect(reader).toContain("PLAN_ITEM_LEGACY_CONTEXT_SQL");
  });

  it("keeps moved-item clinical labels out of the original patient's signature warnings", () => {
    const reader = body(db, "unlinkedPlanSessionConflicts");
    expect(reader).toContain("i.tooth_code, work_identity.service_name");
    expect(reader).toContain("legacy_identity.plan_item_id, legacy_identity.service_id, legacy_identity.service_name");
    expect(reader).toMatch(/current_item\.service_name[\s\S]*current_plan\.patient_id = \$1/);
  });

  it("decides registration and its read-only preview with the same locked/unlocked reader", () => {
    expect(body(registration, "writeLegacyTreatment")).toContain("await decideLegacyTreatment(client, input, true)");
    const preview = body(registration, "previewLegacyTreatment");
    expect(preview).toContain("await decideLegacyTreatment(client, input, false)");
    expect(preview).toContain("READ ONLY");
    expect(preview).not.toMatch(/INSERT|UPDATE |DELETE|setPatientOpeningBalanceInTx|insertPlanV2InTx/);
  });

  it("patient-scopes the mutable historical case display join", () => {
    expect(registration).toContain("LEFT JOIN clinical_cases c ON c.id = a.case_id AND c.patient_id = a.patient_id");
  });

  it("retains the shared immutable scope resolver after identity selection", () => {
    expect(body(invoice, "inspectExistingWork")).toContain("legacyCoverageOverlaps(legacyCoverageStateFromContext(row.legacy_context), site)");
    expect(body(registration, "decideLegacyTreatment")).toContain("legacyCoverageOverlaps(coverage, site)");
    expect(body(db, "conflictsWithFinancialWork")).toContain("legacyCoverageOverlaps(legacyCoverageStateFromContext(prior.legacy_context)");
    expect(body(db, "unlinkedPlanSessionConflicts")).toContain("legacyCoverage: legacyCoverageStateFromContext(row.legacy_context)");
  });
});
