/** Synthetic-only cooperative admission contract. No application caller or
 * production provider. An old binary that does not call this gate is not fenced. */
import type { Pool, PoolClient } from "pg";
import type { PatientNumberingQueryClient } from "./patient-numbering-insert-scope";

export type WriterPhase = "LEGACY" | "FENCED" | "MANAGED";
export interface WriterGeneration {
  readonly version: 1;
  readonly lineage: string;
  readonly mode: WriterPhase;
  readonly generation: string;
}
export type WriterToken = WriterGeneration & { readonly mode: "LEGACY" | "MANAGED" };
export type WriterRefusalReason =
  | "invalid-writer-token" | "invalid-transition" | "writer-state-unavailable"
  | "writers-fenced" | "stale-generation" | "illegal-transition"
  | "idempotency-conflict" | "managed-handoff-unproven" | "generation-exhausted"
  | "writer-transaction-failed";
type Refusal = { ok: false; reason: WriterRefusalReason };
type TransactionResult<T> = { ok: true; value: T } | Refusal;
interface TransitionReceipt {
  readonly before: WriterGeneration;
  readonly applied: WriterGeneration;
}
interface TransitionOutcome extends TransitionReceipt {
  /** Read under the exclusive lock; a replay may show a later current state. */
  readonly current: WriterGeneration;
  readonly replay: boolean;
}
interface GenerationOptions {
  pool: Pool;
  /** Fixture-only trusted configuration; never accepted from requests. */
  schema: string;
  lineage: string;
  /** Test proof seam. No real owner, independent archive proof or DB fence
   * provider exists. Callback must not mutate data or own the transaction. */
  verifyManagedHandoff?: (client: PoolClient, fenced: WriterGeneration) => Promise<boolean>;
}

const generationMax = 9223372036854775807n;
const lineagePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function state(value: unknown): WriterGeneration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 4 || !["version", "lineage", "mode", "generation"].every(key => Object.hasOwn(r, key))
    || r.version !== 1 || typeof r.lineage !== "string" || !lineagePattern.test(r.lineage)
    || (r.mode !== "LEGACY" && r.mode !== "FENCED" && r.mode !== "MANAGED")
    || typeof r.generation !== "string" || !/^[1-9][0-9]{0,18}$/.test(r.generation)
    || BigInt(r.generation) > generationMax) return null;
  return Object.freeze({ version: 1, lineage: r.lineage, mode: r.mode, generation: r.generation });
}
function same(a: WriterGeneration, b: WriterGeneration): boolean {
  return a.lineage === b.lineage && a.version === b.version && a.mode === b.mode && a.generation === b.generation;
}
function next(mode: WriterPhase): WriterPhase | null {
  return mode === "LEGACY" ? "FENCED" : mode === "FENCED" ? "MANAGED" : null;
}
class WriterRefused extends Error {
  constructor(readonly reason: WriterRefusalReason) { super(reason); }
}
function refuse(reason: WriterRefusalReason): never { throw new WriterRefused(reason); }

export class SyntheticNumberingWriterAdmission {
  private readonly schema: string;
  private readonly lineage: string;
  private readonly pool: Pool;
  private readonly verifyManagedHandoff: GenerationOptions["verifyManagedHandoff"];
  constructor(options: GenerationOptions) {
    if (!/^numbering_generation_fixture_[a-f0-9]{32}$/.test(options.schema)
      || !lineagePattern.test(options.lineage)) throw new Error("Not a trusted synthetic generation fixture");
    this.schema = options.schema;
    this.lineage = options.lineage;
    this.pool = options.pool;
    this.verifyManagedHandoff = options.verifyManagedHandoff;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<TransactionResult<T>> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SET LOCAL lock_timeout='5s'");
      const value = await work(client);
      await client.query("COMMIT");
      return { ok: true, value };
    } catch (error) {
      await client?.query("ROLLBACK").catch(() => {});
      return { ok: false, reason: error instanceof WriterRefused ? error.reason : "writer-transaction-failed" };
    } finally { client?.release(); }
  }
  private async lockedState(client: PatientNumberingQueryClient, exclusive: boolean): Promise<WriterGeneration> {
    const { rows } = await client.query(
      `/* numbering-writer-${exclusive ? "transition" : "admission"} */
       SELECT version, lineage::text, phase AS mode, generation::text
       FROM ${this.schema}.generation_state WHERE id=1 FOR ${exclusive ? "UPDATE" : "SHARE"}`,
    );
    const current = rows.length === 1 ? state(rows[0]) : null;
    if (current === null || current.lineage !== this.lineage) return refuse("writer-state-unavailable");
    return current;
  }
  private async xid(client: PatientNumberingQueryClient): Promise<string> {
    const { rows: [row] } = await client.query("SELECT pg_current_xact_id_if_assigned()::text AS xid");
    if (typeof row?.xid !== "string") return refuse("writer-transaction-failed");
    return row.xid;
  }

  /** Historical receipts are not fresh admission tokens. Obtain current mode
   * and generation; admission rechecks under the writer transaction lock. */
  readState(): Promise<TransactionResult<WriterGeneration>> {
    return this.transaction(client => this.lockedState(client, false));
  }

  /** Fixture-only seam for smoke testing writers that already own a client
   * and BEGIN. Admission must be their first step after BEGIN, before any
   * domain lock/read. Caller must roll back on rejection; no legacy fallback.
   * This generation token is not an authenticated staff identity. */
  async admitExistingTransaction(client: PatientNumberingQueryClient, raw: unknown): Promise<string> {
    const token = state(raw);
    if (token === null || token.mode === "FENCED") return refuse("invalid-writer-token");
    const current = await this.lockedState(client, false);
    // In autocommit, the completed row-lock statement's XID no longer exists.
    const transaction = await this.xid(client);
    if (current.mode === "FENCED") return refuse("writers-fenced");
    if (!same(current, token)) return refuse("stale-generation");
    return transaction;
  }

  /** The callback runs only after shared generation admission and while the
   * same PG transaction holds that lock. Its domain locks must come later.
   * It must use this client and must not BEGIN/COMMIT or open a second writer. */
  withWriter<T>(raw: unknown, work: (client: PoolClient) => Promise<T>): Promise<TransactionResult<T>> {
    const token = state(raw);
    if (token === null || token.mode === "FENCED") return Promise.resolve({ ok: false, reason: "invalid-writer-token" });
    return this.transaction(async client => {
      const transaction = await this.admitExistingTransaction(client, token);
      const value = await work(client);
      if (await this.xid(client) !== transaction) return refuse("writer-transaction-failed");
      return value;
    });
  }

  /** Exclusive compare-and-set. Only LEGACY→FENCED and FENCED→MANAGED exist;
   * a new MANAGED transition also requires an explicit proof callback. */
  transition(input: { expected: unknown; target: unknown; requestId: unknown }): Promise<TransactionResult<TransitionOutcome>> {
    const expected = state(input.expected), target = input.target, requestId = input.requestId;
    if (expected === null || (target !== "FENCED" && target !== "MANAGED")
      || typeof requestId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(requestId)) {
      return Promise.resolve({ ok: false, reason: "invalid-transition" });
    }
    // Encode exact normalized intent; the archive and its state are not authority.
    const intent = JSON.stringify([expected.version, expected.lineage, expected.mode, expected.generation, target]);
    return this.transaction(async client => {
      const current = await this.lockedState(client, true);
      const { rows: [prior] } = await client.query(
        `SELECT intent, before_state, applied_state FROM ${this.schema}.generation_receipts WHERE request_id=$1`,
        [requestId],
      );
      if (prior) {
        if (prior.intent !== intent) return refuse("idempotency-conflict");
        const before = state(prior.before_state), applied = state(prior.applied_state);
        if (!before || !applied || !same(before, expected) || applied.lineage !== this.lineage
          || next(before.mode) !== applied.mode || applied.mode !== target
          || BigInt(applied.generation) !== BigInt(before.generation) + 1n
          || BigInt(applied.generation) > BigInt(current.generation)
          || (applied.generation === current.generation && !same(applied, current))) {
          return refuse("writer-state-unavailable");
        }
        return { before, applied, current, replay: true };
      }
      if (!same(current, expected)) return refuse("stale-generation");
      if (next(current.mode) !== target) return refuse("illegal-transition");
      if (BigInt(current.generation) === generationMax) return refuse("generation-exhausted");
      const transaction = await this.xid(client);
      if (target === "MANAGED" && await this.verifyManagedHandoff?.(client, current) !== true) {
        return refuse("managed-handoff-unproven");
      }
      if (await this.xid(client) !== transaction) return refuse("writer-transaction-failed");
      const { rows: [row] } = await client.query(
        `UPDATE ${this.schema}.generation_state SET phase=$1, generation=generation+1 WHERE id=1
         RETURNING version, lineage::text, phase AS mode, generation::text`, [target],
      );
      const applied = state(row);
      if (!applied || applied.lineage !== this.lineage || applied.mode !== target
        || BigInt(applied.generation) !== BigInt(current.generation) + 1n) return refuse("writer-state-unavailable");
      await client.query(
        `INSERT INTO ${this.schema}.generation_receipts(request_id,intent,before_state,applied_state)
         VALUES ($1,$2,$3::jsonb,$4::jsonb)`,
        [requestId, intent, JSON.stringify(current), JSON.stringify(applied)],
      );
      return { before: current, applied, current: applied, replay: false };
    });
  }
}
