import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";

/**
 * The opening-correction preview runs in a READ ONLY REPEATABLE READ snapshot. On a read
 * failure it must surface the original error; a client whose ROLLBACK also failed must be
 * discarded (release(true)), never returned to the pool in an uncertain transaction state.
 * Synthetic data only.
 */

assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_opening_preview_cleanup_test");
const db = await import("../../lib/db");

let patientId = 0;
beforeAll(async () => {
  await db.ensureSchema();
  [{ id: patientId }] = (await db.getPool().query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ('PREVIEW-CLEANUP-1', 'Synthetic preview patient') RETURNING id")).rows;
}, 180_000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => { await db.resetPoolForTesting(); });

type Mode = "normal" | "read-fails" | "read-and-rollback-fail";
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
      const sql = typeof args[0] === "string" ? args[0] : String((args[0] as { text?: string }).text ?? "");
      statements.push(sql.split(/\s+/)[0]);
      if (sql.startsWith("BEGIN")) { began = true; return query(...args); }
      if (sql === "ROLLBACK" && mode === "read-and-rollback-fail") throw new Error("synthetic rollback failure");
      if (began && mode !== "normal" && !["COMMIT", "ROLLBACK"].includes(sql)) throw new Error("synthetic preview read failure");
      return query(...args);
    }) as typeof client.query;
    client.release = ((destroy?: boolean | Error) => { released.push(destroy); return release(destroy); }) as typeof client.release;
    return client;
  }) as unknown as typeof pool.connect);
  return { statements, released };
}

describe("opening-correction preview transaction cleanup", () => {
  it("normal completion commits the read-only snapshot and returns the client normally", async () => {
    const seen = instrument("normal");
    await expect(db.previewOpeningCorrection(patientId, "YER", 0)).resolves.toBeTruthy();
    expect(seen.statements[0]).toBe("BEGIN");
    expect(seen.statements.at(-1)).toBe("COMMIT");
    expect(seen.statements).not.toContain("ROLLBACK");
    expect(seen.released).toEqual([false]);
  });

  it("a read failure with a successful ROLLBACK keeps the original error and returns the client normally", async () => {
    const seen = instrument("read-fails");
    await expect(db.previewOpeningCorrection(patientId, "YER", 0)).rejects.toThrow("synthetic preview read failure");
    expect(seen.statements.at(-1)).toBe("ROLLBACK");
    expect(seen.statements).not.toContain("COMMIT");
    expect(seen.released).toEqual([false]);
  });

  it("a read failure whose ROLLBACK also fails keeps the original error and discards the client", async () => {
    const seen = instrument("read-and-rollback-fail");
    await expect(db.previewOpeningCorrection(patientId, "YER", 0)).rejects.toThrow("synthetic preview read failure");
    expect(seen.statements.at(-1)).toBe("ROLLBACK");
    expect(seen.released).toEqual([true]);
    // The pool stays usable: the discarded connection is replaced, not reused mid-transaction.
    expect((await db.getPool().query<{ ok: number }>("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
  });
});
