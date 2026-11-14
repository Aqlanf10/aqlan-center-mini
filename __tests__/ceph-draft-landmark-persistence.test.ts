import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { transformSync } from "esbuild";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isCephLandmarkCode, type LandmarkCode } from "../lib/ceph";
import { describeAudit, sanitizeDetails } from "../lib/audit";
import type { DbClient, DbPool, updateCephLandmarks } from "../lib/db";

// Real PostgreSQL-compatible SQL/transactions on a minimal synthetic schema.
// Execute exact production writer + audit functions without the unrelated full
// app bootstrap. This is not PostgreSQL18 row-lock concurrency coverage.
const source = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
const declarations = [
  ["updateCephLandmarks", "export interface CephCompleteResult"],
  ["insertAuditRow", "export async function recordAudit("],
].map(([name, next]) => {
  const start = source.indexOf(`export async function ${name}(`), end = source.indexOf(next, start);
  if (start < 0 || end < start) throw new Error("Missing production function " + name);
  return source.slice(start, end).replace(/^export /gm, "");
}).join("\n");
// esbuild avoids retaining the full TypeScript compiler while the WASM SQL
// engine is resident, keeping this small fixture within ordinary CI memory.
const compiled = transformSync(declarations, { loader: "ts", target: "node22" }).code
  + "\nexports.updateCephLandmarks = updateCephLandmarks; exports.insertAuditRow = insertAuditRow;";
let sql: PGlite;
let db: { getPool: () => DbPool; updateCephLandmarks: typeof updateCephLandmarks;
  getCephStudy: (id: number) => Promise<{ landmarks: Array<{ code: LandmarkCode; x: number; y: number; source: "manual" | "suggested" }> }> };
beforeAll(async () => {
  sql = new PGlite(); await sql.waitReady;
  await sql.exec(`
    CREATE TABLE ceph_analyses (id SERIAL PRIMARY KEY, status TEXT NOT NULL DEFAULT 'draft');
    CREATE TABLE ceph_landmarks (
      id BIGSERIAL PRIMARY KEY, analysis_id INT NOT NULL REFERENCES ceph_analyses(id), code TEXT NOT NULL,
      x DOUBLE PRECISION NOT NULL, y DOUBLE PRECISION NOT NULL, source TEXT NOT NULL,
      confirmed_by TEXT NOT NULL, confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (analysis_id, code)
    );
    CREATE TABLE audit_log (
      id BIGSERIAL PRIMARY KEY, action TEXT, entity TEXT, entity_id TEXT, summary TEXT, details JSONB,
      actor TEXT, actor_role TEXT, source_ip TEXT, user_agent TEXT
    );
  `);
  const query: DbClient["query"] = async <T>(queryText: string, values?: unknown[]) => {
    const result = await sql.query<T>(queryText, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  };
  const pool: DbPool = { query, connect: async () => ({ query, release: () => {} }) };
  const dependencies = {
    ensureSchema: async () => {}, getPool: () => pool, cephWriterClient: () => pool.connect(), /* integration: ceph writers take their client from cephWriterClient (pooled outside a canonical operation) */ isCephLandmarkCode, describeAudit, sanitizeDetails,
    currentAuditSource: async () => ({ ip: null, userAgent: null }),
    recordAudit: async (input: unknown) => (output.insertAuditRow as (executor: DbPool, input: unknown) => Promise<void>)(pool, input),
  };
  const output: Record<string, unknown> = {};
  new Function("exports", ...Object.keys(dependencies), compiled)(output, ...Object.values(dependencies));
  db = {
    getPool: () => pool, updateCephLandmarks: output.updateCephLandmarks as typeof updateCephLandmarks,
    getCephStudy: async (id) => ({ landmarks: (await pool.query<{ code: LandmarkCode; x: number; y: number; source: "manual" | "suggested" }>(
      "SELECT code, x, y, source FROM ceph_landmarks WHERE analysis_id = $1 ORDER BY code", [id],
    )).rows }),
  };
}, 60_000);
afterAll(async () => { await sql?.close(); });

async function createStudy() {
  const { rows: [study] } = await db.getPool().query<{ id: number }>("INSERT INTO ceph_analyses DEFAULT VALUES RETURNING id");
  return study.id;
}
const point = (code: LandmarkCode, x: number, y: number) => ({ code, x, y, source: "manual" as const });
const readPoints = async (id: number) => (await db.getCephStudy(id))!.landmarks.map(({ code, x, y, source }) => ({ code, x, y, source }));
// Invoke the planned backwards-compatible fourth argument before implementation
// too, so baseline failure proves actual persisted rows are not removed.
const write = async (id: number, points: ReturnType<typeof point>[], removeCodes: LandmarkCode[] = [], expected?: ReturnType<typeof point>[]) =>
  (db.updateCephLandmarks as unknown as (id: number, points: ReturnType<typeof point>[], by: string, removeCodes: LandmarkCode[], expected?: unknown[]) => ReturnType<typeof db.updateCephLandmarks>)(id, points, "undo-test", removeCodes,
    expected ?? (removeCodes.length ? (await db.getPool().query("SELECT code, x, y, source FROM ceph_landmarks WHERE analysis_id = $1", [id])).rows : undefined));

describe("draft ceph landmark persistence", () => {
  it("undoes first placement in storage, reloads empty, and redoes exactly once", async () => {
    const id = await createStudy();
    expect((await write(id, [point("S", 12, 34)])).ok).toBe(true);
    expect((await write(id, [], ["S"])).ok).toBe(true);
    expect(await readPoints(id)).toEqual([]);
    expect((await write(id, [], ["S"], [point("S", 12, 34)])).ok).toBe(true);
    expect((await write(id, [point("S", 12, 34)])).ok).toBe(true);
    expect((await write(id, [point("S", 12, 34)])).ok).toBe(true);
    expect(await readPoints(id)).toEqual([point("S", 12, 34)]);
  });

  it("removes only the named points in this analysis while moving another point atomically", async () => {
    const id = await createStudy(), other = await createStudy();
    await write(id, [point("S", 10, 20), point("N", 30, 40)]);
    await write(other, [point("S", 1, 2)]);
    expect((await write(id, [point("N", 50, 60)], ["S"])).ok).toBe(true);
    expect(await readPoints(id)).toEqual([point("N", 50, 60)]);
    expect(await readPoints(other)).toEqual([point("S", 1, 2)]);
  });

  it("preserves removed point coordinates and attribution in the transaction's audit", async () => {
    const id = await createStudy(); await write(id, [point("S", 10, 20)]); await write(id, [], ["S"]);
    const { rows } = await db.getPool().query<{ details: { removedLandmarks?: unknown[] } }>(
      `SELECT details FROM audit_log WHERE entity = 'ceph_analysis' AND entity_id = $1 AND action = 'ceph.update' ORDER BY id DESC LIMIT 1`, [String(id)],
    );
    expect(rows[0]?.details.removedLandmarks).toEqual([expect.objectContaining({ code: "S", x: 10, y: 20, source: "manual", confirmed_by: "undo-test" })]);
  });

  it.each(["completed", "discarded"])("refuses removals on %s studies without changing points", async (status) => {
    const id = await createStudy(); await write(id, [point("S", 10, 20)]);
    await db.getPool().query("UPDATE ceph_analyses SET status = $2 WHERE id = $1", [id, status]);
    expect((await write(id, [], ["S"])).ok).toBe(false);
    expect(await db.getPool().query("SELECT code FROM ceph_landmarks WHERE analysis_id = $1", [id])).toMatchObject({ rows: [{ code: "S" }] });
  });

  it("refuses ambiguous overlapping upserts and removals before any write", async () => {
    const id = await createStudy(); await write(id, [point("S", 10, 20)]);
    expect((await write(id, [point("S", 30, 40)], ["S"])).ok).toBe(false);
    expect(await readPoints(id)).toEqual([point("S", 10, 20)]);
  });

  it("rejects a mixed valid/invalid landmark batch without partially applying it", async () => {
    const id = await createStudy(); await write(id, [point("S", 10, 20)]);
    expect((await write(id, [point("N", 30, 40), point("S", NaN, 40)])).ok).toBe(false);
    expect(await readPoints(id)).toEqual([point("S", 10, 20)]);
  });

  it("rejects a stale tab's undo after another tab moved the point", async () => {
    const id = await createStudy(); const original = point("S", 10, 20);
    await write(id, [original]); await write(id, [point("S", 30, 40)]);
    expect((await write(id, [], ["S"], [original])).ok).toBe(false);
    expect(await readPoints(id)).toEqual([point("S", 30, 40)]);
  });

  it("guards optional expected upserts and accepts an exact idempotent replay", async () => {
    const id = await createStudy(), first = point("S", 10, 20), next = point("S", 30, 40);
    await write(id, [first]);
    expect((await write(id, [next], [], [first])).ok).toBe(true);
    expect((await write(id, [next], [], [first])).ok).toBe(true);
    expect((await write(id, [point("S", 50, 60)], [], [first])).ok).toBe(false);
    expect(await readPoints(id)).toEqual([next]);
  });

  it("requires an expected snapshot before removing a draft point", async () => {
    const id = await createStudy(); await write(id, [point("S", 10, 20)]);
    expect((await write(id, [], ["S"], [])).ok).toBe(false);
    expect(await readPoints(id)).toEqual([point("S", 10, 20)]);
  });

  it("rolls back both removal and upsert if the audit insert fails", async () => {
    const id = await createStudy(); await write(id, [point("S", 10, 20)]);
    const pool = db.getPool(), connect = pool.connect.bind(pool);
    const spy = vi.spyOn(pool, "connect").mockImplementation(async () => {
      const client = await connect(), query = client.query.bind(client);
      client.query = ((sql: string, values?: unknown[]) => {
        if (typeof sql === "string" && sql.includes("INSERT INTO audit_log")) return Promise.reject(new Error("Synthetic audit failure"));
        return query(sql, values);
      }) as typeof client.query;
      return client;
    });
    try { await expect(write(id, [point("N", 30, 40)], ["S"])).rejects.toThrow("Synthetic audit failure"); }
    finally { spy.mockRestore(); }
    expect(await readPoints(id)).toEqual([point("S", 10, 20)]);
  });
});
