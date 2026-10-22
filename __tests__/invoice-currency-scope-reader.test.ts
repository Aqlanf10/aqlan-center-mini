import { beforeEach, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { INVOICE_CURRENCY_SCOPE_MESSAGES } from "../lib/invoice-currency-scope";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), authority: vi.fn(), invoice: vi.fn(),
  position: vi.fn(), account: vi.fn(), catalog: vi.fn(), hash: vi.fn(),
}));
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", ensureSchema: vi.fn(),
  getPool: () => ({ connect: async () => ({ query: mocks.query, release: mocks.release }) }),
  getInvoice: mocks.invoice, correctInvoiceInTransaction: vi.fn(), getSettingsInTransaction: vi.fn(),
  insertAuditRow: vi.fn(), lockPlanItemsBilledBy: vi.fn(), recomputePlanTotal: vi.fn(),
}));
vi.mock("../lib/session", () => ({ revalidateSessionInTransaction: mocks.authority }));
vi.mock("../lib/debt-installments-db", () => ({
  DebtRepaymentError: class extends Error { constructor(public code: string, message: string) { super(message); } },
  debtRequestHash: mocks.hash, readDebtPosition: mocks.position, writeDebtRepaymentInTransaction: vi.fn(),
}));
vi.mock("../lib/debt-account-position", () => ({ debtAccountDue: mocks.account, lockDebtAccountForSchedule: vi.fn() }));
vi.mock("../lib/invoice-identity-amendments", () => ({ invoiceIdentityCatalog: mocks.catalog, validateInvoiceIdentityAmendments: vi.fn() }));
vi.mock("../lib/invoice-settlement-position", () => ({ readInvoiceSettlementPosition: async () => ({ lineageInvoiceIds: [11, 12] }) }));
vi.mock("../lib/invoice-currency-reclassification", () => ({ ReclassificationProofError: class extends Error {}, planCurrencyReclassification: vi.fn() }));
vi.mock("../lib/invoice-clinical-linkage", () => ({ invoiceQuantityAllowed: vi.fn() }));
vi.mock("../lib/debt-installments", () => ({ validateDebtRepaymentTerms: vi.fn() }));
vi.mock("../lib/invoice-correction", () => ({ planInvoiceRevision: vi.fn() }));
vi.mock("../lib/money", () => ({ parseAmount: vi.fn() }));
vi.mock("../lib/schedule", () => ({ clinicDateString: vi.fn() }));
vi.mock("../lib/invoice-correction-coverage", () => ({ INVOICE_APPROVED_WORK_SQL: "TRUE" }));
// Keep both the public reader and its currency adapter real: the adapter's thrown
// scope error must pass through contextInTx's actual catch into the GET projection.
import { readInvoiceRevision } from "../lib/invoice-revision-db";
const session = { role: "admin", username: "synthetic", userId: 1 } as SessionPayload;
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authority.mockResolvedValue(session);
  mocks.invoice.mockResolvedValue({ id: 12, patientId: 17, baseCurrency: "YER", items: [] });
  mocks.position.mockResolvedValue({ sourceSnapshot: { payments: [] }, settledMinor: 0, remainingMinor: 2500, settlementProofHash: "proof" });
  mocks.account.mockResolvedValue({ due: 2500 });
  mocks.catalog.mockResolvedValue({ services: [], doctors: [] });
  mocks.hash.mockReturnValue("source-hash");
});
it.each([
  ["PLAN_LINKED_LINEAGE", "plan_linked_lineage"],
  ["INDEPENDENT_ITEM_SOURCE", "independent_item_source"],
  ["ALREADY_RECLASSIFIED", "already_reclassified"],
] as const)("the actual reader catches and exposes %s without writes", async (reason, fact) => {
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes("AS plan_linked_lineage")) return { rows: [{ plan_linked_lineage: false, independent_item_source: false, already_reclassified: false, [fact]: true }] };
    if (sql.includes("AS bound")) return { rows: [{ bound: false }] };
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /^\s*SELECT\b/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected statement: ${sql}`);
  });
  const result = await readInvoiceRevision(12, session);
  expect(result.currencyCorrection).toEqual({ available: false, targetCurrency: "SAR", targets: [], options: [], settledMinor: 0, accountDueMinor: 0, reasonCodes: [reason], message: INVOICE_CURRENCY_SCOPE_MESSAGES[reason] });
  expect(mocks.hash).toHaveBeenCalledWith(expect.objectContaining({ currencyCorrection: result.currencyCorrection }));
  expect(mocks.authority).toHaveBeenCalledWith(session, expect.objectContaining({ query: mocks.query }));
  expect(mocks.authority.mock.invocationCallOrder[0]).toBeLessThan(mocks.invoice.mock.invocationCallOrder[0]);
  expect(mocks.query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  expect(mocks.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  expect(mocks.release).toHaveBeenCalledWith(false);
});
it.each([null, { role: "doctor" }])("rejects revoked/demoted admin before reading diagnostic facts", async current => {
  mocks.authority.mockResolvedValue(current);
  mocks.query.mockResolvedValue({ rows: [] });
  await expect(readInvoiceRevision(12, session)).rejects.toMatchObject({ code: "unauthorized" });
  expect(mocks.invoice).not.toHaveBeenCalled();
  expect(mocks.position).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual(["ROLLBACK"]);
  expect(mocks.release).toHaveBeenCalledWith(false);
});
