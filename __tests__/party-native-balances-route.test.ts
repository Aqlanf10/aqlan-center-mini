import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  requireSession: vi.fn(), createPayable: vi.fn(), getParty: vi.fn(), getSettings: vi.fn(),
  partyBalances: vi.fn(), partyNativeBalanceSnapshot: vi.fn(), partyStatement: vi.fn(), recordAudit: vi.fn(),
}));
vi.mock("../lib/session", () => ({ requireSession: boundary.requireSession }));
vi.mock("../lib/db", () => ({
  createPayable: boundary.createPayable, getParty: boundary.getParty, getSettings: boundary.getSettings,
  partyBalances: boundary.partyBalances, partyNativeBalanceSnapshot: boundary.partyNativeBalanceSnapshot,
  partyStatement: boundary.partyStatement, recordAudit: boundary.recordAudit,
}));
import { GET } from "../app/api/payables/route";

const native = [
  { partyId: 1, name: "Synthetic lab", kind: "lab", currency: "USD", dueMinor: 1234 },
  { partyId: 1, name: "Synthetic lab", kind: "lab", currency: "SAR", dueMinor: -500 },
];
const partyIdentities = [{ id: 1, name: "Synthetic lab", kind: "lab" }, { id: 2, name: "Zero supplier", kind: "supplier" }];
const snapshot = { partyIdentities, balancesByCurrency: native };
const legacy = [{ partyId: 1, partyName: "Synthetic lab", kind: "lab", owedMinor: 60000, paidMinor: 50000, dueMinor: 10000 }];
const request = (query = "view=party-balances-v1") => GET(new Request(`https://synthetic.invalid/api/payables?${query}`));
const noReads = () => {
  for (const name of ["partyBalances", "partyNativeBalanceSnapshot", "partyStatement", "getParty", "getSettings"] as const) {
    expect(boundary[name]).not.toHaveBeenCalled();
  }
};
beforeEach(() => {
  vi.resetAllMocks();
  boundary.requireSession.mockResolvedValue({ username: "synthetic-admin", role: "admin" });
  boundary.partyNativeBalanceSnapshot.mockResolvedValue(snapshot);
  boundary.partyBalances.mockResolvedValue(legacy);
  boundary.getParty.mockResolvedValue({ id: 1, name: "Synthetic lab", kind: "lab", phone: null });
  boundary.partyStatement.mockResolvedValue({ payables: [], expenses: [], advances: [], totals: [] });
});

describe("versioned native party balance read", () => {
  it("preserves signed native rows and never reads or relabels the legacy base result", async () => {
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ view: "party-balances-v1", ...snapshot, observedAt: expect.any(String) });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(boundary.partyNativeBalanceSnapshot).toHaveBeenCalledExactlyOnceWith();
    expect(boundary.partyBalances).not.toHaveBeenCalled();
    expect(boundary.getSettings).not.toHaveBeenCalled();
    expect(boundary.createPayable).not.toHaveBeenCalled();
    expect(boundary.recordAudit).not.toHaveBeenCalled();
  });

  it("returns explicit empty native rows only when the canonical read succeeds empty", async () => {
    boundary.partyNativeBalanceSnapshot.mockResolvedValue({ partyIdentities, balancesByCurrency: [] });
    expect(await (await request()).json()).toMatchObject({ view: "party-balances-v1", partyIdentities, balancesByCurrency: [] });
  });

  it("does not disguise a failed canonical read as zero or fall back to base equivalents", async () => {
    boundary.partyNativeBalanceSnapshot.mockRejectedValue(new Error("Synthetic private database detail"));
    const response = await request();
    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ message: "تعذّر تحميل المستحقات." });
    expect(boundary.partyBalances).not.toHaveBeenCalled();
  });

  it("refuses an expired session before financial reads", async () => {
    boundary.requireSession.mockResolvedValue(null);
    expect((await request()).status).toBe(401); noReads();
  });

  it.each(["doctor", "assistant", "patient", "unknown"])("keeps %s denied before reads", async (role) => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-user", role });
    const response = await request();
    expect(response.status).toBe(403); noReads();
    expect(JSON.stringify(await response.json())).not.toMatch(/partyIdentities|balancesByCurrency|dueMinor|Synthetic lab|Zero supplier|USD|SAR/);
  });

  it.each(["admin", "reception", "accountant", "cashier"])("preserves existing handler-level %s admission, with unchanged proxy gates", async (role) => {
    boundary.requireSession.mockResolvedValue({ username: "synthetic-user", role });
    expect((await request()).status).toBe(200);
  });

  it.each(["view=", "view=unknown", "view=party-balances-v1&view=party-balances-v1",
    "view=party-balances-v1&partyId=1", "view=party-balances-v1&partyId=", "view=party-balances-v1&currency=USD"])(
    "rejects ambiguous native scope %s before reads", async (query) => {
      expect((await request(query)).status).toBe(400); noReads();
    },
  );

  it("retains the no-view base DTO for existing consumers", async () => {
    expect(await (await request("")).json()).toEqual({ balances: legacy, baseCurrency: "YER" });
    expect(boundary.partyNativeBalanceSnapshot).not.toHaveBeenCalled();
  });

  it("retains the detailed statement contract without a new native-list query", async () => {
    expect(await (await request("partyId=1")).json()).toEqual({
      payables: [], expenses: [], advances: [], totals: [], baseCurrency: "YER",
      party: { id: 1, name: "Synthetic lab", kind: "lab", phone: null },
    });
    expect(boundary.partyNativeBalanceSnapshot).not.toHaveBeenCalled();
    expect(boundary.partyBalances).not.toHaveBeenCalled();
  });
});
