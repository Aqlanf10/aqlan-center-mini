import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  query: vi.fn(),
  grants: new Set<string>(),
  patientScope: { kind: "all" } as { kind: "all" | "own"; clinicianPartyId?: number },
}));
vi.mock("../lib/canonical-read-snapshot", () => ({
  runCanonicalReadSnapshot: async (_session: unknown, action: string, read: (query: unknown, scope: unknown) => unknown) => {
    expect(action).toBe("read:lab.events");
    return read({ query: state.query }, { patientScope: state.patientScope, granted: (capability: string) => state.grants.has(capability) });
  },
}));
import { readCanonicalLabEvents } from "../lib/canonical-lab-orders";

const settlement = "تمت التسوية المالية المجمعة بسند صرف رقم SYN-VOUCHER-42 بمبلغ 987654 USD";
const reversal = "أُبطل سند التسوية SYN-VOUCHER-42 بقيد SYN-REV-43: legacy arbitrary reason 987654 USD";
const accounting = "تم تحديث الربط المحاسبي إلى حساب [SYN-EXP-5100] وذمم [SYN-PAY-2100]";
const clinical = ["create", "status_change", "due_date_change", "quality_check", "marked_for_remake", "created_as_remake", "prescription_completed", "prescription_draft_saved", "work_intent_materialized"];
const financial = ["accounting_posted", "accounting_updated", "financial_settlement", "financial_settlement_reversed"];
const events = [
  ...clinical.map(action => ({ action, notes: `Clinical note: ${action}, tooth 14, shade A2` })),
  ...financial.map(action => ({ action, notes: action === "financial_settlement" ? settlement : action === "financial_settlement_reversed" ? reversal : accounting })),
  { action: "unclassified_historical_action", notes: "SYN-UNKNOWN-AMOUNT 123456 USD" },
].map((event, i) => ({ id: i + 1, lab_order_id: 7, ...event, from_status: "sent", to_status: "received", actor: "synthetic-actor", actor_role: "admin", created_at: new Date("2026-11-01T12:00:00Z") }));
const session = {} as Parameters<typeof readCanonicalLabEvents>[0];
const read = () => readCanonicalLabEvents(session, "7");

beforeEach(() => {
  state.grants.clear();
  state.patientScope = { kind: "all" };
  state.query.mockReset().mockImplementation(async (sql: string) => {
    if (sql === "SELECT patient_id FROM lab_orders WHERE id = $1") return { rows: [{ patient_id: 41 }] };
    if (sql.includes("FROM patients")) return { rows: [{ inside: true }] };
    if (sql.includes("FROM lab_order_tracking")) return { rows: structuredClone(events) };
    throw new Error(`Unexpected query: ${sql}`);
  });
});

describe("canonical lab event financial projection (real tracking-row mapper)", () => {
  it("preserves every known clinical event and note without granting any financial details", async () => {
    const result = await read();
    expect(result.events.map(event => event.action)).toEqual(clinical);
    expect(result.events.map(event => event.notes)).toEqual(events.slice(0, clinical.length).map(event => event.notes));
    for (const secret of ["987654", "USD", "SYN-VOUCHER", "SYN-REV", "SYN-EXP", "SYN-PAY", "SYN-UNKNOWN"]) expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each(["finance.expenses.view", "finance.payables.record", "finance.lab-prices.edit"])("%s alone is not permission to read lab costs/accounting history", async grant => {
    state.grants.add(grant);
    expect((await read()).events.map(event => event.action)).toEqual(clinical);
  });

  it.each(["all", "own"] as const)("keeps same-order accounting notes for cost viewers with %s scope", async kind => {
    state.patientScope = { kind, clinicianPartyId: 81 };
    state.grants.add("finance.cost-prices.view");
    const result = await read();
    expect(result.events.filter(event => event.action.startsWith("accounting_")).map(event => event.notes)).toEqual([accounting, accounting]);
  });

  it("cost visibility alone never grants the voucher/opaque settlement or reversal notes", async () => {
    state.grants.add("finance.cost-prices.view");
    const result = await read();
    expect(result.events.filter(event => event.action.startsWith("financial_")).map(event => event.notes)).toEqual([null, null]);
    expect(JSON.stringify(result)).not.toMatch(/987654|SYN-VOUCHER|SYN-REV/);
  });

  it("even both finance grants never expose cross-patient batch totals to own scope", async () => {
    state.grants.add("finance.cost-prices.view");
    state.grants.add("finance.expenses.view");
    state.patientScope = { kind: "own", clinicianPartyId: 81 };
    const result = await read();
    expect(result.events.filter(event => event.action.startsWith("financial_")).map(event => event.notes)).toEqual([null, null]);
    expect(JSON.stringify(result)).not.toMatch(/987654|SYN-VOUCHER|SYN-REV/);
  });

  it("returns the unmodified settlement/reversal audit notes only with both grants and all scope", async () => {
    state.grants.add("finance.cost-prices.view");
    state.grants.add("finance.expenses.view");
    expect((await read()).events.filter(event => event.action.startsWith("financial_")).map(event => event.notes)).toEqual([settlement, reversal]);
  });

  it("unclassified historical/future event kinds fail closed until their visibility is classified", async () => {
    state.grants.add("finance.cost-prices.view");
    state.grants.add("finance.expenses.view");
    expect((await read()).events.some(event => event.action === "unclassified_historical_action")).toBe(false);
  });

  it("does not alter stored history while projecting it", async () => {
    const before = structuredClone(events);
    await read();
    expect(events).toEqual(before);
    expect(state.query.mock.calls.every(([sql]) => /^\s*SELECT\b/.test(sql))).toBe(true);
  });

  it("still refuses missing and out-of-scope orders before reading their history", async () => {
    state.query.mockResolvedValue({ rows: [] });
    await expect(read()).rejects.toMatchObject({ code: "lab_order_not_found", status: 404 });
    expect(state.query).toHaveBeenCalledTimes(1);
    state.patientScope = { kind: "own", clinicianPartyId: 81 };
    state.query.mockClear().mockImplementation(async (sql: string) => ({ rows: sql === "SELECT patient_id FROM lab_orders WHERE id = $1" ? [{ patient_id: 41 }] : [] }));
    await expect(read()).rejects.toMatchObject({ code: "lab_order_not_found", status: 404 });
    expect(state.query.mock.calls.some(([sql]) => sql.includes("lab_order_tracking"))).toBe(false);
  });
});
