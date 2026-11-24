/** Uninstalled ledger contract. Identifiers refer to independent, immutable owner
 * enrollment and DB lineage, not a display name, mutable role, session, or token.
 * The trusted resolver must read/recheck both on the existing PostgreSQL client. */
import type { PoolClient } from "pg";
import { isNumberingRequestId } from "./patient-numbering-settings-contract";

export interface NumberingEnrollment {
  lineage: string;
  enrollment: string;
  actorId: number;
}
export interface NumberingDispositionDependencies {
  // Must take real generation admission before the allocator's config lock.
  // Return the assigned transaction identity from admission, not a boolean.
  admitBeforeConfig(client: PoolClient): Promise<string>;
  enrollmentOnLockedClient(client: PoolClient): Promise<NumberingEnrollment | null>;
  /** Shorter leases may be used in a disposable fixture. Never client supplied. */
  ttlMs?: number;
}
type Status = "open" | "expired" | "committed" | "retired" | "unknown";
export interface NumberingDisposition {
  ready(actorId: number): Promise<boolean>;
  databaseDeadline(): Promise<number>;
  register(actorId: number, id: string, expiresAt: number, checkAuthority: () => Promise<void>): Promise<boolean>;
  inspect(actorId: number, id: string, expiresAt?: number): Promise<Status>;
  retire(actorId: number, id: string, checkAuthority: () => Promise<void>): Promise<Status>;
  consume(actorId: number, id: string, expiresAt: number, checkAuthority: () => Promise<void>): Promise<boolean>;
}
const dbClock = "floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint";
const immutableIdentifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const milliseconds = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

export function createLockedNumberingDisposition(client: PoolClient, schema: string,
  dependencies: NumberingDispositionDependencies): NumberingDisposition {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid disposition schema");
  const ttl = dependencies.ttlMs ?? 60_000;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60_000) throw new Error("Invalid preview TTL");
  const table = `${schema}.preview_dispositions`;
  let firstBinding: NumberingEnrollment | null = null, lostBinding = false;
  async function identity(actor: number): Promise<NumberingEnrollment | null> {
    if (lostBinding || !Number.isSafeInteger(actor) || actor <= 0) return null;
    const binding = await dependencies.enrollmentOnLockedClient(client);
    if (!binding || binding.actorId !== actor || !immutableIdentifier(binding.lineage)
      || !immutableIdentifier(binding.enrollment)
      || (firstBinding && (binding.lineage !== firstBinding.lineage
        || binding.enrollment !== firstBinding.enrollment || binding.actorId !== firstBinding.actorId))) {
      lostBinding = true; return null;
    }
    firstBinding ??= { ...binding };
    return firstBinding;
  }
  async function bind(actor: number, id: string): Promise<[string, string, number, string] | null> {
    if (!isNumberingRequestId(id)) return null;
    const binding = await identity(actor);
    return binding && [binding.lineage, binding.enrollment, actor, id];
  }
  async function inspect(actor: number, id: string, expiresAt?: number): Promise<Status> {
    const keys = await bind(actor, id);
    if (!keys || (expiresAt !== undefined && !milliseconds(expiresAt))) return "unknown";
    const { rows: [row] } = await client.query(
      `SELECT state, expires_at_ms::text, expires_at_ms <= ${dbClock} AS expired
        FROM ${table} WHERE lineage=$1 AND enrollment=$2 AND actor=$3 AND request=$4 FOR UPDATE`, keys);
    if (!row || typeof row.expires_at_ms !== "string" || !milliseconds(Number(row.expires_at_ms))
      || (expiresAt !== undefined && String(expiresAt) !== row.expires_at_ms)) return "unknown";
    if (row.state === "committed" || row.state === "retired") return row.state;
    if (row.state !== "issued" || typeof row.expired !== "boolean") return "unknown";
    return row.expired ? "expired" : "open";
  }
  const filter = "lineage=$1 AND enrollment=$2 AND actor=$3 AND request=$4 AND state='issued'";
  return {
    async ready(actor) {
      if (!await identity(actor)) return false;
      await client.query(`SELECT lineage,enrollment,actor,request,expires_at_ms,state FROM ${table} LIMIT 0`);
      return true;
    },
    async databaseDeadline() {
      const { rows: [row] } = await client.query(`SELECT (${dbClock} + $1::bigint)::text AS deadline`, [ttl]);
      const expiresAt = Number(row?.deadline);
      if (!milliseconds(expiresAt)) throw new Error("Preview database clock unavailable");
      return expiresAt;
    },
    async register(actor, id, expiresAt, checkAuthority) {
      const keys = await bind(actor, id);
      if (!keys || !milliseconds(expiresAt)) return false;
      // Never resurrect or silently renew an exact ID. IDs are globally unique
      // within this ledger; a conflict is nondisclosing and fail closed.
      await checkAuthority();
      const inserted = await client.query(`INSERT INTO ${table} (lineage,enrollment,actor,request,expires_at_ms,state)
        SELECT $1,$2,$3,$4,$5::bigint,'issued' WHERE $5::bigint > ${dbClock}
        AND $5::bigint <= ${dbClock} + $6::bigint ON CONFLICT DO NOTHING`, [...keys, expiresAt, ttl]);
      return inserted.rowCount === 1;
    },
    inspect,
    async retire(actor, id, checkAuthority) {
      const keys = await bind(actor, id);
      if (!keys) return "unknown";
      await checkAuthority();
      const update = await client.query(`UPDATE ${table} SET state='retired'
        WHERE ${filter} AND expires_at_ms <= ${dbClock}`, keys);
      return update.rowCount === 1 ? "retired" : inspect(actor, id);
    },
    async consume(actor, id, expiresAt, checkAuthority) {
      const keys = await bind(actor, id);
      if (!keys || !milliseconds(expiresAt)) return false;
      // Direct generic commands cannot bypass an installed ledger. This update
      // linearizes admission; existing counter/audit/receipt writes commit or
      // roll back atomically together on this same client/config transaction.
      await checkAuthority();
      const update = await client.query(`UPDATE ${table} SET state='committed'
        WHERE ${filter} AND expires_at_ms=$5::bigint AND expires_at_ms > ${dbClock}`, [...keys, expiresAt]);
      return update.rowCount === 1;
    },
  };
}
