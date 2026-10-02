import { beforeEach, describe, expect, it, vi } from "vitest";
import { hasManualCashLine, MANUAL_CASH_ENTRY_GUIDANCE, ManualCashEntryConflictError } from "../lib/manual-cash-entry";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(), createManualEntry: vi.fn(), isPeriodLocked: vi.fn(), recordAudit: vi.fn(),
}));
vi.mock("@/lib/session", () => ({ requireSession: mocks.requireSession }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", ManualEntryInvalidError: class extends Error {},
  createManualEntry: mocks.createManualEntry, isPeriodLocked: mocks.isPeriodLocked,
  recordAudit: mocks.recordAudit, journalEntries: vi.fn(),
}));
import { POST } from "../app/api/accounting/route";

const payload = (accountCode = "1101") => ({
  date: "2026-10-02", description: "Synthetic manual journal",
  lines: [
    { accountCode, currency: "YER", amount: "1000", side: "debit" },
    { accountCode: "3101", currency: "YER", amount: "1000", side: "credit" },
  ],
});
const request = (body = payload()) => new Request("http://localhost/api/accounting", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireSession.mockResolvedValue({ username: "synthetic-admin", role: "admin" });
  mocks.isPeriodLocked.mockResolvedValue(false);
  mocks.createManualEntry.mockResolvedValue(7);
});

describe("manual cash classification is a prospective account boundary", () => {
  it.each(["1101", "1102", "1103"])("recognizes physical cash account %s without date/currency/net assumptions", (accountCode) => {
    expect(hasManualCashLine([{ accountCode }])).toBe(true);
  });
  it("does not classify bank or other leaf accounts as physical drawer cash", () => {
    expect(hasManualCashLine(["1111", "1112", "1113", "3101", "5901"].map((accountCode) => ({ accountCode })))).toBe(false);
    expect(hasManualCashLine([])).toBe(false);
  });
  it("states the temporary restriction on legitimate historical corrections and openings", () => {
    expect(MANUAL_CASH_ENTRY_GUIDANCE).toContain("حماية مؤقتة");
    expect(MANUAL_CASH_ENTRY_GUIDANCE).toContain("تصحيحات الفترات السابقة والأرصدة الافتتاحية");
  });
});

describe("real manual journal route maps domain conflicts without recording success", () => {
  it.each(["manual_cash_requires_linked_movement", "manual_cash_shift_busy"] as const)("returns typed Arabic409 for %s and writes no success audit", async (code) => {
    const error = new ManualCashEntryConflictError(code);
    mocks.createManualEntry.mockRejectedValue(error);
    const response = await POST(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code, message: error.message });
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
  it("preserves normal bank-only save and audit", async () => {
    const response = await POST(request(payload("1111")));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: 7 });
    expect(mocks.recordAudit).toHaveBeenCalledOnce();
  });
  it("keeps unrelated database failures generic", async () => {
    mocks.createManualEntry.mockRejectedValue(new Error("private database detail"));
    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private database");
    expect(mocks.recordAudit).not.toHaveBeenCalled();
  });
  it("retains API period lock refusal before the writer", async () => {
    mocks.isPeriodLocked.mockResolvedValue(true);
    expect((await POST(request())).status).toBe(409);
    expect(mocks.createManualEntry).not.toHaveBeenCalled();
  });
  it.each(["accountant", "reception", "cashier"])("does not weaken the admin write boundary for %s", async (role) => {
    mocks.requireSession.mockResolvedValue({ username: "synthetic", role });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.createManualEntry).not.toHaveBeenCalled();
  });
});
