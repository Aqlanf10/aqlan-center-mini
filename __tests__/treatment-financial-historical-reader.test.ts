import { beforeEach, describe, expect, it, vi } from "vitest";
import { historicalSnapshot } from "./treatment-financial-historical-fixture";

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), schema: vi.fn(), opening: vi.fn() }));
vi.mock("../lib/db", () => ({ ensureSchema: mocks.schema, getPool: () => ({ connect: async () => ({ query: mocks.query, release: mocks.release }) }),
  PLAN_ITEM_FINANCIAL_REVIEW_SQL: "false", PLAN_ITEM_INVOICE_LINEAGE_SQL: "false", PLAN_ITEM_LEGACY_LINEAGE_SQL: "true", PLAN_ITEM_LEGACY_CONTEXT_SQL: "NULL" }));
vi.mock("../lib/legacy-balance-arrangements-db", () => ({ openingPosition: mocks.opening }));
vi.mock("../lib/legacy-treatment-coverage", () => ({ legacyCoverageStateFromContext: () => ({ kind: "verified" }) }));
vi.mock("../lib/invoice-currency-evidence", () => ({ attachCurrencyReclassifications: async (_client: unknown, receipts: unknown[]) => receipts }));
import { listTreatmentFinancialReferences } from "../lib/treatment-financial-context-db";

type Raw = Record<string, unknown>;
let documentRows: Raw[];
let agreementRows: Raw[];
async function query(sql: string) {
  const source = historicalSnapshot();
  if (sql.includes("FROM legacy_treatment_documents d")) return { rows: documentRows };
  if (sql.includes("FROM legacy_treatment_agreements")) return { rows: agreementRows };
  if (sql.includes("FROM patients")) return { rows: [{ id: 10 }] };
  if (sql.includes("FROM treatment_plans t")) return { rows: source.plans.map((plan) => ({ id: plan.id, patient_id: 10,
    base_currency: plan.currency, total_minor: String(plan.totalMinor), status: plan.status, billing_mode: plan.billingMode, has_installments: false })) };
  if (sql.includes("FROM plan_items i")) return { rows: source.items.map((item) => ({ id: item.planItemId, plan_id: item.planId, patient_id: 10,
    case_id: item.clinicalCaseId, owned_case_id: item.clinicalCaseId, ortho_case_id: item.orthoCaseId, origin: item.origin, origin_invoice_id: null, billed_invoice_id: null,
    billing_status: item.billingStatus, financial_review: false, invoice_lineage: false, legacy_lineage: true, legacy_context: null })) };
  if (sql.includes("FROM patient_opening_balances")) return { rows: [{ currency: "YER" }] };
  return { rows: [] };
}
beforeEach(() => {
  vi.clearAllMocks();
  const source = historicalSnapshot();
  const revision = source.historicalDocuments![0].revision!;
  documentRows = [{ id: 30, patient_id: 10, currency: "YER", line_count: 2, revision_id: revision.id, version: revision.version,
    total_minor: String(revision.totalMinor), discount_minor: String(revision.discountMinor), previously_paid_minor: String(revision.previouslyPaidMinor),
    remaining_minor: String(revision.remainingMinor), historical_as_of: revision.historicalAsOf, lines: revision.lines }];
  agreementRows = source.legacyAgreements.map((agreement) => ({ id: agreement.id, patient_id: 10, plan_item_id: agreement.planItemId,
    case_id: agreement.clinicalCaseId, currency: agreement.currency, document_id: agreement.documentId, document_line: agreement.documentLine,
    agreed_minor: String(agreement.agreedMinor), previously_paid_minor: null, remaining_minor: null, historical_as_of: agreement.historicalAsOf,
    opening_history_id: null, opening_effect: "none", status: "live" }));
  mocks.query.mockImplementation(query);
  mocks.opening.mockResolvedValue({ openingMinor: 450000, settledMinor: 0, remainingMinor: 450000 });
});

describe("historical document read-only snapshot normalization (mocked DB, no connections)", () => {
  it("requests the latest exact revision and retains document-line NULL cash fields", async () => {
    const result = await listTreatmentFinancialReferences(10);
    expect(result?.historicalDocuments).toMatchObject([{ documentId: 30, version: 2, agreedMinor: 540000,
      previouslyPaidMinor: 90000, remainingAtRevisionMinor: 450000 }]);
    expect(result?.references.map((reference) => reference.historicalAgreements[0].previouslyPaidMinor)).toEqual([null, null]);
    expect(result?.references.map((reference) => reference.historicalAgreements[0].remainingAtRegistrationMinor)).toEqual([null, null]);
    const call = mocks.query.mock.calls.find(([sql]) => sql.includes("FROM legacy_treatment_documents d"))!;
    expect(call[0]).toMatch(/LEFT JOIN LATERAL[\s\S]*WHERE document_id = d.id ORDER BY version DESC LIMIT 1[\s\S]*WHERE d.patient_id = \$1/);
    expect(call[1]).toEqual([10]);
    expect(mocks.query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(mocks.query.mock.calls.every(([sql]) => /^(SELECT|BEGIN|COMMIT)/.test(sql))).toBe(true);
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it.each([null, "", "not-money"])("rejects malformed latest document total %s without falling back", async (value) => {
    documentRows[0].total_minor = value;
    await expect(listTreatmentFinancialReferences(10)).rejects.toThrow(/financial amount/);
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
    expect(mocks.query).not.toHaveBeenCalledWith("COMMIT");
  });
  it("keeps a missing latest revision visible as an error", async () => {
    documentRows[0].revision_id = null;
    await expect(listTreatmentFinancialReferences(10)).rejects.toThrow(/revision needs review/);
    expect(mocks.query).toHaveBeenCalledWith("ROLLBACK");
  });
  it("rejects stale or wrong-patient revision line membership", async () => {
    documentRows[0].lines = [{ agreementId: 20, planItemId: 2, planId: 1, caseId: 5,
      unitPriceMinor: 300000, discountMinor: 30000, netMinor: 270000 }, { agreementId: 999, planItemId: 8, planId: 1, caseId: 6,
      unitPriceMinor: 300000, discountMinor: 30000, netMinor: 270000 }];
    await expect(listTreatmentFinancialReferences(10)).rejects.toThrow(/ownership/);
  });
  it("reads old single-agreement values but rejects an unallocated NULL on that older shape", async () => {
    documentRows = [];
    agreementRows = [{ ...agreementRows[0], document_id: null, document_line: null, agreed_minor: "300000",
      previously_paid_minor: "120000", remaining_minor: "180000", opening_effect: "created", opening_history_id: 40 }];
    const result = await listTreatmentFinancialReferences(10);
    expect(result?.references[0].historicalAgreements[0]).toMatchObject({ documentId: null, previouslyPaidMinor: 120000, remainingAtRegistrationMinor: 180000 });
    agreementRows[0].previously_paid_minor = null;
    await expect(listTreatmentFinancialReferences(10)).rejects.toThrow(/amounts need review/);
  });
});
