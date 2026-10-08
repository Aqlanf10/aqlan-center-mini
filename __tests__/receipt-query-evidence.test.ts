import { describe, expect, it, vi } from "vitest";
import type { DbClient, DbPool, QueryResult } from "../lib/db";
import { captureReceiptQueries, evidenceFrames, EVIDENCE_MARKER, EXPLAIN_PREFIX, explainCapturedQueries,
  safeRunProvenance, sha256, summarizePlan, type CapturedSelect } from "./postgres/_receipt-query-evidence";

// Unit-source checks only; mock results never qualify as PostgreSQL evidence.
const BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
const SELECT = "SELECT id FROM synthetic_fixture WHERE id = ANY($1::int[]) LIMIT $2";
const explain = () => [{ "Planning Time": 0.1, "Execution Time": 0.2,
  Plan: { "Node Type": "Index Scan", "Relation Name": "synthetic_fixture", "Index Name": "synthetic_fixture_pkey",
    "Plan Rows": 1, "Actual Rows": 1, "Actual Loops": 1, "Shared Hit Blocks": 2, "Shared Read Blocks": 0,
    "Filter": "PRIVATE-PARAMETER", "Output": ["PRIVATE-OUTPUT"] } }];
function harness(options: { rejectSql?: string; badRows?: boolean; mutateParameters?: boolean; releaseThrows?: boolean;
  explainRows?: unknown[]; explainRowCount?: number | null } = {}) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const release = vi.fn(() => { if (options.releaseThrows) throw new Error("synthetic release failure"); });
  const query: DbClient["query"] = async <Row>(sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql === options.rejectSql) throw new Error("synthetic query failure");
    if (options.mutateParameters && sql === SELECT) (values![0] as number[]).push(2);
    const result = sql.startsWith(EXPLAIN_PREFIX) ? { rows: options.explainRows ?? [{ "QUERY PLAN": explain() }],
      rowCount: Object.hasOwn(options, "explainRowCount") ? options.explainRowCount : 1 }
      : sql === SELECT ? { rows: [{ id: 1 }], rowCount: options.badRows ? 0 : 1 } : { rows: [], rowCount: null };
    return result as QueryResult<Row>;
  };
  // Inherited methods exercise exact restoration, not only equal bound functions.
  const client: DbClient = Object.create({ query, release });
  const connect = vi.fn(async () => client);
  const pool: Pick<DbPool, "connect"> = Object.create({ connect });
  return { pool, client, query, connect, release, calls };
}
async function neutralReader(pool: Pick<DbPool, "connect">, parameters: unknown[] = [[1], 5_001]) {
  let client: DbClient | undefined;
  try {
    client = await pool.connect();
    await client.query(BEGIN);
    const value = await client.query(SELECT, parameters);
    await client.query("COMMIT");
    return value;
  } catch {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return null;
  } finally { client?.release(); }
}
function restored(h: ReturnType<typeof harness>) {
  expect(h.pool.connect).toBe(h.connect); expect(h.client.query).toBe(h.query); expect(h.client.release).toBe(h.release);
  expect(Object.hasOwn(h.pool, "connect")).toBe(false);
  expect(Object.hasOwn(h.client, "query")).toBe(false); expect(Object.hasOwn(h.client, "release")).toBe(false);
  expect(h.release).toHaveBeenCalledTimes(1);
}
function captured(): CapturedSelect {
  return { sql: SELECT, parameters: [[1], 5_001], sqlSha256: sha256(SELECT), parametersSha256: sha256("[[1],5001]"), rowCount: 1, elapsedMs: 0.3 };
}

describe("actual-client capture lifecycle", () => {
  it("forwards exact SQL and original parameter objects and restores inherited methods", async () => {
    const h = harness(), parameters: unknown[] = [[1], 5_001];
    const answer = await captureReceiptQueries(h.pool, () => neutralReader(h.pool, parameters));
    expect(h.calls.map(call => call.sql)).toEqual([BEGIN, SELECT, "COMMIT"]);
    expect(h.calls[1].values).toBe(parameters);
    expect(answer.selects[0]).toMatchObject({ sql: SELECT, parameters, sqlSha256: sha256(SELECT),
      parametersSha256: sha256("[[1],5001]"), rowCount: 1 });
    expect(answer.selects[0].parameters).not.toBe(parameters);
    expect(answer.selects[0].parameters[0]).not.toBe(parameters[0]);
    expect(answer.selects[0].elapsedMs).toBeGreaterThanOrEqual(0);
    expect(answer.statements).toEqual(["begin", "select", "commit"]);
    expect(answer.connections).toBe(1); expect(answer.releases).toBe(1);
    restored(h);
  });
  it("preserves original own-property descriptors as well as method identity", async () => {
    const h = harness();
    Object.defineProperty(h.pool, "connect", { value: h.connect, configurable: true, writable: false, enumerable: true });
    Object.defineProperty(h.client, "query", { value: h.query, configurable: true, writable: false, enumerable: true });
    Object.defineProperty(h.client, "release", { value: h.release, configurable: true, writable: false, enumerable: true });
    const descriptors = [Object.getOwnPropertyDescriptor(h.pool, "connect"), Object.getOwnPropertyDescriptor(h.client, "query"),
      Object.getOwnPropertyDescriptor(h.client, "release")];
    await captureReceiptQueries(h.pool, () => neutralReader(h.pool));
    expect([Object.getOwnPropertyDescriptor(h.pool, "connect"), Object.getOwnPropertyDescriptor(h.client, "query"),
      Object.getOwnPropertyDescriptor(h.client, "release")]).toEqual(descriptors);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("fails closed before acquisition if the pool cannot be instrumented", async () => {
    const h = harness();
    Object.defineProperty(h.pool, "connect", { value: h.connect, configurable: false });
    await expect(captureReceiptQueries(h.pool, () => neutralReader(h.pool))).rejects.toThrow("capture failed");
    expect(h.pool.connect).toBe(h.connect); expect(h.connect).not.toHaveBeenCalled(); expect(h.release).not.toHaveBeenCalled();
  });
  it.each([BEGIN, SELECT, "COMMIT"])("does not let the reader swallow an actual query failure: %s", async rejectSql => {
    const h = harness({ rejectSql });
    await expect(captureReceiptQueries(h.pool, () => neutralReader(h.pool))).rejects.toThrow("receipt query capture failed");
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK"); restored(h);
  });
  it.each([{ badRows: true }, { mutateParameters: true }])("fails outside a neutral reader after instrumentation assertion failure: %j", async options => {
    const h = harness(options);
    await expect(captureReceiptQueries(h.pool, () => neutralReader(h.pool))).rejects.toThrow("receipt query capture failed");
    restored(h);
  });
  it("rejects unsupported parameter objects without forwarding them", async () => {
    const h = harness();
    await expect(captureReceiptQueries(h.pool, () => neutralReader(h.pool, [{ private: true }]))).rejects.toThrow("capture failed");
    expect(h.calls.map(call => call.sql)).toEqual([BEGIN, "ROLLBACK"]); restored(h);
  });
  it.each([false, true])("rolls back and releases a leaked client even when cleanup rollback rejects: %s", async rejectRollback => {
    const h = harness({ rejectSql: rejectRollback ? "ROLLBACK" : undefined });
    await expect(captureReceiptQueries(h.pool, async () => {
      await h.pool.connect(); throw new Error("synthetic callback failure before its finally");
    })).rejects.toThrow("capture failed");
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK"); restored(h);
  });
  it("restores methods even when real release throws and reports the cleanup failure", async () => {
    const h = harness({ releaseThrows: true });
    await expect(captureReceiptQueries(h.pool, () => neutralReader(h.pool))).rejects.toThrow("capture failed");
    restored(h);
  });
  it("restores the query and releases if installing the release wrapper fails", async () => {
    const h = harness();
    Object.defineProperty(h.client, "release", { value: h.release, configurable: false });
    await expect(captureReceiptQueries(h.pool, () => neutralReader(h.pool))).rejects.toThrow("capture failed");
    expect(h.client.query).toBe(h.query); expect(Object.hasOwn(h.client, "query")).toBe(false);
    expect(h.pool.connect).toBe(h.connect); expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("remembers a swallowed connect failure and restores the pool", async () => {
    const connect = vi.fn(async (): Promise<DbClient> => { throw new Error("synthetic connect failure"); });
    const pool = { connect };
    await expect(captureReceiptQueries(pool, () => neutralReader(pool))).rejects.toThrow("capture failed");
    expect(pool.connect).toBe(connect);
  });
  it("reports a restoration failure but still attempts the other restoration and real release", async () => {
    const h = harness();
    await expect(captureReceiptQueries(h.pool, async () => {
      const client = await h.pool.connect();
      // Deliberately hostile fake-client descriptor: restoration is impossible.
      // The capture must reject, never claim restored, and must still release.
      Object.defineProperty(client, "query", { value: client.query, configurable: false });
      client.release(); return null;
    })).rejects.toThrow("capture failed");
    expect(h.pool.connect).toBe(h.connect); expect(h.client.release).toBe(h.release);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("rejects extra connections without acquiring or leaking a second real client", async () => {
    const h = harness();
    await expect(captureReceiptQueries(h.pool, async () => {
      await neutralReader(h.pool); return neutralReader(h.pool);
    })).rejects.toThrow("capture failed");
    expect(h.connect).toHaveBeenCalledTimes(1); restored(h);
  });
});

describe("captured-query EXPLAIN replay and bounded evidence", () => {
  it.each([null, 1])("prepends only EXPLAIN and uses exact arguments in a read-only transaction with command rowCount %s", async explainRowCount => {
    const h = harness({ explainRowCount }), select = captured();
    const plans = await explainCapturedQueries(h.pool, [select]);
    expect(h.calls.map(call => call.sql)).toEqual([BEGIN, EXPLAIN_PREFIX + SELECT, "COMMIT"]);
    expect(h.calls[1].values).toBe(select.parameters);
    expect(plans[0]).toMatchObject({ sqlSha256: select.sqlSha256, parametersSha256: select.parametersSha256,
      parameterCount: 2, parameterArrayLengths: [1], rowCount: 1, planningMs: 0.1, executionMs: 0.2 });
    expect(plans[0].sql).toBe(SELECT); expect(plans[0].parameters).toEqual(select.parameters);
    expect(plans[0].nodes[0].metrics["Shared Hit Blocks"]).toBe(2);
    expect(JSON.stringify(plans)).not.toMatch(/PRIVATE|Filter|Output/);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it.each([0, 2])("rejects %s returned EXPLAIN rows even when command rowCount is null", async resultRows => {
    const h = harness({ explainRowCount: null, explainRows: Array.from({ length: resultRows }, () => ({ "QUERY PLAN": explain() })) });
    await expect(explainCapturedQueries(h.pool, [captured()])).rejects.toThrow("EXPLAIN row count");
    expect(h.calls.map(call => call.sql)).toEqual([BEGIN, EXPLAIN_PREFIX + SELECT, "ROLLBACK"]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 0, 2, -1, 1.5, NaN, Infinity])("rejects an invalid EXPLAIN command rowCount: %s", async explainRowCount => {
    const h = harness({ explainRowCount });
    await expect(explainCapturedQueries(h.pool, [captured()])).rejects.toThrow("EXPLAIN row count");
    expect(h.calls.map(call => call.sql)).toEqual([BEGIN, EXPLAIN_PREFIX + SELECT, "ROLLBACK"]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it.each([0, 2])("rejects %s JSON plan documents even when command rowCount is null", async documents => {
    const h = harness({ explainRowCount: null,
      explainRows: [{ "QUERY PLAN": Array.from({ length: documents }, () => explain()[0]) }] });
    await expect(explainCapturedQueries(h.pool, [captured()])).rejects.toThrow("invalid EXPLAIN envelope");
    expect(h.calls.map(call => call.sql)).toEqual([BEGIN, EXPLAIN_PREFIX + SELECT, "ROLLBACK"]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it.each([BEGIN, EXPLAIN_PREFIX + SELECT, "COMMIT"])("rolls back and releases after replay failure: %s", async rejectSql => {
    const h = harness({ rejectSql });
    await expect(explainCapturedQueries(h.pool, [captured()])).rejects.toThrow();
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK"); expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("rejects changed captured SQL or parameters before replay and still releases", async () => {
    for (const mutation of [{ sql: SELECT + " " }, { parameters: [[2]] }]) {
      const h = harness();
      await expect(explainCapturedQueries(h.pool, [{ ...captured(), ...mutation }])).rejects.toThrow("capture changed");
      expect(h.calls.map(call => call.sql)).toEqual([BEGIN, "ROLLBACK"]); expect(h.release).toHaveBeenCalledTimes(1);
    }
  });
  it.each([[["private"], 5_001], [[0], 5_001], [[1, "2"], 5_001], [[1, 1], 5_001], [[1], 99], [[2_147_483_648], 5_001]])(
    "rejects non-receipt evidence parameters even with matching hashes: %j", async (...parameters) => {
      const h = harness();
      await expect(explainCapturedQueries(h.pool, [{ ...captured(), parameters,
        parametersSha256: sha256(JSON.stringify(parameters)) }])).rejects.toThrow("receipt evidence parameter");
      expect(h.calls.map(call => call.sql)).toEqual([BEGIN, "ROLLBACK"]); expect(h.release).toHaveBeenCalledTimes(1);
    });
  it.each([null, 1])("rejects changed root row counts with EXPLAIN command rowCount %s", async explainRowCount => {
    const h = harness({ explainRowCount });
    await expect(explainCapturedQueries(h.pool, [{ ...captured(), rowCount: 2 }])).rejects.toThrow("root differs");
    expect(h.calls.map(call => call.sql)).toEqual([BEGIN, EXPLAIN_PREFIX + SELECT, "ROLLBACK"]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it.each([0, 2])("rejects %s root loops even when command rowCount is null", async actualLoops => {
    const h = harness({ explainRowCount: null,
      explainRows: [{ "QUERY PLAN": [{ ...explain()[0], Plan: { ...explain()[0].Plan, "Actual Loops": actualLoops } }] }] });
    await expect(explainCapturedQueries(h.pool, [captured()])).rejects.toThrow("root differs");
    expect(h.calls.map(call => call.sql)).toEqual([BEGIN, EXPLAIN_PREFIX + SELECT, "ROLLBACK"]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
  it("validates plan shape and finite observations; bounds nodes and depth", () => {
    expect(() => summarizePlan([])).toThrow();
    expect(() => summarizePlan([{ ...explain()[0], "Execution Time": Infinity }])).toThrow();
    expect(() => summarizePlan([{ ...explain()[0], Plan: { ...explain()[0].Plan, "Actual Rows": -1 } }])).toThrow();
    const leaf = explain()[0].Plan;
    expect(() => summarizePlan([{ ...explain()[0], Plan: { ...leaf, Plans: Array.from({ length: 96 }, () => leaf) } }])).toThrow("bounds");
    let deep: object = leaf;
    for (let i = 0; i < 34; i++) deep = { ...leaf, Plans: [deep] };
    expect(() => summarizePlan([{ ...explain()[0], Plan: deep }])).toThrow("bounds");
  });
  it("keeps parent/child actual rows, loops and buffers without double-counting inclusive metrics", () => {
    const leaf = explain()[0].Plan;
    const plan = summarizePlan([{ ...explain()[0], Plan: { ...leaf, "Node Type": "Limit", Plans: [leaf] } }]);
    expect(plan.nodes.map(node => ({ index: node.index, parent: node.parent, depth: node.depth })))
      .toEqual([{ index: 0, parent: null, depth: 0 }, { index: 1, parent: 0, depth: 1 }]);
    expect(plan.nodes[1].metrics["Actual Rows"]).toBe(1);
    expect(plan.nodes[1].metrics["Actual Loops"]).toBe(1);
    expect(plan.nodes[1].metrics["Shared Hit Blocks"]).toBe(2);
  });
  it("drops unknown or malformed environment provenance instead of logging it", () => {
    expect(safeRunProvenance({ NODE_ENV: "test", GITHUB_SHA: "secret", GITHUB_RUN_ID: "https://private", GITHUB_JOB: "private\ntext",
      GITHUB_RUN_ATTEMPT: "1e4", DATABASE_URL: "secret" })).toEqual({ checkoutSha: null, runId: null, runAttempt: null, job: null });
    expect(safeRunProvenance({ NODE_ENV: "test", GITHUB_SHA: "a".repeat(40), GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_JOB: "postgres" }))
      .toEqual({ checkoutSha: "a".repeat(40), runId: "123", runAttempt: "1", job: "postgres" });
  });
  it("prepares bounded, reconstructable, checksummed JSON frames without logging partial payloads", () => {
    const evidence = { synthetic: true, testOnly: true, rows: 5_000, payload: "x".repeat(6_000) };
    const frames = evidenceFrames(evidence);
    const parsed = frames.map(frame => JSON.parse(frame.slice(EVIDENCE_MARKER.length + 1)));
    const bytes = Buffer.from(parsed.slice(1, -1).map(part => part.data).join(""), "base64");
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(evidence);
    expect(parsed[0]).toMatchObject({ kind: "begin", bytes: bytes.length, sha256: sha256(bytes), chunks: parsed.length - 2 });
    expect(parsed.at(-1)).toEqual({ kind: "end", sha256: sha256(bytes), chunks: parsed.length - 2 });
    expect(parsed.slice(1, -1).every((part, index) => part.index === index && part.data.length <= 4_096)).toBe(true);
    expect(() => evidenceFrames({ payload: "x".repeat(128 * 1_024) })).toThrow("byte limit");
  });
});
