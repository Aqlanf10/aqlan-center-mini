import { afterEach, describe, expect, it, vi } from "vitest";
import type { DbClient, QueryResult } from "../lib/db";
import {
  guardLegacyClinicalMaterials, InventoryBusy, InventorySchemaNotReady,
  InventoryTrackingRequired, legacyInventoryGuardEnabled, legacyInventoryWriteRefusal,
} from "../lib/inventory-domain/legacy-write-guard";

const lockSql = "SELECT id FROM inventory_items WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE NOWAIT";
const readinessSql = "SELECT to_regclass('stock_lots') IS NOT NULL AS ready";
const trackedSql = "SELECT EXISTS(SELECT 1 FROM stock_lots WHERE item_id=ANY($1::int[])) AS tracked";
const mockClient = () => {
  const query = vi.fn<DbClient["query"]>();
  // Vitest erases the query's row generic to unknown. Restore it only at the
  // fixture boundary while keeping the original mock and call arguments intact.
  const client: DbClient = {
    query: <T>(...args: Parameters<DbClient["query"]>) => query(...args) as Promise<QueryResult<T>>,
    release: vi.fn(),
  };
  return { client, query };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => vi.unstubAllEnvs());

describe("temporary legacy inventory writer guard", () => {
  it.each([undefined, "", "false", "False", "TRUE", "1", "on", " true", "true ", "true\n"])(
    "does not issue any lock, readiness or proposal SQL for gate %j", async value => {
      vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", value);
      const { client, query } = mockClient();
      query.mockRejectedValue(new Error("Feature-off must not touch the database"));
      expect(legacyInventoryGuardEnabled()).toBe(false);
      await expect(legacyInventoryWriteRefusal(client, [7])).resolves.toBeNull();
      await expect(guardLegacyClinicalMaterials(client, [7, 2, 7])).resolves.toBeUndefined();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("enables only the exact true value and still skips empty material sets", async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const { client, query } = mockClient();
    expect(legacyInventoryGuardEnabled()).toBe(true);
    await expect(legacyInventoryWriteRefusal(client, [])).resolves.toBeNull();
    await expect(guardLegacyClinicalMaterials(client, [])).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("awaits numerically sorted, deduplicated NOWAIT item locks before separate readiness and lot queries", async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const { client, query } = mockClient();
    const lock = deferred<QueryResult>();
    const readiness = deferred<QueryResult>();
    query.mockReturnValueOnce(lock.promise).mockReturnValueOnce(readiness.promise)
      .mockResolvedValueOnce({ rows: [{ tracked: false }] });
    const input = [11, 2, 11, 3, 2];
    const guarded = guardLegacyClinicalMaterials(client, input);
    expect(query.mock.calls).toEqual([[lockSql, [[2, 3, 11]]]]);
    expect(input).toEqual([11, 2, 11, 3, 2]);

    lock.resolve({ rows: [] });
    await vi.waitFor(() => expect(query).toHaveBeenCalledTimes(2));
    expect(query.mock.calls).toEqual([[lockSql, [[2, 3, 11]]], [readinessSql]]);

    readiness.resolve({ rows: [{ ready: true }] });
    await expect(guarded).resolves.toBeUndefined();
    expect(query.mock.calls).toEqual([
      [lockSql, [[2, 3, 11]]], [readinessSql], [trackedSql, [[2, 3, 11]]],
    ]);
  });

  it("returns a typed business refusal when the already-locked item has a lot", async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const { client, query } = mockClient();
    query.mockResolvedValueOnce({ rows: [{ ready: true }] })
      .mockResolvedValueOnce({ rows: [{ tracked: true }] });
    const refusal = await legacyInventoryWriteRefusal(client, [7]);
    expect(refusal).toBeInstanceOf(InventoryTrackingRequired);
    expect(refusal).toMatchObject({ code: "inventory_tracking_required" });
    expect(query.mock.calls).toEqual([[readinessSql], [trackedSql, [[7]]]]);
  });

  it("throws the typed tracking refusal from clinical signing before any writer can proceed", async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const { client, query } = mockClient();
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ready: true }] })
      .mockResolvedValueOnce({ rows: [{ tracked: true }] });
    await expect(guardLegacyClinicalMaterials(client, [7])).rejects.toBeInstanceOf(InventoryTrackingRequired);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("maps only the NOWAIT lock's 55P03 to a typed inventory_busy refusal without retrying", async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const { client, query } = mockClient();
    const databaseError = Object.assign(new Error("could not obtain lock on row in relation inventory_items"), { code: "55P03" });
    query.mockRejectedValue(databaseError);
    const failure = await guardLegacyClinicalMaterials(client, [7]).catch(error => error);
    expect(failure).toBeInstanceOf(InventoryBusy);
    expect(failure).toMatchObject({ code: "inventory_busy" });
    expect(failure.message).not.toContain(databaseError.message);
    expect(query.mock.calls).toEqual([[lockSql, [[7]]]]);
  });

  it.each([
    Object.assign(new Error("deadlock detected"), { code: "40P01" }),
    Object.assign(new Error("connection lost"), { code: "08006" }),
    Object.assign(new Error("relation missing"), { code: "42P01" }),
    Object.assign(new Error("not a SQLSTATE string"), { code: 5503 }),
    new Error("unexpected error"), "primitive rejection", null,
  ])("preserves non-55P03 lock failures by identity: %j", async failure => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const { client, query } = mockClient();
    query.mockRejectedValue(failure);
    await expect(guardLegacyClinicalMaterials(client, [7])).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([{ rows: [{ ready: false }] }, { rows: [] }])(
    "fails closed without reading stock_lots when readiness is absent: %j", async result => {
      vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
      const { client, query } = mockClient();
      query.mockResolvedValueOnce(result);
      const failure = await legacyInventoryWriteRefusal(client, [7]).catch(error => error);
      expect(failure).toBeInstanceOf(InventorySchemaNotReady);
      expect(failure).toMatchObject({ code: "inventory_schema_not_ready" });
      expect(query.mock.calls).toEqual([[readinessSql]]);
    },
  );

  it("fails clinical signing closed after its item locks when the proposal schema is absent", async () => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const { client, query } = mockClient();
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ready: false }] });
    await expect(guardLegacyClinicalMaterials(client, [7])).rejects.toBeInstanceOf(InventorySchemaNotReady);
    expect(query.mock.calls).toEqual([[lockSql, [[7]]], [readinessSql]]);
  });

  it.each(["readiness", "stock_lots"])("does not translate or hide a 55P03 from the %s query", async stage => {
    vi.stubEnv("INVENTORY_INTEGRATION_ENABLED", "true");
    const { client, query } = mockClient();
    const failure = Object.assign(new Error(`unexpected ${stage} failure`), { code: "55P03" });
    query.mockResolvedValueOnce({ rows: [] });
    if (stage === "stock_lots") query.mockResolvedValueOnce({ rows: [{ ready: true }] });
    query.mockRejectedValueOnce(failure);
    await expect(guardLegacyClinicalMaterials(client, [7])).rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(stage === "stock_lots" ? 3 : 2);
  });
});
