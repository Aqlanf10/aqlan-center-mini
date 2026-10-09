import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), getSettings: vi.fn(), updateLabOrderAccounting: vi.fn(),
  deleteLabOrder: vi.fn(), getLabOrderById: vi.fn(), labOrderEvents: vi.fn(),
  recordAudit: vi.fn(), setLabOrderDueDate: vi.fn(), setLabOrderStatus: vi.fn(),
}));
// Run the actual route, body reader, role checks, amount parser, and settings
// resolver. Mock the complete database/session boundaries before module import.
// There is no db.ts import, SQL engine, server, or real network in this suite.
vi.mock("@/lib/db", () => ({
  getSettings: boundary.getSettings, updateLabOrderAccounting: boundary.updateLabOrderAccounting,
  deleteLabOrder: boundary.deleteLabOrder, getLabOrderById: boundary.getLabOrderById,
  labOrderEvents: boundary.labOrderEvents, recordAudit: boundary.recordAudit,
  setLabOrderDueDate: boundary.setLabOrderDueDate, setLabOrderStatus: boundary.setLabOrderStatus,
}));
vi.mock("@/lib/session", () => ({ requireSession: boundary.requireSession }));
import { PATCH } from "../app/api/lab/[id]/route";

const savedOrder = {
  id: 91001, costMinor: 2500, costCurrency: "USD", exchangeRate: 531.125,
  baseAmountMinor: 13001, payableId: 94001,
};
const mapping = {
  expenseCategoryId: 8, expenseAccountCode: "5102", payableAccountCode: "2102",
};
function patch(body: unknown) {
  return PATCH(new Request("http://synthetic.invalid/api/lab/91001", {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: "91001" }) });
}
function writerInput() {
  expect(boundary.updateLabOrderAccounting).toHaveBeenCalledTimes(1);
  expect(boundary.updateLabOrderAccounting.mock.calls[0][0]).toBe(91001);
  return boundary.updateLabOrderAccounting.mock.calls[0][1];
}

beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-finance", role: "admin" });
  boundary.getSettings.mockResolvedValue({ "finance.rate.USD": "600", "finance.rate.SAR": "150" });
  boundary.updateLabOrderAccounting.mockResolvedValue(savedOrder);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Network is forbidden in accounting route unit tests"); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  for (const unused of [boundary.deleteLabOrder, boundary.getLabOrderById, boundary.labOrderEvents,
    boundary.recordAudit, boundary.setLabOrderDueDate, boundary.setLabOrderStatus]) {
    expect(unused).not.toHaveBeenCalled();
  }
  vi.unstubAllGlobals();
});

describe("actual accounting PATCH boundary preserves omitted monetary intent", () => {
  it.each([
    ["update_accounting", undefined], ["post", true], ["unpost", false],
  ] as const)("%s forwards undefined money and never reads current settings", async (action, isPosted) => {
    // A settings outage must not affect an account-only change to an old snapshot.
    boundary.getSettings.mockRejectedValue(new Error("Synthetic settings unavailable"));
    const result = await patch({ action, ...mapping });
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual(savedOrder);
    expect(boundary.getSettings).not.toHaveBeenCalled();
    expect(writerInput()).toEqual({ ...mapping, isPosted,
      costMinor: undefined, costCurrency: undefined, exchangeRate: undefined,
      actor: "synthetic-finance", actorRole: "admin" });
  });

  it("retains the returned legacy base value exactly rather than deriving a replacement", async () => {
    const result = await patch({ action: "update_accounting", ...mapping });
    const returned = await result.json();
    expect(returned).toMatchObject({ costMinor: 2500, costCurrency: "USD",
      exchangeRate: 531.125, baseAmountMinor: 13001 });
    expect(returned.baseAmountMinor).not.toBe(13278);
    expect(boundary.getSettings).not.toHaveBeenCalled();
    expect(writerInput().exchangeRate).toBeUndefined();
    expect(writerInput().costMinor).toBeUndefined();
  });

  it.each(["admin", "reception", "cashier"])("keeps existing money-role boundary for %s", async (role) => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-finance", role });
    const result = await patch({ action: "update_accounting", ...mapping });
    expect(result.status).toBe(200);
    expect(writerInput()).toMatchObject({ actorRole: role });
    expect(boundary.getSettings).not.toHaveBeenCalled();
  });

  it.each([null, "doctor", "accountant", "assistant"])("rejects absent or non-writing role %s before settings/writer", async (role) => {
    boundary.requireSession.mockResolvedValue(role ? { username: "synthetic-read-only", role } : null);
    const result = await patch({ action: "update_accounting", ...mapping });
    expect(result.status).toBe(role ? 403 : 401);
    expect(boundary.getSettings).not.toHaveBeenCalled();
    expect(boundary.updateLabOrderAccounting).not.toHaveBeenCalled();
  });
});

describe("actual accounting PATCH keeps existing current-settings ownership for explicit edits", () => {
  it("parses the same raw large decimal text reviewed by the component without a second serialization", async () => {
    const result = await patch({ action: "update_accounting", ...mapping,
      cost: "35184372088832.1953125", costCurrency: "SAR", expectedExchangeRate: 150 });
    expect(result.status).toBe(200);
    expect(writerInput()).toMatchObject({ costMinor: 3518437208883220,
      costCurrency: "SAR", exchangeRate: 150 });
    expect(writerInput().costMinor).not.toBe(3518437208883221);
  });

  it.each([
    ["USD", "30.25", 3025, 600], ["SAR", "30.25", 3025, 150], ["YER", "17500", 17500, 1],
  ] as const)("passes intended %s minor units and settings-owned rate to writer", async (costCurrency, cost, costMinor, exchangeRate) => {
    const result = await patch({ action: "update_accounting", ...mapping, cost, costCurrency,
      // Legacy callers cannot override the server-owned rate with a raw field.
      exchangeRate: 9999 });
    expect(result.status).toBe(200);
    expect(boundary.getSettings).toHaveBeenCalledTimes(1);
    expect(writerInput()).toEqual({ ...mapping, isPosted: undefined, costMinor,
      costCurrency, exchangeRate, actor: "synthetic-finance", actorRole: "admin" });
  });

  it.each([null, "bad", "-1", "900719925474099200"])("invalid explicit cost %s is rejected before settings and writer", async (cost) => {
    const result = await patch({ action: "update_accounting", ...mapping, cost, costCurrency: "USD" });
    expect(result.status).toBe(400);
    expect(boundary.getSettings).not.toHaveBeenCalled();
    expect(boundary.updateLabOrderAccounting).not.toHaveBeenCalled();
  });

  it("settings failure on an explicit edit cannot reach the accounting writer", async () => {
    boundary.getSettings.mockRejectedValue(new Error("Synthetic settings failure"));
    const result = await patch({ action: "update_accounting", ...mapping, cost: "30", costCurrency: "USD" });
    expect(result.status).toBe(500);
    expect(boundary.updateLabOrderAccounting).not.toHaveBeenCalled();
  });
});

describe("optional expected-rate fence never authorizes a caller-owned rate", () => {
  it.each([
    ["USD", 600], ["SAR", 150], ["YER", 1],
  ] as const)("accepts the current %s quote while passing only server-owned money to writer", async (costCurrency, expectedExchangeRate) => {
    const result = await patch({ action: "post", ...mapping, cost: "30", costCurrency,
      expectedExchangeRate, exchangeRate: 9999, baseAmountMinor: 123456 });
    expect(result.status).toBe(200);
    const input = writerInput();
    expect(input).toMatchObject({ isPosted: true, costCurrency, exchangeRate: expectedExchangeRate,
      costMinor: costCurrency === "YER" ? 30 : 3000 });
    expect(input).not.toHaveProperty("expectedExchangeRate");
    expect(input).not.toHaveProperty("baseAmountMinor");
  });

  it.each([null, "600", 0, -1, 1_000_001, 600.0000004])("rejects invalid expected rate %s before writer", async (expectedExchangeRate) => {
    const result = await patch({ action: "update_accounting", ...mapping,
      cost: "30", costCurrency: "USD", expectedExchangeRate });
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ code: "lab_accounting_rate_invalid" });
    expect(boundary.updateLabOrderAccounting).not.toHaveBeenCalled();
  });

  it.each([
    { label: "changed", settings: { "finance.rate.USD": "620" } },
    { label: "missing", settings: {} },
    { label: "nonpositive", settings: { "finance.rate.USD": "0" } },
    { label: "nonfinite", settings: { "finance.rate.USD": "Infinity" } },
    { label: "excessive", settings: { "finance.rate.USD": "1000001" } },
    { label: "unstorable precision", settings: { "finance.rate.USD": "600.0000004" } },
  ])("rejects $label current settings without falling back to historical FX", async ({ settings }) => {
    boundary.getSettings.mockResolvedValue(settings);
    const result = await patch({ action: "update_accounting", ...mapping,
      cost: "30", costCurrency: "USD", expectedExchangeRate: 600 });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code: "lab_accounting_rate_changed" });
    expect(boundary.updateLabOrderAccounting).not.toHaveBeenCalled();
  });

  it("quote-only fields cannot trigger monetary intent or a settings read", async () => {
    const result = await patch({ action: "unpost", ...mapping,
      expectedExchangeRate: 600, exchangeRate: 999, costCurrency: "SAR" });
    expect(result.status).toBe(200);
    expect(boundary.getSettings).not.toHaveBeenCalled();
    expect(writerInput()).toMatchObject({ isPosted: false,
      costMinor: undefined, costCurrency: undefined, exchangeRate: undefined });
  });
});
