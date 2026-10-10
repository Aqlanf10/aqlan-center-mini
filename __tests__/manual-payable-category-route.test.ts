import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), createPayable: vi.fn(), getParty: vi.fn(), getSettings: vi.fn(),
  partyBalances: vi.fn(), partyNativeBalanceSnapshot: vi.fn(), partyStatement: vi.fn(), recordAudit: vi.fn(),
}));
vi.mock("../lib/session", () => ({ requireSession: boundary.requireSession }));
// Complete route DB surface: no actual pool, schema initialization or financial write.
vi.mock("../lib/db", () => ({
  createPayable: boundary.createPayable, getParty: boundary.getParty, getSettings: boundary.getSettings,
  partyBalances: boundary.partyBalances, partyNativeBalanceSnapshot: boundary.partyNativeBalanceSnapshot,
  partyStatement: boundary.partyStatement, recordAudit: boundary.recordAudit,
}));
import { POST } from "../app/api/payables/route";

const input = { partyId: 17, description: "Synthetic manual lab bill", amount: "100", currency: "USD", dueDate: "2026-11-15" };
const party = { id: 17, name: "Synthetic laboratory", kind: "lab", isActive: true };
const send = (overrides: Record<string, unknown> = {}) => POST(new Request("https://synthetic.invalid/api/payables", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, ...overrides }),
}));
const noWrite = () => {
  expect(boundary.createPayable).not.toHaveBeenCalled();
  expect(boundary.recordAudit).not.toHaveBeenCalled();
};
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ userId: 3, username: "synthetic-admin", role: "admin" });
  boundary.getParty.mockResolvedValue(party);
  boundary.getSettings.mockResolvedValue({ "finance.rate.USD": "530", "finance.rate.SAR": "140" });
  boundary.createPayable.mockImplementation(async (value) => ({
    ...value, id: 71, partyName: party.name, baseAmountMinor: 53000,
    settledMinor: 0, remainingMinor: value.amountMinor, sourceType: "operational",
  }));
  boundary.recordAudit.mockResolvedValue(undefined);
});

describe("manual payable category default follows the stored party", () => {
  it("classifies the current category-less manual lab form as lab and audits the saved result", async () => {
    const response = await send({ partyKind: "supplier", kind: "supplier", baseCurrency: "USD", exchangeRate: 9999 });
    expect(response.status).toBe(201);
    const saved = await response.json();
    expect(saved.category).toBe("lab");
    expect(boundary.getParty).toHaveBeenCalledExactlyOnceWith(17);
    expect(boundary.createPayable).toHaveBeenCalledExactlyOnceWith({
      partyId: 17, category: "lab", description: input.description, amountMinor: 10000,
      currency: "USD", baseCurrency: "YER", exchangeRate: 530, labOrderId: null,
      dueDate: "2026-11-15", createdBy: "synthetic-admin",
    });
    expect(boundary.recordAudit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: "payable.create", entity: "payable", entityId: 71,
      actor: "synthetic-admin", actorRole: "admin",
      details: expect.objectContaining({ التصنيف: "lab", العملة: "USD", المبلغ: 10000, سعر_الصرف: 530 }),
    }));
  });

  it.each([null, "", "   ", 123, false, {}, []].map((category) => ({ category })))("treats the legacy empty/non-string category $category as omitted", async ({ category }) => {
    expect((await send({ category })).status).toBe(201);
    expect(boundary.createPayable).toHaveBeenCalledWith(expect.objectContaining({ category: "lab" }));
  });

  it.each(["supplier", "doctor", "unrecognized historical kind"])("preserves the existing non-lab default for %s", async (kind) => {
    boundary.getParty.mockResolvedValue({ ...party, kind });
    expect((await send({ partyKind: "lab" })).status).toBe(201);
    expect(boundary.createPayable).toHaveBeenCalledWith(expect.objectContaining({ category: "supplier" }));
  });

  it.each(["materials", "commission", "supplier", "lab", "custom_category", "تصنيف مخصص"])("preserves an explicit %s category even for a lab", async (category) => {
    expect((await send({ category: `  ${category}  ` })).status).toBe(201);
    expect(boundary.createPayable).toHaveBeenCalledWith(expect.objectContaining({ category }));
  });

  it("retains the explicit category's existing 40-character trim/truncation contract", async () => {
    const category = "x".repeat(55);
    expect((await send({ category: ` ${category} ` })).status).toBe(201);
    expect(boundary.createPayable).toHaveBeenCalledWith(expect.objectContaining({ category: "x".repeat(40) }));
  });

  it("does not introduce an active-party restriction or change successful source values", async () => {
    boundary.getParty.mockResolvedValue({ ...party, isActive: false });
    expect((await send()).status).toBe(201);
    expect(boundary.createPayable).toHaveBeenCalledWith(expect.objectContaining({ partyId: 17, category: "lab" }));
  });

  it("uses each request's stored party and never a prior request's kind", async () => {
    await send();
    boundary.getParty.mockResolvedValue({ ...party, id: 18, kind: "supplier" });
    await send({ partyId: 18 });
    expect(boundary.createPayable.mock.calls.map(([value]) => [value.partyId, value.category])).toEqual([[17, "lab"], [18, "supplier"]]);
  });

  it.each([undefined, "materials"])("refuses a missing party before creating or auditing, explicit category %j", async (category) => {
    boundary.getParty.mockResolvedValue(null);
    const response = await send({ category });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ message: "الجهة غير موجودة." });
    noWrite();
  });

  it("sanitizes a failed party lookup rather than guessing a category or creating a payable", async () => {
    boundary.getParty.mockRejectedValue(new Error("sensitive DB diagnostic"));
    const response = await send();
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("sensitive DB diagnostic");
    noWrite();
  });
});

describe("manual payable existing admission and monetary contract", () => {
  it.each([null, "doctor", "accountant", "assistant", "unknown"])("rejects unauthenticated/denied %s before reads or writes", async (role) => {
    boundary.requireSession.mockResolvedValue(role ? { userId: 3, username: "synthetic", role } : null);
    expect((await send()).status).toBe(role ? 403 : 401);
    expect(boundary.getParty).not.toHaveBeenCalled();
    expect(boundary.getSettings).not.toHaveBeenCalled();
    noWrite();
  });

  // This is the direct-handler gate only. Existing proxy restrictions still
  // govern cashier HTTP access; no role-route or permission policy is changed.
  it.each(["admin", "reception", "cashier"])("retains the existing direct-handler canHandleMoney gate for %s", async (role) => {
    boundary.requireSession.mockResolvedValue({ userId: 3, username: "synthetic", role });
    expect((await send()).status).toBe(201);
    expect(boundary.createPayable).toHaveBeenCalledTimes(1);
  });

  it.each([
    { partyId: 0 }, { partyId: "invalid" }, { description: "" }, { description: "x".repeat(201) },
    { currency: "EUR" }, { amount: "0" }, { amount: "-1" }, { amount: "not money" },
  ])("retains validation before party lookup for %j", async (overrides) => {
    expect((await send(overrides)).status).toBe(400);
    expect(boundary.getParty).not.toHaveBeenCalled();
    noWrite();
  });

  it("retains malformed JSON rejection before lookup", async () => {
    const response = await POST(new Request("https://synthetic.invalid/api/payables", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad",
    }));
    expect(response.status).toBe(400);
    expect(boundary.getParty).not.toHaveBeenCalled();
    noWrite();
  });

  it("retains missing FX refusal before lookup or write", async () => {
    boundary.getSettings.mockResolvedValue({});
    expect((await send()).status).toBe(409);
    expect(boundary.getParty).not.toHaveBeenCalled();
    noWrite();
  });

  it.each([
    ["YER", "100", 100, 1], ["SAR", "12.34", 1234, 140], ["USD", "12.34", 1234, 530],
  ])("does not change %s minor units or server FX", async (currency, amount, amountMinor, exchangeRate) => {
    expect((await send({ currency, amount })).status).toBe(201);
    expect(boundary.createPayable).toHaveBeenCalledWith(expect.objectContaining({
      currency, amountMinor, exchangeRate, baseCurrency: "YER", category: "lab", labOrderId: null,
    }));
  });

  it("preserves failed create behavior without a success audit", async () => {
    boundary.createPayable.mockResolvedValue(null);
    expect((await send()).status).toBe(500);
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });
});
