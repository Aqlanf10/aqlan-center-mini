import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), ensure: vi.fn() }));
vi.mock("../lib/db", () => ({
  ensureSchema: mocks.ensure,
  getPool: () => ({ connect: async () => ({ query: mocks.query, release: mocks.release }) }),
  PLAN_ITEM_FINANCIAL_REVIEW_SQL: "false",
  PLAN_ITEM_INVOICE_LINEAGE_SQL: "false",
  PLAN_ITEM_LEGACY_LINEAGE_SQL: "false",
  PLAN_ITEM_LEGACY_CONTEXT_SQL: "NULL",
}));
vi.mock("../lib/legacy-balance-arrangements-db", () => ({ openingPosition: vi.fn() }));
vi.mock("../lib/invoice-currency-evidence", () => ({ attachCurrencyReclassifications: vi.fn() }));
import { listTreatmentFinancialReferences } from "../lib/treatment-financial-context-db";

beforeEach(() => { vi.resetAllMocks(); });

describe("canonical treatment financial snapshot cleanup (synthetic, no database)", () => {
  it("preserves the read error and releases exactly once after a successful rollback", async () => {
    const failure = new Error("Synthetic financial source unavailable");
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT")) throw failure;
      return { rows: [] };
    });
    await expect(listTreatmentFinancialReferences(17)).rejects.toBe(failure);
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT id FROM patients WHERE id = $1",
      "ROLLBACK",
    ]);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("discards a rollback-failed client instead of returning a broken snapshot to the pool", async () => {
    const failure = new Error("Synthetic financial source unavailable");
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT")) throw failure;
      if (sql === "ROLLBACK") throw new Error("Synthetic rollback failure");
      return { rows: [] };
    });
    await expect(listTreatmentFinancialReferences(17)).rejects.toBe(failure);
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT id FROM patients WHERE id = $1",
      "ROLLBACK",
    ]);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("commits an absent patient snapshot and returns the healthy client normally", async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await expect(listTreatmentFinancialReferences(17)).resolves.toBeNull();
    expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SELECT id FROM patients WHERE id = $1",
      "COMMIT",
    ]);
    expect(mocks.release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
