vi.mock("server-only", () => ({}));
import { describe, expect, it, vi } from "vitest";
import { createPayableInTransaction, type CreatePayableInput, type DbClient, type QueryResult } from "../lib/db";

const input: CreatePayableInput = {
  partyId: 1, category: "supplier", description: "Synthetic invoice", amountMinor: 100,
  currency: "SAR", baseCurrency: "YER", exchangeRate: 140, labOrderId: null,
  dueDate: null, createdBy: "synthetic-admin",
};
function fixture() {
  const query = vi.fn<DbClient["query"]>();
  const release = vi.fn();
  const client: DbClient = { query: <T>(...args: Parameters<DbClient["query"]>) => query(...args) as Promise<QueryResult<T>>, release };
  return { query, release, client };
}

describe("caller-owned payable transaction boundary", () => {
  it("maps only autocommit misuse and never issues a business query", async () => {
    const { query, release, client } = fixture();
    query.mockRejectedValue(Object.assign(new Error("synthetic autocommit"), { code: "25P01" }));
    await expect(createPayableInTransaction(client, input)).rejects.toMatchObject({ code: "transaction_required" });
    expect(query.mock.calls).toEqual([["SAVEPOINT payable_writer_transaction_check"]]);
    expect(release).not.toHaveBeenCalled();
  });

  it.each(["25P02", "40P01", "08006"])("preserves original %s probe failure", async code => {
    const { query, release, client } = fixture();
    const failure = Object.assign(new Error("synthetic original failure"), { code });
    query.mockRejectedValue(failure);
    await expect(createPayableInTransaction(client, input)).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it("stops before insertion if releasing the probe fails", async () => {
    const { query, release, client } = fixture();
    const failure = new Error("synthetic release failure");
    query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure);
    await expect(createPayableInTransaction(client, input)).rejects.toBe(failure);
    expect(query.mock.calls).toEqual([["SAVEPOINT payable_writer_transaction_check"], ["RELEASE SAVEPOINT payable_writer_transaction_check"]]);
    expect(release).not.toHaveBeenCalled();
  });
});
