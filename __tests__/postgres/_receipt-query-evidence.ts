import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { DbClient, DbPool } from "../../lib/db";

// Test-only instrumentation. There is no copy/export of either production SELECT.
const BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
export const EXPLAIN_PREFIX = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF, SUMMARY ON) ";
export const EVIDENCE_MARKER = "SYNTHETIC_RECEIPT_QUERY_PLAN_V1";
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export interface CapturedSelect {
  sql: string;
  parameters: unknown[];
  sqlSha256: string;
  parametersSha256: string;
  rowCount: number;
  elapsedMs: number;
}

function parametersCopy(values: unknown[] | undefined): unknown[] {
  const validate = (value: unknown, depth: number): void => {
    if (Array.isArray(value)) {
      if (depth > 2 || value.length > 5_001) throw new Error("capture parameter bounds");
      value.forEach(item => validate(item, depth + 1));
    } else if (!(value === null || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))
      || (typeof value === "string" && value.length <= 256))) throw new Error("capture parameter type");
  };
  const array = values ?? [];
  if (!Array.isArray(array) || array.length > 8) throw new Error("capture parameter list");
  validate(array, 0);
  const json = JSON.stringify(array);
  if (Buffer.byteLength(json) > 128 * 1_024) throw new Error("capture parameter bytes");
  return JSON.parse(json) as unknown[];
}

function replaceMethod(target: object, key: string, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  return () => {
    if (descriptor) Object.defineProperty(target, key, descriptor);
    else if (!Reflect.deleteProperty(target, key)) throw new Error("capture restore failed");
  };
}

/** Instruments the actual acquired client, forwards original SQL/argument objects,
 * and restores property descriptors before release. Any instrumentation/query or
 * cleanup error survives the reader's deliberately neutral catch-and-return path. */
export async function captureReceiptQueries<T>(pool: Pick<DbPool, "connect">, read: () => Promise<T>) {
  const selects: CapturedSelect[] = [], statements: string[] = [], failures: Error[] = [];
  const fail = (message: string) => { if (failures.length < 16) failures.push(new Error(message)); };
  const active: { release: () => void; rollback: () => Promise<void>; released: boolean }[] = [];
  const connect = pool.connect.bind(pool);
  let restoreConnect = () => {}, connections = 0, releases = 0;
  let result!: T;
  const started = performance.now();
  try {
    restoreConnect = replaceMethod(pool, "connect", async () => {
      connections++;
      if (connections > 1) { fail("capture extra connection"); throw new Error("capture extra connection"); }
      let client: DbClient;
      try { client = await connect(); }
      catch { fail("capture connection rejected"); throw new Error("capture connection rejected"); }
      const query: DbClient["query"] = client.query.bind(client), release = client.release.bind(client);
      let restoreQuery = () => {}, restoreRelease = () => {};
      const state = {
        released: false,
        rollback: async () => { await query("ROLLBACK"); },
        release: () => {
          if (state.released) { fail("capture duplicate release"); return; }
          state.released = true;
          // Each restore and the real release is attempted even if another fails.
          try { restoreQuery(); } catch { fail("capture query restoration failed"); }
          try { restoreRelease(); } catch { fail("capture release restoration failed"); }
          try { release(); releases++; } catch { fail("capture release failed"); }
        },
      };
      active.push(state);
      try {
        const wrapped: DbClient["query"] = async <Row>(sql: string, values?: unknown[]) => {
          const start = performance.now();
          try {
            if (statements.length >= 8 || typeof sql !== "string" || Buffer.byteLength(sql) > 16 * 1_024) {
              throw new Error("capture statement bounds");
            }
            const data = /^(SELECT\b|WITH\b)/.test(sql.trimStart());
            const kind = data ? "select" : sql === BEGIN ? "begin" : sql === "COMMIT" ? "commit" : sql === "ROLLBACK" ? "rollback" : null;
            if (!kind || (data && selects.length >= 2)) throw new Error("capture unexpected statement");
            statements.push(kind);
            const parameters = parametersCopy(values);
            const parametersSha256 = sha256(JSON.stringify(parameters));
            // Do not normalize, replace or add any SQL or parameter arguments.
            const answer = await query<Row>(sql, values);
            if (sha256(JSON.stringify(parametersCopy(values))) !== parametersSha256) throw new Error("capture mutated parameters");
            if (data) {
              if (!Number.isSafeInteger(answer.rowCount) || answer.rowCount !== answer.rows.length
                || answer.rows.length > 5_001) throw new Error("capture invalid row count");
              selects.push({ sql, parameters, sqlSha256: sha256(sql), parametersSha256,
                rowCount: answer.rowCount!, elapsedMs: performance.now() - start });
            }
            return answer;
          } catch {
            fail("capture query or instrumentation failed");
            throw new Error("capture query or instrumentation failed");
          }
        };
        restoreQuery = replaceMethod(client, "query", wrapped);
        restoreRelease = replaceMethod(client, "release", state.release);
        return client;
      } catch {
        fail("capture installation failed");
        state.release();
        throw new Error("capture installation failed");
      }
    });
    result = await read();
  } catch { fail("capture reader rejected"); }
  finally {
    try { restoreConnect(); } catch { fail("capture pool restoration failed"); }
    for (const state of active) {
      if (state.released) continue;
      fail("capture reader leaked client");
      try { await state.rollback(); } catch { fail("capture cleanup rollback failed"); }
      finally { state.release(); }
    }
  }
  if (connections !== 1 || releases !== 1) fail("capture connection/release count");
  if (failures.length) throw new AggregateError(failures, "receipt query capture failed");
  return { result, selects, statements, connections, releases, elapsedMs: performance.now() - started };
}

const METRICS = ["Plan Rows", "Actual Rows", "Actual Loops", "Rows Removed by Filter", "Rows Removed by Join Filter",
  "Shared Hit Blocks", "Shared Read Blocks", "Shared Dirtied Blocks", "Shared Written Blocks",
  "Local Hit Blocks", "Local Read Blocks", "Local Dirtied Blocks", "Local Written Blocks", "Temp Read Blocks", "Temp Written Blocks"] as const;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("invalid plan metric");
  return value;
}
function label(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_ .:-]{1,128}$/.test(value)) throw new Error("invalid plan label");
  return value;
}

/** Only allowlisted physical-plan labels/numbers survive this summary. Raw plan
 * filters, output expressions and literals do not. SQL/validated synthetic
 * parameters are added separately from the actual captured call. */
export function summarizePlan(input: unknown) {
  if (!Array.isArray(input) || input.length !== 1 || !record(input[0])) throw new Error("invalid EXPLAIN envelope");
  const document = input[0];
  const nodes: { index: number; parent: number | null; depth: number; type: string;
    relation?: string; indexName?: string; metrics: Record<string, number> }[] = [];
  function visit(raw: unknown, parent: number | null, depth: number) {
    if (!record(raw) || nodes.length >= 96 || depth > 32) throw new Error("plan node bounds");
    const metrics: Record<string, number> = {};
    for (const key of METRICS) if (raw[key] !== undefined) metrics[key] = number(raw[key]);
    number(raw["Actual Rows"]); number(raw["Actual Loops"]);
    const index = nodes.length;
    nodes.push({ index, parent, depth, type: label(raw["Node Type"]),
      ...(raw["Relation Name"] === undefined ? {} : { relation: label(raw["Relation Name"]) }),
      ...(raw["Index Name"] === undefined ? {} : { indexName: label(raw["Index Name"]) }), metrics });
    if (raw.Plans !== undefined) {
      if (!Array.isArray(raw.Plans)) throw new Error("invalid plan children");
      for (const child of raw.Plans) visit(child, index, depth + 1);
    }
  }
  visit(document.Plan, null, 0);
  return { planningMs: number(document["Planning Time"]), executionMs: number(document["Execution Time"]), nodes };
}

/** Evidence carries only positive synthetic receipt IDs plus the fixed sentinel.
 * Target isolation and fixture ownership are separately proved by the PG test. */
function receiptEvidenceParameters(values: unknown[]): unknown[] {
  const copy = parametersCopy(values);
  if (copy.length !== 2 || !Array.isArray(copy[0]) || copy[0].length < 1 || copy[0].length > 5_000 || copy[1] !== 5_001) {
    throw new Error("receipt evidence parameter shape");
  }
  const ids = copy[0], type = typeof ids[0];
  if ((type !== "number" && type !== "string") || ids.some(id => typeof id !== type
    || (type === "string" && !/^[1-9]\d{0,9}$/.test(String(id)))
    || !Number.isSafeInteger(Number(id)) || Number(id) < 1 || Number(id) > 2_147_483_647)
    || new Set(ids).size !== ids.length) throw new Error("receipt evidence parameter IDs");
  return copy;
}

/** Called only after captureReceiptQueries has restored all instrumentation. */
export async function explainCapturedQueries(pool: Pick<DbPool, "connect">, selects: CapturedSelect[]) {
  if (selects.length < 1 || selects.length > 2) throw new Error("EXPLAIN count bounds");
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query(BEGIN);
    const plans = [];
    for (const select of selects) {
      if (!/^(SELECT\b|WITH\b)/.test(select.sql.trimStart()) || sha256(select.sql) !== select.sqlSha256
        || sha256(JSON.stringify(parametersCopy(select.parameters))) !== select.parametersSha256) throw new Error("EXPLAIN capture changed");
      const evidenceParameters = receiptEvidenceParameters(select.parameters);
      const answer = await client.query<{ "QUERY PLAN": unknown }>(EXPLAIN_PREFIX + select.sql, select.parameters);
      // EXPLAIN's command tag may omit rowCount; returned rows still must contain one JSON plan.
      if (answer.rows.length !== 1 || (answer.rowCount !== null && answer.rowCount !== 1)) throw new Error("EXPLAIN row count");
      const plan = summarizePlan(answer.rows[0]["QUERY PLAN"]);
      if (plan.nodes[0].metrics["Actual Rows"] !== select.rowCount || plan.nodes[0].metrics["Actual Loops"] !== 1) {
        throw new Error("EXPLAIN root differs from actual capture");
      }
      plans.push({ sql: select.sql, parameters: evidenceParameters,
        sqlSha256: select.sqlSha256, parametersSha256: select.parametersSha256,
        sqlBytes: Buffer.byteLength(select.sql), parameterCount: select.parameters.length,
        parameterArrayLengths: select.parameters.filter(Array.isArray).map(value => value.length),
        rowCount: select.rowCount, capturedElapsedMs: number(select.elapsedMs), ...plan });
    }
    await client.query("COMMIT"); committed = true;
    return plans;
  } finally {
    try { if (!committed) await client.query("ROLLBACK"); }
    finally { client.release(); }
  }
}

export function safeRunProvenance(environment: NodeJS.ProcessEnv) {
  const safe = (key: string, pattern: RegExp) => pattern.test(environment[key] ?? "") ? environment[key]! : null;
  return { checkoutSha: safe("GITHUB_SHA", /^[a-f0-9]{40}$/), runId: safe("GITHUB_RUN_ID", /^\d{1,20}$/),
    runAttempt: safe("GITHUB_RUN_ATTEMPT", /^\d{1,6}$/), job: safe("GITHUB_JOB", /^[A-Za-z0-9_-]{1,80}$/) };
}

/** Fully prepare and bound the payload before emitting any frame. Callers pass
 * only the constructed synthetic evidence object, never database result rows. */
export function evidenceFrames(evidence: object): string[] {
  const json = JSON.stringify(evidence);
  const bytes = Buffer.from(json, "utf8");
  if (bytes.length > 128 * 1_024) throw new Error("receipt evidence byte limit");
  const encoded = bytes.toString("base64"), chunks = Math.ceil(encoded.length / 4_096);
  const digest = sha256(bytes);
  const frames = [`${EVIDENCE_MARKER} ${JSON.stringify({ kind: "begin", bytes: bytes.length, sha256: digest, chunks })}`];
  for (let i = 0; i < chunks; i++) frames.push(`${EVIDENCE_MARKER} ${JSON.stringify({ kind: "chunk", index: i,
    data: encoded.slice(i * 4_096, (i + 1) * 4_096) })}`);
  frames.push(`${EVIDENCE_MARKER} ${JSON.stringify({ kind: "end", sha256: digest, chunks })}`);
  return frames;
}
