/** Unwired PostgreSQL implementation. No environment reads, DDL/bootstrap or default
 * activation. Requires separately reviewed schema and fresh authority loader.
 * Generic-admin/legacy permission inference is NOT implemented here.
 */
import type { Pool, PoolClient } from 'pg';
import type { NumberingBackend, NumberingTransaction, AppliedNumbering, NumberingOwnerSession } from './patient-numbering-command';
import type { ResolvedStaffAccess } from './staff-capabilities';
import type { PatientNumberingQueryClient } from './patient-numbering-insert-scope';
import type { PrefixSnapshot } from './patient-numbering-policy';
import {
  admitNumberingRecovery, encodeNumberingRecovery, NUMBERING_RECOVERY_MAX_BYTES,
  NUMBERING_RECOVERY_MAX_ROWS, type NumberingRecoverySequence,
} from './patient-numbering-recovery';
import {
  nextAfterNumberingSequence, sameNumberingSequence, validateSurvivingNumberedFiles,
  type NumberingColdReconciliationAuthority,
} from './patient-numbering-cold-reconciliation';
import { parsePatientNumberSequence, restorePatientNumberSequence } from './restore/patient-number-sequence.mjs';

import { encodeManagedNumberingSidecar } from './patient-numbering-recovery-v2';
import { lockManagedNumberingGeneration, validManagedNumberingGeneration, type ExpectedManagedNumberingGeneration } from './patient-numbering-managed-generation';
import { createLockedNumberingDisposition, type NumberingDispositionDependencies } from './patient-numbering-disposition';

class LegacyPReconciliationRefusal extends Error {}

export interface NumberingPostgresDependencies {
  pool: Pool;
  /** Trusted server configuration, never request JSON. Dedicated numbering schema. */
  schema: string;
  /** Reload/lock active identity and credential/binding versions on THIS client. */
  owner?: (client: PoolClient) => Promise<ResolvedStaffAccess | null>;
  /** Unmounted command authority provider: must revalidate on the passed client. */
  ownerSession?: (client: PoolClient) => Promise<NumberingOwnerSession | null>;
  disposition?: NumberingDispositionDependencies;
}
export class PatientNumberingPostgresBackend implements NumberingBackend {
  readonly pool: Pool; readonly schema: string;
  readonly owner: NonNullable<NumberingPostgresDependencies['owner']>;
  readonly ownerSession: NumberingPostgresDependencies['ownerSession'];
  readonly authenticatedOwnerSession?: true;
  private readonly disposition: NumberingDispositionDependencies | undefined;
  constructor(dependencies: NumberingPostgresDependencies) {
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(dependencies.schema)) throw new Error('Invalid trusted schema');
    this.pool=dependencies.pool;this.schema=dependencies.schema;
    this.ownerSession=dependencies.ownerSession;
    this.disposition=dependencies.disposition;
    if(this.disposition && (!this.ownerSession || typeof this.disposition.admitBeforeConfig !== 'function'
      || typeof this.disposition.enrollmentOnLockedClient !== 'function')) throw new Error('Incomplete numbering disposition authority');
    this.authenticatedOwnerSession=this.ownerSession ? true : undefined;
    // Once the authenticated provider is installed, there is no legacy fallback.
    this.owner=this.ownerSession ? async client=>(await this.ownerSession!(client))?.access??null
      : dependencies.owner??(async()=>null);
  }
  protected seq(prefix:string) {
    if (!/^[A-Z]{1,6}$/.test(prefix)) throw new Error('Invalid fixed prefix');
    return `${this.schema}.seq_${prefix.toLowerCase()}`;
  }
  async snapshot(c:PatientNumberingQueryClient,prefix:string):Promise<PrefixSnapshot>{
    const config=(await c.query(`SELECT prefix,revision::text FROM ${this.schema}.config WHERE id=1`)).rows[0];
    const seq=(await c.query(`SELECT last_value::text,is_called FROM ${this.seq(prefix)}`)).rows[0];
    const history=(await c.query(`SELECT historical::text,complete FROM ${this.schema}.history WHERE prefix=$1`,[prefix])).rows[0];
    if(typeof config?.prefix !== "string" || typeof config.revision !== "string"
      || typeof seq?.last_value !== "string" || typeof seq.is_called !== "boolean"
      || typeof history?.historical !== "string" || typeof history.complete !== "boolean") {
      throw new Error('Numbering state unavailable');
    }
    return {prefix,allocatedThrough:seq.is_called?BigInt(seq.last_value):0n,pendingNext:seq.is_called?null:BigInt(seq.last_value),historicalThrough:BigInt(history.historical),historyComplete:history.complete,
      revision:`${config.revision}:${config.prefix}:${prefix}:${seq.last_value}:${seq.is_called?'1':'0'}:${history.historical}:${history.complete?'1':'0'}`};
  }
  protected async locked<T>(work:(c:PoolClient)=>Promise<T>, beforeConfigLock?:(c:PoolClient)=>Promise<void>):Promise<T>{
    const c=await this.pool.connect();try{
      await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='5s'");
      await beforeConfigLock?.(c);
      const locked=await c.query(`SELECT id FROM ${this.schema}.config WHERE id=1 FOR UPDATE`);
      if(locked.rowCount!==1)throw new Error('Numbering configuration missing');
      const value=await work(c);await c.query('COMMIT');return value;
    }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }
  transaction<T>(work:(tx:NumberingTransaction)=>Promise<T>):Promise<T>{return this.locked(async c=>{
    const disposition=this.disposition&&createLockedNumberingDisposition(c,this.schema,this.disposition);
    return work({
    ...(disposition ? {disposition} : {}),
    owner:()=>this.owner(c),
    ...(this.ownerSession?{ownerSession:()=>this.ownerSession!(c)}:{}),
    replay:async(actor,request)=>{
      if(disposition && await disposition.inspect(actor,request)==='unknown') return null;
      const row=(await c.query(`SELECT intent,result FROM ${this.schema}.receipts WHERE actor=$1 AND request=$2`,[actor,request])).rows[0];return row??null;},
    snapshot:prefix=>this.snapshot(c,prefix),
    currentNumbering:async()=>{
      const { rows: [row] }=await c.query(`SELECT prefix FROM ${this.schema}.config WHERE id=1`);
      if(typeof row?.prefix!=="string")throw new Error('Numbering configuration missing');
      return this.snapshot(c,row.prefix);
    },
    apply:async input=>{
      const before=await this.snapshot(c,input.prefix);
      if(before.revision!==input.expectedRevision)throw new Error('Stale locked state');
      // Positive numeric string comes from strict policy; no raw identifier or SQL input.
      if(!/^[1-9][0-9]{0,17}$/.test(input.next))throw new Error('Invalid number');
      if(disposition && (input.dispositionExpiry===undefined
        || !await disposition.consume(input.actorId,input.requestId,input.dispositionExpiry))) throw new Error('Disposition not open');
      await c.query(`ALTER SEQUENCE ${this.seq(input.prefix)} RESTART WITH ${input.next}`);
      await c.query(`UPDATE ${this.schema}.config SET prefix=$1,revision=revision+1 WHERE id=1`,[input.prefix]);
      const after=await this.snapshot(c,input.prefix);
      const result:AppliedNumbering={prefix:input.prefix,next:input.next,preview:input.preview,revision:after.revision};
      const serialized=(s:PrefixSnapshot)=>JSON.stringify(s,(_k,v)=>typeof v==='bigint'?v.toString():v);
      await c.query(`INSERT INTO ${this.schema}.audit(actor,reason,before_state,after_state) VALUES($1,$2,$3::jsonb,$4::jsonb)`,[input.actorId,input.reason,serialized(before),serialized(after)]);
      await c.query(`INSERT INTO ${this.schema}.receipts(actor,request,intent,result) VALUES($1,$2,$3,$4::jsonb)`,[input.actorId,input.requestId,input.intent,JSON.stringify(result)]);
      return result;
    }
    });
  },this.disposition ? async c=>{
    const admitted=await this.disposition!.admitBeforeConfig(c);
    const {rows:[row]}=await c.query("SELECT pg_current_xact_id_if_assigned()::text AS xid");
    if(typeof admitted!=="string" || !/^[1-9][0-9]*$/.test(admitted) || row?.xid!==admitted) {
      throw new Error('Writer generation not admitted on this transaction');
    }
  } : undefined);}
  /** No SQL, DDL, paths, or relation names are read from an archive. All
   * fixed projection queries run under the allocator lock. This export is
   * deliberately unwired and refuses missing alias storage or missing proofs;
   * future alias writers must take this same lock, and live cross-checks remain
   * a separately governed part of capture/cutover. */
  exportRecoverySidecar(trustedLineage: string) {
    return this.locked(client => this.readRecoveryProjection(client, trustedLineage));
  }
  private async readRecoveryProjection(client: PoolClient, trustedLineage: string) {
    return encodeNumberingRecovery(await this.readRecoveryState(client, trustedLineage));
  }
  /** Locks cooperative managed writers before config and captures the same
   * fixed projections, including ledger-only rows. Unwired; does not create
   * an independent witness or coordinate an application archive. */
  async exportManagedRecoverySidecar(expected: ExpectedManagedNumberingGeneration) {
    if (!validManagedNumberingGeneration(expected)) throw new Error("Managed generation not configured");
    const exact = Object.freeze({ ...expected });
    return this.locked(async client => {
      const numbering = await this.readRecoveryState(client, exact.lineage);
      const limit = NUMBERING_RECOVERY_MAX_ROWS + 1;
      const { rows: [budget] } = await client.query(
        `SELECT COALESCE(SUM(n::bigint),0) AS bytes FROM
           (SELECT octet_length(lineage)::bigint + octet_length(enrollment)
              + octet_length(request) + octet_length(state) + 80 AS n
              FROM ${this.schema}.preview_dispositions LIMIT $1) ledger`, [limit],
      );
      if (BigInt(budget.bytes) > BigInt(NUMBERING_RECOVERY_MAX_BYTES)) throw new Error("Oversize numbering disposition projection");
      const { rows: dispositions } = await client.query(
        `SELECT CASE WHEN length(lineage) = 36 THEN lineage END AS lineage,
                CASE WHEN length(enrollment) <= 128 THEN enrollment END AS enrollment,
                actor::text, CASE WHEN length(request) <= 128 THEN request END AS request,
                expires_at_ms::text AS "expiresAtMs", CASE WHEN length(state) <= 9 THEN state END AS state
           FROM ${this.schema}.preview_dispositions LIMIT $1`, [limit],
      );
      return encodeManagedNumberingSidecar({ version: 2, managed: {
        phase: "MANAGED", lineage: exact.lineage, generation: exact.generation,
      }, numbering, dispositions });
    }, async client => { await lockManagedNumberingGeneration(client, exact); });
  }
  private async readRecoveryState(client: PoolClient, trustedLineage: string) {
    const { rows: [config] } = await client.query(
      `SELECT prefix, revision::text FROM ${this.schema}.config WHERE id=1`,
    );
    const { rows: history } = await client.query(
      `SELECT prefix, historical::text AS "historicalThrough", complete AS "historyComplete"
         FROM ${this.schema}.history LIMIT 27`,
    );
    const counters = [];
    if (history.length !== 26) throw new Error('Incomplete numbering history projection');
    for (const row of history) {
      if (typeof row.prefix !== 'string' || !/^[A-Z]$/.test(row.prefix)) throw new Error('Invalid numbering history prefix');
      const { rows: [seq] } = await client.query(
        `SELECT last_value::text AS "lastValue", is_called AS "isCalled" FROM ${this.seq(row.prefix)}`,
      );
      counters.push({ ...row, ...seq });
    }
    const { rows: [auditSequence] } = await client.query(
      `SELECT last_value::text AS "lastValue", is_called AS "isCalled" FROM ${this.schema}.audit_id_seq`,
    );
    const limit = NUMBERING_RECOVERY_MAX_ROWS + 1;
    // Under the allocator lock, check the aggregate raw projection size
    // before materializing results in Node. The codec enforces the exact
    // canonical archive size independently before emitting any bytes.
    const { rows: [budget] } = await client.query(
      `SELECT
          (SELECT COALESCE(SUM(n::bigint),0) FROM
            (SELECT octet_length(number) AS n FROM ${this.schema}.retired_aliases LIMIT $1) a)
        + (SELECT COALESCE(SUM(n::bigint),0) FROM
            (SELECT octet_length(reason)::bigint + octet_length(before_state::text) + octet_length(after_state::text) AS n
               FROM ${this.schema}.audit LIMIT $1) e)
        + (SELECT COALESCE(SUM(n::bigint),0) FROM
            (SELECT octet_length(request)::bigint + octet_length(intent) + octet_length(result::text) AS n
               FROM ${this.schema}.receipts LIMIT $1) r) AS bytes`, [limit],
    );
    if (BigInt(budget.bytes) > BigInt(NUMBERING_RECOVERY_MAX_BYTES)) throw new Error('Oversize numbering recovery projection');
    // The proposed alias registry is required, never inferred from surviving
    // rows or allowed to silently become an empty array when absent.
    const { rows: retiredAliases } = await client.query(
      `SELECT CASE WHEN length(number) <= 20 THEN number END AS number,
              patient_id::text AS "patientId" FROM ${this.schema}.retired_aliases LIMIT $1`, [limit],
    );
    const { rows: audit } = await client.query(
      `SELECT id::text, actor::text,
              CASE WHEN octet_length(reason) <= 2048 THEN reason END AS reason,
              CASE WHEN octet_length(before_state::text) <= 2048 THEN before_state END AS "beforeState",
              CASE WHEN octet_length(after_state::text) <= 2048 THEN after_state END AS "afterState"
         FROM ${this.schema}.audit LIMIT $1`, [limit],
    );
    const { rows: receipts } = await client.query(
      `SELECT actor::text,
              CASE WHEN length(request) <= 128 THEN request END AS request,
              CASE WHEN octet_length(intent) <= 16384 THEN intent END AS intent,
              CASE WHEN octet_length(result::text) <= 2048 THEN result END AS result
         FROM ${this.schema}.receipts LIMIT $1`, [limit],
    );
    return {
      version: 1, lineage: trustedLineage, activePrefix: config?.prefix, configRevision: config?.revision,
      counters, auditSequence, retiredAliases, audit, receipts,
    };
  }

  /** Standalone reconciliation, deliberately not an app bootstrap or restore
   * caller. It never moves the managed namespace, only the legacy P mirror.
   * Missing/stale evidence and an ahead legacy counter require explicit
   * reconciliation; neither is permission to enable or fall back.
   * Callers need an independent fenced witness; this does not create one. */
  async reconcileProvenLegacyP(
    archive: { bytes: Uint8Array; manifest: unknown },
    trustedAuthority: NumberingColdReconciliationAuthority | null,
  ): Promise<{ ok: true; next: string } | { ok: false; reason: string }> {
    function refuse(reason: string): never { throw new LegacyPReconciliationRefusal(reason); }
    async function readTrustedState() {
      let legacyP: NumberingRecoverySequence | null = null;
      const admitted = await admitNumberingRecovery(archive.bytes, archive.manifest, trustedAuthority ? {
        expectedLineage: trustedAuthority.expectedLineage,
        readCurrent: async lineage => {
          const proof = await trustedAuthority.readCurrent(lineage);
          if (!proof?.legacyP) return null;
          legacyP = parsePatientNumberSequence(proof.legacyP.lastValue, proof.legacyP.isCalled);
          return proof;
        },
      } : null);
      if (!admitted.ok) return refuse(admitted.reason);
      if (legacyP === null) return refuse('trusted-legacy-P-witness-unavailable');
      return { state: admitted.payload, legacyP };
    }
    try {
      return await this.locked(async client => {
        const proof = await readTrustedState();
        const state = proof.state;
        const expected = encodeNumberingRecovery(state).manifest.sha256;
        if ((await this.readRecoveryProjection(client, state.lineage)).manifest.sha256 !== expected) {
          return refuse('restored-numbering-state-mismatch');
        }
        // Take patients only AFTER patient_import (exclusive) -> config.
        // This freezes normal competing clinical INSERT/UPDATE/DELETE while
        // we verify the surviving identities. No patient row is changed.
        await client.query('LOCK TABLE public.patients IN SHARE MODE');
        const { rows } = await client.query(
          `SELECT id::text AS "patientId",
                  CASE WHEN octet_length(patient_number) <= 20 THEN patient_number END AS number
             FROM public.patients LIMIT $1`,
          [NUMBERING_RECOVERY_MAX_ROWS + 1],
        );
        if (rows.length > NUMBERING_RECOVERY_MAX_ROWS) return refuse('patient-identity-proof-too-large');
        const verified = validateSurvivingNumberedFiles(state, rows);
        if (!verified.ok) return refuse(verified.reason);
        const p = state.counters.find(counter => counter.prefix === 'P');
        if (!p) return refuse('legacy-P-continuity-unproven');
        if (nextAfterNumberingSequence(proof.legacyP) > nextAfterNumberingSequence(p)) return refuse('independent-legacy-P-ahead');
        // Existing helper takes a transactional sequence lock and never
        // rewinds. Require the raw result while holding its lock: a target
        // with an equivalent next value but different called state is HOLD,
        // never permission to rewrite a sequence backwards to canonicalize it.
        await restorePatientNumberSequence(client, { lastValue: p.lastValue, isCalled: p.isCalled });
        const { rows: [legacy] } = await client.query('SELECT last_value::text, is_called FROM public.patient_number_seq');
        const actual = parsePatientNumberSequence(legacy?.last_value, legacy?.is_called);
        if (!sameNumberingSequence(actual, p)) return refuse('legacy-P-state-mismatch');
        // A stale witness during this transaction rolls the mirror back.
        // A private seam cannot fence source-side issuance after this read.
        const final = await readTrustedState();
        if (encodeNumberingRecovery(final.state).manifest.sha256 !== expected || !sameNumberingSequence(final.legacyP, proof.legacyP)) {
          return refuse('recovery-proof-changed');
        }
        return { ok: true as const, next: nextAfterNumberingSequence(actual).toString() };
      }, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('patient_import'))");
      });
    } catch (error) {
      return { ok: false, reason: error instanceof LegacyPReconciliationRefusal
        ? error.message : 'legacy-P-reconciliation-failed' };
    }
  }
  preview(prefix:string){return this.locked(c=>this.snapshot(c,prefix));}
  /** The caller already owns BEGIN/COMMIT on this client and must take the
   * applicable patient_import lock first. Never opens a nested transaction.
   * The same config row serializes owner command, export and every allocator. */
  async allocateInExistingTransaction(client: PatientNumberingQueryClient): Promise<string> {
    const { rows } = await client.query(`SELECT prefix FROM ${this.schema}.config WHERE id=1 FOR UPDATE`);
    const prefix = rows[0]?.prefix;
    if (rows.length !== 1 || typeof prefix !== "string") throw new Error('Numbering configuration missing');
    // A successful row lock assigns an XID. Autocommit releases the row and
    // ends that XID before this read, so even an accidentally passed Pool
    // cannot allocate (or silently survive a transaction ended mid-call).
    const { rows: [transaction] } = await client.query("SELECT pg_current_xact_id_if_assigned()::text AS xid");
    if (typeof transaction?.xid !== "string") throw new Error('Existing allocator transaction required');
    const state = await this.snapshot(client, prefix);
    if (!state.historyComplete) throw new Error('Numbering history unverified');
    const next = state.pendingNext ?? state.allocatedThrough + 1n;
    if (next <= state.historicalThrough) throw new Error('Numbering history requires reconciliation');
    const { rows: [allocated] } = await client.query(
      `SELECT CASE WHEN pg_current_xact_id_if_assigned()::text=$1 THEN nextval('${this.seq(prefix)}')::text END AS n`,
      [transaction.xid],
    );
    if (typeof allocated?.n !== "string" || BigInt(allocated.n) !== next) {
      throw new Error('Numbering state changed outside allocator lock');
    }
    return `${prefix}-${allocated.n.padStart(5,'0')}`;
  }
  /** This wrapper owns BEGIN/COMMIT. Do not nest it inside a patient transaction.
   * Existing caller must move its insertion into work and use the SAME client.
   * Every creation/import/bootstrap/reset path must adopt one reviewed lock order.
   */
  withAllocationTransaction<T>(work:(client:PoolClient, allocate:()=>Promise<string>)=>Promise<T>):Promise<T>{
    return this.locked(async client=>{
      let active=true;
      try {return await work(client,async()=>{
        if(!active)throw new Error('Allocation scope expired');
        return this.allocateInExistingTransaction(client);
      });}finally{active=false;}
    });
  }
}
/** Default-deny configuration; importing this module never opens a connection. */
export function createPatientNumberingPostgresBackend(
  dependencies: NumberingPostgresDependencies | null = null,
): PatientNumberingPostgresBackend | null {
  return dependencies ? new PatientNumberingPostgresBackend(dependencies) : null;
}
/** Explicit legacy behavior is unchanged when unconfigured. An installed backend
 * failure NEVER falls back to legacy allocation, which could issue duplicates.
 */
export function withPatientNumberingMode<T>(
  backend:PatientNumberingPostgresBackend|null,
  legacy:()=>Promise<T>,
  configured:(client:PoolClient,allocate:()=>Promise<string>)=>Promise<T>,
):Promise<T>{return backend===null?legacy():backend.withAllocationTransaction(configured);}
