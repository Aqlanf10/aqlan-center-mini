import { beforeEach, describe, expect, it, vi } from "vitest";

// docs/finance/EXPENSE_COMMANDS_0128.md §7: a canonical session never falls through to the legacy role path.
const state = vi.hoisted(() => ({
  selection: { kind: "none" } as { kind: string; handle?: unknown },
  legacyCalls: 0,
  command: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/staff-session-admission", () => ({ selectRequestStaffEnvelope: async () => state.selection }));
vi.mock("@/lib/session", () => ({ requireSession: async () => { state.legacyCalls++; return null; } }));
vi.mock("@/lib/canonical-expense-create", async () => {
  class CanonicalExpenseRefusal extends Error {
    constructor(readonly code: string, readonly status: number, message: string, readonly quote: unknown = null) { super(message); }
  }
  return { CanonicalExpenseRefusal, commandCanonicalExpenseCreate: state.command };
});
vi.mock("@/lib/db", () => ({}));
const { POST } = await import("../app/api/expenses/route");
const { CanonicalExpenseRefusal } = await import("@/lib/canonical-expense-create");
const post = (body: unknown, key: string | null = "syn-dispatch-key-01") => POST(new Request("https://synthetic.invalid/api/expenses", {
  method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) }, body: JSON.stringify(body) }));

beforeEach(() => { state.legacyCalls = 0; state.command.mockReset(); state.selection = { kind: "canonical", handle: { synthetic: true } }; });

describe("POST /api/expenses with a canonical session", () => {
  it("runs the canonical command with the body and key, and never the legacy session", async () => {
    state.command.mockResolvedValue({ expense: { id: 7, voucherNumber: "SYN-1" }, replayed: false });
    const response = await post({ amount: "1", createdBy: "forged" });
    expect(response.status).toBe(201);
    expect(state.command).toHaveBeenCalledWith({ synthetic: true }, { source: { amount: "1", createdBy: "forged" }, requestKey: "syn-dispatch-key-01" });
    expect(state.legacyCalls).toBe(0);
    expect(response.headers.get("Cache-Control")).toMatch(/no-store/);
  });
  it("answers a replay with 200 and the original voucher", async () => {
    state.command.mockResolvedValue({ expense: { id: 7 }, replayed: true });
    const response = await post({});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 7, replayed: true, existing: true });
  });
  it("refuses a missing key before the command", async () => {
    const response = await post({}, null);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe("expense_request_key_required");
    expect(state.command).not.toHaveBeenCalled();
    expect(state.legacyCalls).toBe(0);
  });
  it("maps a refusal to its status, code and Arabic message, with the drawer amount when relevant", async () => {
    state.command.mockRejectedValue(new CanonicalExpenseRefusal("exceeds_drawer_cash", 409, "المبلغ يتجاوز النقد", { drawer: { availableMinor: 50 } } as never));
    const response = await post({});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "exceeds_drawer_cash", message: "المبلغ يتجاوز النقد", drawerAvailableMinor: 50 });
    state.command.mockRejectedValue(new CanonicalExpenseRefusal("owner_private_requires_owner", 403, "للمالك وحده"));
    expect((await post({})).status).toBe(403);
  });
  it("answers a denied envelope with 401 and never tries the legacy session", async () => {
    state.selection = { kind: "denied" };
    expect((await post({})).status).toBe(401);
    expect(state.legacyCalls).toBe(0);
  });
});

describe("POST /api/expenses with no canonical session", () => {
  it("uses the legacy path", async () => {
    state.selection = { kind: "none" };
    expect((await post({})).status).toBe(401);
    expect(state.legacyCalls).toBe(1);
    expect(state.command).not.toHaveBeenCalled();
  });
});
