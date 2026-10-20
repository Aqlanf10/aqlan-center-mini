import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ ensure: vi.fn(), connect: vi.fn(), query: vi.fn(), release: vi.fn(), walkout: vi.fn(), legacy: vi.fn(), due: vi.fn() }));
vi.mock("../lib/db", () => ({ CLINIC_TIME_ZONE: "Asia/Aden", ensureSchema: state.ensure,
  getPool: () => ({ connect: state.connect }), visitWalkout: state.walkout }));
vi.mock("../lib/legacy-balance-arrangements-db", () => ({ listLegacyBalanceArrangements: state.legacy }));
vi.mock("../lib/checkout-due-recommendation-db", () => ({ readCheckoutDueRecommendationInSnapshot: state.due }));
import { readVisitCheckout } from "../lib/checkout-db";
const client = { query: state.query, release: state.release };
const walkout = { patientId: 7, invoice: null, checkout: { previous: {}, current: { YER: 750 }, invoicePaidMinor: 0, paymentsToday: [], openingPaidToday: [] } };
beforeEach(() => { vi.clearAllMocks(); state.ensure.mockResolvedValue(undefined); state.connect.mockResolvedValue(client);
  state.query.mockReset().mockResolvedValue({ rows: [{ today: "2026-10-20" }] }); state.walkout.mockReset().mockResolvedValue(walkout);
  state.legacy.mockResolvedValue([]); state.due.mockReset().mockResolvedValue({ patientId: 7 }); });
describe("checkout reader owns a single complete money snapshot", () => {
  it("passes the same client and clinic date to every canonical reader", async () => {
    expect(await readVisitCheckout(10)).toMatchObject({ walkout, dueRecommendation: { patientId: 7 }, today: "2026-10-20" });
    expect(state.connect).toHaveBeenCalledTimes(1); expect(state.ensure).toHaveBeenCalledTimes(1);
    expect(state.walkout).toHaveBeenCalledWith(10, client); expect(state.legacy).toHaveBeenCalledWith(7, "2026-10-20", false, client);
    expect(state.due).toHaveBeenCalledWith(client, { patientId: 7, visitInvoiceId: null, today: "2026-10-20" });
    expect(state.query.mock.calls.map(call => call[0])).toEqual(["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "SELECT (NOW() AT TIME ZONE $1)::date::text AS today", "COMMIT"]);
    expect(state.query.mock.calls[1][1]).toEqual(["Asia/Aden"]); expect(state.release).toHaveBeenCalledWith(false);
  });
  it("does not invent source facts for a missing visit or walk-in without patient identity", async () => {
    state.walkout.mockResolvedValueOnce(null); expect(await readVisitCheckout(10)).toBeNull(); expect(state.due).not.toHaveBeenCalled();
    state.walkout.mockResolvedValueOnce({ ...walkout, patientId: null });
    expect(await readVisitCheckout(10)).toMatchObject({ dueRecommendation: null }); expect(state.due).not.toHaveBeenCalled();
  });
  it("rolls back the entire read on an unavailable recommendation, never returns zero", async () => {
    const failure = new Error("synthetic source read failure"); state.due.mockRejectedValue(failure);
    await expect(readVisitCheckout(10)).rejects.toBe(failure);
    expect(state.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK"); expect(state.release).toHaveBeenCalledWith(false);
  });
  it("destroys the connection if rollback itself fails, preserving the original error", async () => {
    const failure = new Error("synthetic read failure"); state.due.mockRejectedValue(failure);
    state.query.mockImplementation(async (sql: string) => { if (sql === "ROLLBACK") throw new Error("cleanup failure"); return { rows: [{ today: "2026-10-20" }] }; });
    await expect(readVisitCheckout(10)).rejects.toBe(failure); expect(state.release).toHaveBeenCalledWith(true);
  });
});
