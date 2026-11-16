import { beforeEach, expect, it, vi } from "vitest";
import type { SessionPayload } from "../lib/auth";
import { INVOICE_CURRENCY_SCOPE_MESSAGES } from "../lib/invoice-currency-scope";

const mocks = vi.hoisted(() => ({
  query: vi.fn(), release: vi.fn(), authority: vi.fn(), invoice: vi.fn(),
  schema: vi.fn(), ensure: vi.fn(), connect: vi.fn(),
  position: vi.fn(), account: vi.fn(), catalog: vi.fn(), hash: vi.fn(),
}));
vi.mock("../lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", ensureSchema: mocks.ensure,
  getPool: () => ({ connect: mocks.connect }),
  getInvoice: mocks.invoice, correctInvoiceInTransaction: vi.fn(), getSettingsInTransaction: vi.fn(),
  insertAuditRow: vi.fn(), lockPlanItemsBilledBy: vi.fn(), recomputePlanTotal: vi.fn(),
}));
vi.mock("../lib/session", () => ({ revalidateLegacySessionReadOnlySnapshot: mocks.authority, revalidateSessionInTransaction: vi.fn() }));
vi.mock("../lib/legacy-staff-boundary", () => ({ readLegacyStaffSchema: mocks.schema }));
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
const session: SessionPayload = { role: "admin", username: "synthetic", userId: 1, expiresAt: Date.now() + 3_600_000, credentialVersion: "synthetic-reader-version" };
const lock = "SELECT pg_advisory_lock_shared(hashtextextended($1,0))";
const unlock = "SELECT pg_advisory_unlock_shared(hashtextextended($1,0)) AS unlocked";
const begin = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const fence = "aqlan.canonical.identity.substrate.v1:public";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.schema.mockResolvedValue("base");
  mocks.ensure.mockResolvedValue(undefined);
  mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
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
    if (sql === unlock) return { rows: [{ unlocked: true }] };
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
  expect(mocks.schema.mock.invocationCallOrder[0]).toBeLessThan(mocks.ensure.mock.invocationCallOrder[0]);
  expect(mocks.ensure.mock.invocationCallOrder[0]).toBeLessThan(mocks.connect.mock.invocationCallOrder[0]);
  expect(mocks.query.mock.calls[0]).toEqual([lock, [fence]]);
  expect(mocks.query.mock.calls[1]).toEqual([begin]);
  expect(mocks.query.mock.invocationCallOrder[1]).toBeLessThan(mocks.authority.mock.invocationCallOrder[0]);
  const commitIndex = mocks.query.mock.calls.findIndex(([sql]) => sql === "COMMIT");
  expect(commitIndex).toBeGreaterThan(1);
  expect(mocks.invoice.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[commitIndex]);
  expect(mocks.query.mock.calls.slice(-2)).toEqual([["COMMIT"], [unlock, [fence]]]);
  expect(mocks.query.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.release.mock.invocationCallOrder[0]);
  expect(mocks.release).toHaveBeenCalledWith(false);
});
it.each([null, { role: "doctor" }])("rejects revoked/demoted admin before reading diagnostic facts", async current => {
  mocks.authority.mockResolvedValue(current);
  mocks.query.mockImplementation(async (sql: string) => ({ rows: sql === unlock ? [{ unlocked: true }] : [] }));
  await expect(readInvoiceRevision(12, session)).rejects.toMatchObject({ code: "unauthorized" });
  expect(mocks.invoice).not.toHaveBeenCalled();
  expect(mocks.position).not.toHaveBeenCalled();
  expect(mocks.query.mock.calls.map(([sql]) => sql)).toEqual([lock, begin, "ROLLBACK", unlock]);
  expect(mocks.query.mock.calls[0]).toEqual([lock, [fence]]);
  expect(mocks.query.mock.calls.at(-1)).toEqual([unlock, [fence]]);
  expect(mocks.query.mock.invocationCallOrder[1]).toBeLessThan(mocks.authority.mock.invocationCallOrder[0]);
  expect(mocks.authority.mock.invocationCallOrder[0]).toBeLessThan(mocks.query.mock.invocationCallOrder[2]);
  expect(mocks.query.mock.invocationCallOrder[3]).toBeLessThan(mocks.release.mock.invocationCallOrder[0]);
  expect(mocks.release).toHaveBeenCalledWith(false);
});

it("original schema refusal cannot initialize or read financial facts", async () => {
  mocks.schema.mockRejectedValue(new Error("LEGACY_STAFF_AUTHORITY_SCHEMA_HELD"));
  await expect(readInvoiceRevision(12, session)).rejects.toThrow("LEGACY_STAFF_AUTHORITY_SCHEMA_HELD");
  expect(mocks.ensure).not.toHaveBeenCalled();
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(mocks.authority).not.toHaveBeenCalled();
  expect(mocks.invoice).not.toHaveBeenCalled();
  expect(mocks.position).not.toHaveBeenCalled();
  expect(mocks.query).not.toHaveBeenCalled();
});
