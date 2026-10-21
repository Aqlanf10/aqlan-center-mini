import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../lib/db";
import { legacyOnboarding } from "../lib/legacy-onboarding";
import { missingOrthoFinancialReference, readOrthoFinancialReference } from "../lib/ortho-financial-reference";
import { LEGACY_FINANCIAL_HINT, LEGACY_FINANCIAL_LABEL } from "../lib/ortho-baseline";

const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), user: vi.fn(), owns: vi.fn(), onboarding: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/legacy-onboarding-db", () => ({ patientLegacyOnboarding: mocks.onboarding }));
vi.mock("@/lib/db", () => ({
  doctorOwnsPatient: mocks.owns, findUserByUsername: mocks.user,
  PLAN_ITEM_FINANCIAL_REVIEW_SQL: "canonical_financial_review", PLAN_ITEM_INVOICE_LINEAGE_SQL: "canonical_invoice_lineage",
  PLAN_ITEM_LEGACY_LINEAGE_SQL: "canonical_legacy_lineage", PLAN_ITEM_LEGACY_CONTEXT_SQL: "canonical_legacy_context",
  PLAN_ITEM_LEGACY_COVERED_SQL: "canonical_legacy_covered", PLAN_ITEM_PREBILLED_SQL: "canonical_prebilled",
}));
import { readCaseFinancialReference } from "../lib/ortho-financial-reference-db";
import { GET } from "../app/api/patients/[id]/legacy-onboarding/route";

const historicalContext = () => ({ agreementCount: 1, agreementId: 908, serviceId: 8, anchorToothCode: null,
  snapshot: { agreement_id: 908, format_version: 1, service_id: 8, service_category: "ortho", anchor_tooth_code: null,
    snapshot_mode: "arch", snapshot_tooth_codes: [], snapshot_scope: "both", snapshot_surfaces: null,
    recorded_by: "synthetic-admin", recorded_at: "2026-10-01T00:00:00Z" } });
const item = () => ({ id: 903, plan_id: 902, case_id: 904, plan_status: "active", billed_invoice_id: 906 as number | null,
  invoice_lineage: true, legacy_lineage: false, financial_review: false, prebilled: true,
  legacy_covered: false, legacy_context: null as unknown, invoice_ids: [906], agreements: [] as { id: number; status: string }[],
  invoice_identity_conflict: false });
async function reference(rows = [item()], options: { cases?: number[]; schedule?: boolean } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT id FROM clinical_cases")) return { rows: (options.cases ?? [904]).map(id => ({ id })) };
    if (sql.includes("FROM plan_items i JOIN treatment_plans")) return { rows };
    if (sql.startsWith("SELECT EXISTS")) return { rows: [{ recorded: options.schedule === true }] };
    throw new Error("Unexpected/non-read SQL");
  });
  const result = await readCaseFinancialReference({ query } as unknown as DbClient, 901, 905);
  return { result, query };
}
const source = () => ({ state: "linked" as const, clinicalCaseIds: [904], hasRecordedSchedule: true,
  sources: [{ kind: "historical_agreement" as const, sourceId: 908, planId: 902, planItemId: 903, clinicalCaseId: 904, current: true }] });
const base = { legacy: true, financialMode: "installments" as const, openingCurrencies: ["SAR"], activeArrangementCurrencies: [], fundedPlan: false };

beforeEach(() => {
  vi.clearAllMocks(); mocks.session.mockResolvedValue({ username: "doctor-a", role: "doctor" });
  mocks.access.mockResolvedValue(true); mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: { canViewPlans: true } });
  mocks.owns.mockResolvedValue(true);
  mocks.onboarding.mockImplementation(async () => ({ caseId: 905,
    ...legacyOnboarding({ ...base, financialReference: source(), adjustmentClass: "LEGACY_INCLUDED" }) }));
});

describe("exact recorded source projection, not adjustment funding", () => {
  it("does not leave the obsolete plan-creation instruction in the static historical baseline", () => {
    expect(LEGACY_FINANCIAL_LABEL.installments).toBe("تحصيل المتبقي على أقساط");
    expect(LEGACY_FINANCIAL_HINT.installments).toContain("الفاتورة أو الاتفاق السابق هو أصل الالتزام");
    expect(Object.values(LEGACY_FINANCIAL_HINT).join(" ")).not.toMatch(/اربط خطة الأقساط|أنشئها من الخطط|لا تُفوتر الشدّات القادمة/);
  });
  it("recognizes invoice → item → exact clinical case without a legacy plan or schedule", async () => {
    const { result, query } = await reference();
    expect(result).toMatchObject({ state: "linked", hasRecordedSchedule: false,
      sources: [{ kind: "invoice", sourceId: 906, planId: 902, planItemId: 903, clinicalCaseId: 904, current: true }] });
    expect(query.mock.calls[0]).toEqual([expect.stringContaining("patient_id = $1 AND ortho_case_id = $2"), [901, 905]]);
    expect(query.mock.calls[1][0]).toContain("cc.patient_id = t.patient_id");
    expect(query.mock.calls[1][0]).toContain("cc.ortho_case_id = $2 AND i.category = 'ortho'");
    expect(query.mock.calls[1][0]).toContain("canonical_prebilled");
    expect(query.mock.calls[1][0]).toContain("ii.source_id IS DISTINCT FROM ii.plan_item_id");
    const projection = legacyOnboarding({ ...base, legacy: false, financialReference: result, adjustmentClass: "OUTSIDE_CONTRACT" });
    expect(projection.adjustmentClass).toBe("OUTSIDE_CONTRACT");
    expect(JSON.stringify(result)).not.toMatch(/amount|paid|remaining|total|currency|receipt/i);
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it("recognizes a scoped historical source without manufacturing an invoice or old plan", async () => {
    const historical = { ...item(), billed_invoice_id: null, invoice_lineage: false, invoice_ids: [], prebilled: false,
      legacy_lineage: true, legacy_covered: true, legacy_context: historicalContext(), agreements: [{ id: 908, status: "live" }] };
    const { result, query } = await reference([historical], { schedule: true });
    expect(result).toEqual(source());
    expect(query.mock.calls[2]).toEqual([expect.stringContaining("la.id = ANY($4::int[])"), [901, [], 905, [908]]]);
    expect(query.mock.calls[2][0]).toContain("lr.remaining_minor > 0 AND EXISTS");
    expect(query.mock.calls[2][0]).toContain("provenance.document_id = d.id AND provenance.opening_history_id IS NOT NULL");
    const onboarding = legacyOnboarding({ ...base, financialReference: result, adjustmentClass: "LEGACY_INCLUDED" });
    expect(onboarding).toMatchObject({ complete: true, adjustmentClass: "LEGACY_INCLUDED", warning: null });
    expect(onboarding.steps.some(step => step.key === "plan")).toBe(false);
    expect(onboarding.steps.find(step => step.key === "arrangement")?.label).toContain("الحساب المشترك، لا تخصيص لهذه الحالة");
  });
  it.each([
    { financial_review: true }, { prebilled: false }, { plan_status: "cancelled" }, { invoice_identity_conflict: true },
    { invoice_ids: [], billed_invoice_id: null },
  ])("retains review instead of claiming a clear source: %j", async changes => {
    const { result } = await reference([{ ...item(), ...changes }]);
    expect(result.state).toBe("review"); expect(result.sources.some(row => row.current)).toBe(false);
  });
  it("keeps a void or scope-unverified historical source review-only", async () => {
    for (const context of [null, historicalContext()]) {
      const { result } = await reference([{ ...item(), billed_invoice_id: null, invoice_lineage: false, invoice_ids: [], prebilled: false,
        legacy_lineage: true, legacy_covered: false, legacy_context: context, agreements: [{ id: 908, status: "void" }] }]);
      expect(result.state).toBe("review"); expect(result.sources[0].current).toBe(false);
    }
  });
  it("keeps cancelled origin documents as history beside a verified corrected source", async () => {
    const { result } = await reference([{ ...item(), billed_invoice_id: 916, invoice_ids: [906, 916] }]);
    expect(result.state).toBe("linked"); expect(result.sources.map(row => [row.sourceId, row.current])).toEqual([[906, false], [916, true]]);
  });
  it("does not infer a same-patient bridge or source, and rejects a contradictory response", async () => {
    const { result } = await reference([], { cases: [] }); expect(result).toEqual(missingOrthoFinancialReference());
    await expect(reference([item()], { cases: [914] })).rejects.toThrow("Invalid financial source");
  });
  it("allowlists nested values and rejects malformed, duplicate or inconsistent source payloads", () => {
    expect(readOrthoFinancialReference({ ...source(), secret: 999, sources: source().sources.map(row => ({ ...row, totalMinor: 123 })) })).toEqual(source());
    for (const invalid of [null, { ...source(), sources: [] }, { ...source(), state: "missing" },
      { ...source(), state: "restricted" }, { ...source(), sources: [...source().sources, ...source().sources] },
      { ...source(), clinicalCaseIds: [914] }, { ...source(), hasRecordedSchedule: "true" }]) {
      expect(() => readOrthoFinancialReference(invalid)).toThrow();
    }
  });
});

const read = (patient = "901", caseId = "905") => GET(new Request(`http://localhost/api/patients/${patient}/legacy-onboarding?caseId=${caseId}`), { params: Promise.resolve({ id: patient }) });
describe("money-free case reference permission boundary", () => {
  it.each(["admin", "reception", "doctor"])("returns exact reference for authorized %s without monetary fields", async role => {
    mocks.session.mockResolvedValue({ username: "reader", role }); const response = await read();
    expect(response.status).toBe(200); expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json(); expect(body.onboarding.financialReference).toEqual(source());
    expect(mocks.onboarding).toHaveBeenCalledWith(901, 905);
    expect(JSON.stringify(body)).not.toMatch(/agreedMinor|paidMinor|remainingMinor|totalMinor|paymentId|receiptId/);
  });
  it.each(["assistant", "no-plan-permission", "inactive", "unowned-global-clinical", "no-doctor-party"])("redacts references for %s without inventing missing linkage", async scenario => {
    if (scenario === "assistant") mocks.session.mockResolvedValue({ username: "reader", role: "assistant" });
    if (scenario === "no-plan-permission") mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: { canViewPlans: false } });
    if (scenario === "inactive") mocks.user.mockResolvedValue({ isActive: false, partyId: 7, permissions: { canViewPlans: true } });
    if (scenario === "no-doctor-party") mocks.user.mockResolvedValue({ isActive: true, partyId: null, permissions: { canViewPlans: true } });
    if (scenario === "unowned-global-clinical") {
      mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: { canViewPlans: true, canViewAllPatients: true } });
      mocks.owns.mockResolvedValue(false);
    }
    const body = await (await read()).json();
    expect(body.onboarding.adjustmentClass).toBe("LEGACY_INCLUDED");
    expect(body.onboarding.financialReference).toEqual({ state: "restricted", sources: [], clinicalCaseIds: [], hasRecordedSchedule: false });
    expect(JSON.stringify(body)).not.toMatch(/sourceId|planItemId|planId|مرجع مالي موثّق|جدول تحصيل/);
  });
  it("fails closed before source reads for expired session or inaccessible patient", async () => {
    mocks.session.mockResolvedValue(null); expect((await read()).status).toBe(401); expect(mocks.onboarding).not.toHaveBeenCalled();
    mocks.session.mockResolvedValue({ role: "doctor" }); mocks.access.mockResolvedValue(false);
    expect((await read()).status).toBe(403); expect(mocks.onboarding).not.toHaveBeenCalled();
  });
  it.each([["0", "905"], ["901", "0"], ["901", "bad"], ["901", "9007199254740992"]])("rejects malformed exact identities %s/%s", async (patient, caseId) => {
    expect((await read(patient, caseId)).status).toBe(400); expect(mocks.onboarding).not.toHaveBeenCalled();
  });
});
