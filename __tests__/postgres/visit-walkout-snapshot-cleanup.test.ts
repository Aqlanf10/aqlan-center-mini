import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

/**
 * The standalone visit walkout (printed walkout page) reads in its own READ ONLY
 * REPEATABLE READ snapshot. On a read failure it must surface the original error; a client
 * whose ROLLBACK also failed must be discarded (release(true)), never returned to the pool
 * in an uncertain transaction state. A caller-supplied snapshot is used as-is: no
 * transaction statements and no release. Synthetic data only.
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_visit_walkout_cleanup_test");
const db = await import("../../lib/db");

let visitId = 0;
beforeAll(async () => {
  await db.ensureSchema();
  const [{ id: patientId }] = (await db.getPool().query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ('WALKOUT-CLEANUP-1', 'Synthetic walkout patient') RETURNING id")).rows;
  [{ id: visitId }] = (await db.getPool().query<{ id: number }>(
    "INSERT INTO visits (patient_id, patient_name, status) VALUES ($1, 'Synthetic walkout patient', 'waiting') RETURNING id", [patientId])).rows;
}, 180_000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await db.resetPoolForTesting(); });

type Mode = "normal" | "read-fails" | "read-and-rollback-fail";
function sqlOf(args: unknown[]): string {
  return typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string }).text ?? "");
}
function instrument(mode: Mode) {
  const pool = db.getPool();
  const statements: string[] = [];
  const released: unknown[] = [];
  const connect = pool.connect.bind(pool) as () => Promise<PoolClient>;
  vi.spyOn(pool, "connect").mockImplementationOnce((async () => {
    const client = await connect();
    const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
    const release = client.release.bind(client);
    let began = false;
    client.query = (async (...args: unknown[]) => {
      const sql = sqlOf(args);
      statements.push(sql.trim().split(/\s+/)[0]);
      if (sql.startsWith("BEGIN")) { began = true; return query(...args); }
      if (sql === "ROLLBACK" && mode === "read-and-rollback-fail") throw new Error("synthetic rollback failure");
      if (began && mode !== "normal" && !["COMMIT", "ROLLBACK"].includes(sql)) throw new Error("synthetic walkout read failure");
      return query(...args);
    }) as typeof client.query;
    // Unwrap before releasing so a client returned to the pool carries no test instrumentation.
    client.release = ((destroy?: boolean | Error) => {
      released.push(destroy);
      client.query = query as typeof client.query;
      client.release = release;
      return release(destroy);
    }) as typeof client.release;
    return client;
  }) as unknown as typeof pool.connect);
  return { statements, released };
}

describe("standalone visit walkout transaction cleanup", () => {
  it("normal completion commits the read-only snapshot and returns the client normally", async () => {
    const seen = instrument("normal");
    await expect(db.visitWalkout(visitId)).resolves.toMatchObject({ visitId });
    expect(seen.statements[0]).toBe("BEGIN");
    expect(seen.statements.at(-1)).toBe("COMMIT");
    expect(seen.statements).not.toContain("ROLLBACK");
    expect(seen.released.map(Boolean)).toEqual([false]);
  });

  it("a read failure with a successful ROLLBACK keeps the original error and returns the client normally", async () => {
    const seen = instrument("read-fails");
    await expect(db.visitWalkout(visitId)).rejects.toThrow("synthetic walkout read failure");
    expect(seen.statements.at(-1)).toBe("ROLLBACK");
    expect(seen.statements).not.toContain("COMMIT");
    expect(seen.released.map(Boolean)).toEqual([false]);
  });

  it("a read failure whose ROLLBACK also fails keeps the original error and discards the client", async () => {
    const seen = instrument("read-and-rollback-fail");
    await expect(db.visitWalkout(visitId)).rejects.toThrow("synthetic walkout read failure");
    expect(seen.statements.at(-1)).toBe("ROLLBACK");
    expect(seen.released).toEqual([true]);
    // The pool stays usable: the discarded connection is replaced, not reused mid-transaction.
    expect((await db.getPool().query<{ ok: number }>("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
  });

  it("a caller-supplied snapshot is used as-is: no transaction statements, no release", async () => {
    const connect = vi.spyOn(db.getPool(), "connect");
    const client = await db.getPool().connect();
    connect.mockClear();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const statements: string[] = [];
      const release = vi.spyOn(client, "release");
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      client.query = (async (...args: unknown[]) => { statements.push(sqlOf(args).trim().split(/\s+/)[0]); return query(...args); }) as typeof client.query;
      await expect(db.visitWalkout(visitId, client)).resolves.toMatchObject({ visitId });
      expect(statements.length).toBeGreaterThan(0);
      expect(statements.filter((s) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(s.toUpperCase()))).toEqual([]);
      expect(release).not.toHaveBeenCalled();
      expect(connect).not.toHaveBeenCalled();
      client.query = query as typeof client.query;
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});
