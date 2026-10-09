import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Static composition contracts supplement, and never substitute for, isolated PostgreSQL tests. */
const db = readFileSync("lib/db.ts", "utf8");
const legacy = readFileSync("lib/legacy-treatment-db.ts", "utf8");

function sqlConstant(name: string): string {
  const value = db.match(new RegExp(`export const ${name}\\s*=\\s*\u0060([^\u0060]*)\u0060;`))?.[1];
  if (value === undefined) throw new Error(`Missing SQL contract: ${name}`);
  return value;
}

function functionBody(source: string, name: string): string {
  const start = source.search(new RegExp(`(?:export )?async function ${name}\\(`));
  if (start < 0) throw new Error(`Missing function: ${name}`);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/\n(?:export )?(?:async )?function /);
  return next < 0 ? tail : tail.slice(0, next + 1);
}

function lockingSql(body: string): string[] {
  // Inspect actual SQL template text rather than matching explanatory comments.
  return [...body.matchAll(/`([^`]*)`/g)].map((match) => match[1])
    .filter((query) => /\bFOR (?:NO KEY UPDATE|UPDATE|SHARE)\b/.test(query));
}

describe("legacy release composition contracts", () => {
  it("registers the additive runtime legacy schema after invoice linkage and before runtime legacy reads", () => {
    expect(db).toMatch(/import\s*\{\s*LEGACY_TREATMENT_SQL\s*\}\s*from\s*["']\.\/legacy-treatment-schema["']/);
    const ensure = db.indexOf("export function ensureSchema(");
    const invoiceSchema = db.indexOf("await getPool().query(INVOICE_LINKAGE_SQL)", ensure);
    const legacySchema = db.indexOf("await getPool().query(LEGACY_TREATMENT_SQL)", ensure);
    expect(ensure).toBeGreaterThanOrEqual(0);
    expect(invoiceSchema).toBeGreaterThan(ensure);
    expect(legacySchema).toBeGreaterThan(invoiceSchema);
    const firstLegacyRead = db.search(/\bFROM legacy_treatment_agreements\b/);
    expect(firstLegacyRead).toBeGreaterThan(legacySchema);
    expect(functionBody(legacy, "createLegacyTreatment")).toMatch(/await ensureSchema\(\)/);
    expect(functionBody(legacy, "voidLegacyTreatment")).toMatch(/await ensureSchema\(\)/);
  });

  it("keeps all-state historical identity separate from active coverage and invoice/provider provenance", () => {
    const history = sqlConstant("PLAN_ITEM_LEGACY_LINEAGE_SQL");
    expect(history).toMatch(/FROM legacy_treatment_agreements/);
    expect(history).toMatch(/plan_item_id\s*=\s*i\.id/);
    expect(history).not.toMatch(/\bstatus\s*=/);
    const coverage = sqlConstant("PLAN_ITEM_LEGACY_COVERED_SQL");
    expect(coverage).toMatch(/status\s*=\s*'live'/);
    for (const field of ["patient_id", "currency", "service_id", "tooth_code", "case_id", "agreed_minor"]) {
      expect(coverage).toContain(field);
    }
    const financial = sqlConstant("PLAN_ITEM_FINANCIAL_LINEAGE_SQL");
    expect(financial).toContain("PLAN_ITEM_INVOICE_LINEAGE_SQL");
    expect(financial).toContain("PLAN_ITEM_LEGACY_LINEAGE_SQL");
    expect(sqlConstant("PLAN_ITEM_INVOICE_LINEAGE_SQL")).not.toMatch(/LEGACY|legacy_treatment/);
    expect(sqlConstant("PLAN_ITEM_PREBILLED_SQL")).not.toMatch(/LEGACY|legacy_treatment/);
    expect(sqlConstant("PLAN_ITEM_PREBILLED_SQL")).toMatch(/invoices|invoice_items/);
    expect(sqlConstant("PLAN_ITEM_FINANCIAL_REVIEW_SQL")).toContain("PLAN_ITEM_LEGACY_LINEAGE_SQL");
    expect(sqlConstant("PLAN_ITEM_FINANCIAL_REVIEW_SQL")).toContain("PLAN_ITEM_LEGACY_COVERED_SQL");
  });

  it("does not fabricate current consent, receipts, invoices, providers or invoice lineage during registration", () => {
    const write = functionBody(legacy, "writeLegacyTreatment");
    expect(write).not.toMatch(/UPDATE treatment_plans SET consent_at/i);
    expect(write).not.toMatch(/INSERT\s+INTO\s+(?:invoices|invoice_items|payments|cashier_shifts)\b/i);
    expect(write).not.toMatch(/(?:billed_invoice_id|origin_invoice_id)\s*=/i);
    expect(write).not.toMatch(/SET\s+doctor_id\s*=/i);
    expect(write).toContain("primaryDoctorId: null");
    expect(write).toContain("setPatientOpeningBalanceInTx");
  });

  it("locks void in deterministic patient, plans, items, agreements order", () => {
    const queries = lockingSql(functionBody(legacy, "voidLegacyTreatment"));
    const patient = queries.findIndex((query) => /FROM patients\b/.test(query));
    const plans = queries.findIndex((query) => /FROM treatment_plans\b/.test(query));
    const items = queries.findIndex((query) => /FROM plan_items\b/.test(query));
    const agreement = queries.findIndex((query) => /FROM legacy_treatment_agreements\b/.test(query));
    expect(patient).toBe(0);
    expect(queries[patient]).toContain("FOR NO KEY UPDATE");
    expect(plans).toBeGreaterThan(patient);
    expect(items).toBeGreaterThan(plans);
    expect(agreement).toBeGreaterThan(items);
    expect(queries[plans]).toMatch(/ORDER BY (?:t\.)?id[\s\S]*FOR UPDATE/);
  });

  it("void preserves work records and review under the explicit two-level collection policy", () => {
    const body = functionBody(legacy, "voidLegacyTreatment");
    expect(body).toMatch(/billing_status\s*=\s*'needs_financial_review'/);
    expect(body).not.toMatch(/billing_status\s*=\s*'unbilled'/);
    expect(body).not.toMatch(/UPDATE\s+treatment_plans\s+SET\s+status\s*=\s*'cancelled'/i);
    expect(body).not.toMatch(/DELETE\s+FROM\s+(?:plan_items|treatment_sessions|clinical_cases|legacy_treatment_agreements)\b/i);
    expect(body).toContain("readLegacyVoidPreviewInTx");
    expect(body.indexOf("readLegacyVoidPreviewInTx")).toBeLessThan(body.indexOf('if (agreement.opening_effect !== "none")'));
    expect(body).toContain("preview_stale");
    expect(body).toContain("isAdmin(input.actorRole)");
    const policy = readFileSync("lib/legacy-treatment-void.ts", "utf8");
    expect(policy).toMatch(/facts\.netCollectionsMinor > 0 \? "opening_collected"/);
    expect(policy).toMatch(/after < facts\.netCollectionsMinor \? "opening_settled"/);
    const evidence = functionBody(legacy, "readLegacyVoidPreviewInTx");
    expect(evidence).toMatch(/FROM payments WHERE patient_id = \$1 AND opening_currency = \$2/);
    expect(evidence).not.toMatch(/JOIN payments/);
    expect(evidence).toContain("t.patient_id = $2");
  });
});
