import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), connect: vi.fn(), ensure: vi.fn(), classify: vi.fn(), reference: vi.fn() }));
vi.mock("../lib/db", () => ({ ensureSchema: mocks.ensure, getPool: () => ({ connect: mocks.connect }),
  ORTHO_CASE_FUNDED_SQL: "existing_funded_predicate", orthoAdjustmentBillingClass: mocks.classify }));
vi.mock("../lib/ortho-financial-reference-db", () => ({ readCaseFinancialReference: mocks.reference }));
import { patientLegacyOnboarding } from "../lib/legacy-onboarding-db";
const client = { query: mocks.query, release: mocks.release };
const ref = { state: "linked" as const, clinicalCaseIds: [904], hasRecordedSchedule: false,
  sources: [{ kind: "invoice" as const, sourceId: 906, planId: 902, planItemId: 903, clinicalCaseId: 904, current: true }] };
beforeEach(() => {
  vi.clearAllMocks(); mocks.ensure.mockResolvedValue(undefined); mocks.connect.mockResolvedValue(client);
  mocks.reference.mockResolvedValue(ref); mocks.classify.mockResolvedValue("OUTSIDE_CONTRACT");
  mocks.query.mockImplementation(async (sql: string) => sql.startsWith("SELECT c.id") ? { rows: [{ id: 905, baseline_kind: "legacy",
    legacy_financial_mode: "installments", opening_currencies: ["SAR"], arrangement_currencies: [], funded_plan: true }] } : { rows: [] });
});
describe("case-reference/classifier snapshot", () => {
  it("uses the exported signing classifier, not a second funding engine, in the same read-only snapshot", async () => {
    const result = await patientLegacyOnboarding(901, 905);
    expect(mocks.query.mock.calls[0]).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"]);
    expect(mocks.query.mock.calls[1]).toEqual([expect.stringContaining("c.id = $2"), [901, 905]]);
    expect(mocks.reference).toHaveBeenCalledWith(client, 901, 905);
    expect(mocks.classify).toHaveBeenCalledWith(client, 905, 901);
    expect(result).toMatchObject({ caseId: 905, complete: true, financialReference: ref, adjustmentClass: "OUTSIDE_CONTRACT" });
    expect(result?.warning).toContain("لا يثبت وحده شمول هذه الشدّة");
    expect(mocks.query.mock.calls.at(-1)).toEqual(["COMMIT"]); expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith(false);
    expect(mocks.ensure.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[0]);
    expect(mocks.query.mock.calls.every(([sql]) => /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SELECT|COMMIT)$/.test(sql) || sql.startsWith("SELECT"))).toBe(true);
  });
  it("does not substitute a latest sibling when the requested exact case is absent", async () => {
    mocks.query.mockResolvedValue({ rows: [] }); expect(await patientLegacyOnboarding(901, 999)).toBeNull();
    expect(mocks.reference).not.toHaveBeenCalled(); expect(mocks.classify).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[1][1]).toEqual([901, 999]); expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it("rolls back a failed read without returning a false missing source", async () => {
    mocks.classify.mockRejectedValue(new Error("Synthetic snapshot failure"));
    await expect(patientLegacyOnboarding(901, 905)).rejects.toThrow("Synthetic snapshot failure");
    expect(mocks.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]); expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith(false);
  });
  it("discards the client if rollback fails and preserves the original read error", async () => {
    const readError = new Error("Synthetic snapshot failure");
    const originalQuery = mocks.query.getMockImplementation()!;
    mocks.classify.mockRejectedValue(readError);
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("Synthetic rollback failure");
      return originalQuery(sql);
    });
    await expect(patientLegacyOnboarding(901, 905)).rejects.toBe(readError);
    expect(mocks.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(mocks.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each([[0, 905], [901, 0], [NaN, 905]])("rejects invalid identifiers %s/%s before bootstrap or SQL", async (patient, ortho) => {
    await expect(patientLegacyOnboarding(patient, ortho)).rejects.toThrow("Invalid case identity");
    expect(mocks.ensure).not.toHaveBeenCalled(); expect(mocks.connect).not.toHaveBeenCalled();
  });
});
