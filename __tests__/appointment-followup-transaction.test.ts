import { expect, it, vi } from "vitest";
vi.mock("../lib/db", () => ({ getPool: vi.fn(), insertAuditRow: vi.fn(), CLINIC_TIME_ZONE: "Asia/Aden" }));
vi.mock("../lib/session", () => ({ revalidateSessionInTransaction: vi.fn() }));
vi.mock("../lib/patient-access", () => ({ canAccessPatient: vi.fn() }));
import { followupTransaction } from "../lib/appointment-followup-db";
import type { DbClient, DbPool } from "../lib/db";

function fixture(failAt?: string, releaseFails = false) {
  const original = new Error("synthetic original");
  const client = { query: vi.fn(async (sql: string) => {
    if (sql === failAt) throw original;
    return { rows: [] };
  }), release: vi.fn(() => { if (releaseFails) throw new Error("synthetic release"); }) };
  const pool = { connect: async () => client as DbClient } as DbPool;
  return { pool, client, original };
}
it("commits once and releases a healthy connection", async () => {
  const f = fixture(); expect(await followupTransaction(f.pool, async () => 7)).toBe(7);
  expect(f.client.query.mock.calls.map(args => args[0])).toEqual(["BEGIN", "COMMIT"]);
  expect(f.client.release).toHaveBeenCalledWith(false);
});
it.each(["BEGIN", "COMMIT"])("discards connection after uncertain %s", async step => {
  const f = fixture(step); await expect(followupTransaction(f.pool, async () => 7)).rejects.toBe(f.original);
  expect(f.client.release).toHaveBeenCalledWith(true);
});
it("preserves the work failure after rollback and release both fail", async () => {
  const f = fixture("ROLLBACK", true); const workError = new Error("synthetic audit failure");
  await expect(followupTransaction(f.pool, async () => { throw workError; })).rejects.toBe(workError);
  expect(f.client.release).toHaveBeenCalledWith(true);
});
it("rolls back a rejected write without committing", async () => {
  const f = fixture(); await expect(followupTransaction(f.pool, async () => { throw f.original; })).rejects.toBe(f.original);
  expect(f.client.query.mock.calls.map(args => args[0])).toEqual(["BEGIN", "ROLLBACK"]);
  expect(f.client.release).toHaveBeenCalledWith(false);
});
