import type { Client } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ report: vi.fn(), apply: vi.fn() }));
vi.mock("../lib/ortho-reconciliation", () => ({ reportOrthoReconciliation: calls.report, applySyntheticOrthoReconciliation: calls.apply }));
import { runOrthoOperatorSession } from "../lib/ortho-reconciliation-session";
const expected = { database: "synthetic", oid: "1", capability: "synthetic" };
beforeEach(() => { calls.report.mockReset().mockResolvedValue({ event: "report" }); calls.apply.mockReset().mockResolvedValue({ event: "applied" }); });
function connection() {
  return { on: vi.fn(), connect: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn().mockResolvedValue(undefined) };
}
describe("operator result and cleanup ordering", () => {
  it("withholds a read-only success until rollback and connection cleanup finish", async () => {
    const client = connection();
    let finish!: () => void;
    client.end.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    let returned = false;
    const operation = runOrthoOperatorSession(client as unknown as Client, { apply: false, expected }).then(result => { returned = true; return result; });
    await vi.waitFor(() => expect(client.end).toHaveBeenCalledOnce());
    expect(client.query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(returned).toBe(false);
    finish(); expect(await operation).toEqual({ event: "report" });
  });
  it("does not return the computed report if rollback fails", async () => {
    const client = connection();
    client.query.mockImplementation(async sql => { if (sql === "ROLLBACK") throw new Error("synthetic rollback failure"); return { rows: [] }; });
    await expect(runOrthoOperatorSession(client as unknown as Client, { apply: false, expected })).rejects.toThrow("synthetic rollback failure");
    expect(client.end).toHaveBeenCalledOnce();
  });
  it.each([false, true])("labels cleanup failure truthfully after report/commit (apply=%s)", async apply => {
    const client = connection(); client.end.mockRejectedValue(new Error("secret-bearing cleanup failure"));
    await expect(runOrthoOperatorSession(client as unknown as Client, { apply, expected })).rejects.toMatchObject({ message: "ORTHO_OPERATOR_CLEANUP_FAILED", outcome: apply ? "committed" : "read_only" });
  });
  it("does not claim rollback after an uncertain apply and failed cleanup", async () => {
    calls.apply.mockRejectedValue(new Error("synthetic lost acknowledgement"));
    const client = connection(); client.end.mockRejectedValue(new Error("synthetic cleanup failure"));
    await expect(runOrthoOperatorSession(client as unknown as Client, { apply: true, expected })).rejects.toMatchObject({ outcome: "unknown" });
  });
  it("cleans up a failed connection attempt without returning a report", async () => {
    const client = connection(); client.connect.mockRejectedValue(new Error("synthetic connect timeout"));
    await expect(runOrthoOperatorSession(client as unknown as Client, { apply: false, expected })).rejects.toThrow("synthetic connect timeout");
    expect(calls.report).not.toHaveBeenCalled(); expect(client.end).toHaveBeenCalledOnce();
  });
});
