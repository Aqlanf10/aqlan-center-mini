vi.mock("server-only", () => ({}));
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbClient, QueryResult } from "../lib/db";
import type { ReceiptRevision } from "../lib/inventory-domain/procurement";
const database = vi.hoisted(() => ({ ensureSchema: vi.fn(), getPool: vi.fn(), insertAuditRow: vi.fn() }));
vi.mock("../lib/db", () => database);
import { inventoryOperationInTransaction, postInspectedReceiptInTransaction } from "../lib/inventory-domain/procurement-store";
const actor = { userId: 1, username: "synthetic", role: "admin" };
const input = { id: "12345678-1234-4234-8234-123456789abc", branchId: "clinic" } as ReceiptRevision;
function clientFixture() {
  const query = vi.fn<DbClient["query"]>();
  const release = vi.fn();
  const client: DbClient = { query: <T>(...args: Parameters<DbClient["query"]>) => query(...args) as Promise<QueryResult<T>>, release };
  return { client, query, release };
}
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("receipt adapter transaction boundary", () => {
  it.each([undefined, "", "false", "TRUE", "1", " true "])("gate %j refuses before even a transaction probe", async value => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", value);
    const { client, query, release } = clientFixture(); const work = vi.fn();
    await expect(postInspectedReceiptInTransaction(client, actor, "synthetic-key", input)).rejects.toMatchObject({ code: "inventory_integration_disabled" });
    await expect(inventoryOperationInTransaction(client, actor, "synthetic-key", "receipt.post", input, true, work)).rejects.toMatchObject({ code: "inventory_integration_disabled" });
    expect(query).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled(); expect(work).not.toHaveBeenCalled();
    expect(database.getPool).not.toHaveBeenCalled(); expect(database.ensureSchema).not.toHaveBeenCalled();
  });
  it.each(["25P02", "40P01", "08006"])("preserves probe error %s without catch-and-continue or fabricated success", async code => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const { client, query, release } = clientFixture();
    const failure = Object.assign(new Error("synthetic original error"), { code }); query.mockRejectedValue(failure);
    await expect(postInspectedReceiptInTransaction(client, actor, "synthetic-key", input)).rejects.toBe(failure);
    expect(query.mock.calls).toEqual([["SAVEPOINT inventory_adapter_transaction_check"]]);
    expect(release).not.toHaveBeenCalled(); expect(database.getPool).not.toHaveBeenCalled(); expect(database.ensureSchema).not.toHaveBeenCalled();
  });
  it("does not continue to actor/read/write queries after release-savepoint failure", async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const { client, query } = clientFixture(); const failure = new Error("synthetic release failure");
    query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure);
    await expect(postInspectedReceiptInTransaction(client, actor, "synthetic-key", input)).rejects.toBe(failure);
    expect(query.mock.calls).toEqual([["SAVEPOINT inventory_adapter_transaction_check"], ["RELEASE SAVEPOINT inventory_adapter_transaction_check"]]);
  });
});
