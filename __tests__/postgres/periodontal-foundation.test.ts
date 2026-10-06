import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DbClient, DbPool, QueryResult } from "../../lib/db";
import { createPeriodontalDomain, periodontalHistoryCount } from "../../lib/periodontal-db";
import { PERIODONTAL_SQL } from "../../lib/periodontal-schema";
import { emptyPeriodontalSites, type PeriodontalSite } from "../../lib/periodontal";
import { openPeriodontalFixture } from "./_periodontal-fixture";

// AUTHORED FOR CI; not run locally. SQL, transactions, triggers, locks, audit and
// canonical patient merge are real. Only authorization is a synthetic principal.
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>> | undefined;
const ACTOR = "synthetic-periodontal-foundation";
let serial = 0;
const nextKey = () => `perio:pg-${++serial}`;
const pool = () => fixture!.pool;
const domain = (source: DbPool = pool()) => createPeriodontalDomain({ pool: source,
  authorizePatient: async () => ({ username: ACTOR, role: "admin" }),
  insertAudit: (client, audit) => fixture!.db.insertAuditRow(client, audit) });
const draft = (requestKey = nextKey(), expectedHeadId: number | null = null, toothCode = 16) => {
  const sites = emptyPeriodontalSites(); sites[0].depthMm = "3.50"; sites[1].bleeding = false;
  return { toothCode, expectedHeadId, requestKey, sites };
};
async function patient() {
  return (await pool().query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id", [`SYN-PERIO-${++serial}`])).rows[0].id;
}
async function save(patientId: number, input = draft()) {
  const result = await domain().save(patientId, input);
  if (!result.ok) throw new Error(result.message);
  return result.record;
}
async function state(patientId: number) {
  const records = (await pool().query("SELECT * FROM periodontal_records WHERE patient_id=$1 ORDER BY id", [patientId])).rows;
  const sites = (await pool().query(`SELECT s.* FROM periodontal_sites s JOIN periodontal_records r ON r.id=s.record_id
    WHERE r.patient_id=$1 ORDER BY s.record_id,s.surface,s.position`, [patientId])).rows;
  const audits = (await pool().query("SELECT * FROM audit_log WHERE action='perio.record' AND entity_id=$1 ORDER BY id", [String(patientId)])).rows;
  return { records, sites, audits };
}
async function transaction<T>(run: (client: DbClient) => Promise<T>) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout='8s'");
    await client.query("SET LOCAL lock_timeout='8s'");
    const result = await run(client); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
async function rawRevision(client: DbClient, patientId: number, options: {
  priorId?: number; toothCode?: number; sites?: PeriodontalSite[]; requestKey?: string; fingerprint?: string;
} = {}) {
  const sites = options.sites ?? draft().sites;
  const { rows: [record] } = await client.query<{ id: number }>(`INSERT INTO periodontal_records
    (patient_id,tooth_code,prior_record_id,request_key,request_fingerprint,recorded_by)
    VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
  [patientId, options.toothCode ?? 16, options.priorId ?? null, options.requestKey ?? nextKey(), options.fingerprint ?? "a".repeat(64), ACTOR]);
  for (const site of sites) await client.query(`INSERT INTO periodontal_sites
    (record_id,surface,position,depth_mm,bleeding) VALUES ($1,$2,$3,$4::numeric,$5)`,
  [record.id, site.surface, site.position, site.depthMm, site.bleeding]);
  return record.id;
}
async function noForeignPredecessors() {
  const { rows: [row] } = await pool().query<{ count: number }>(`SELECT count(*)::int AS count
    FROM periodontal_records child JOIN periodontal_records parent ON parent.id=child.prior_record_id
    WHERE child.patient_id<>parent.patient_id OR child.tooth_code<>parent.tooth_code`);
  expect(row.count).toBe(0);
}
async function until(check: () => Promise<boolean>, label: string) {
  const end = performance.now() + 6_000;
  while (performance.now() < end) { if (await check()) return; await delay(10); }
  throw new Error(`Periodontal PG witness timed out: ${label}`);
}
const observed = <T>(promise: Promise<T>) => promise.then((value) => ({ value }), (error: unknown) => ({ error }));
function unwrap<T>(result: { value: T } | { error: unknown }): T {
  if ("error" in result) throw result.error;
  return result.value;
}
function trackingPool(afterHead?: () => Promise<void>) {
  const pids: number[] = [];
  const source: DbPool = {
    query: pool().query.bind(pool()),
    async connect() {
      const client = await pool().connect(); const query = client.query.bind(client);
      try { pids.push((await query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid); }
      catch (error) { client.release(); throw error; }
      return {
        async query<T>(sql: string, values: unknown[] = []): Promise<QueryResult<T>> {
          const result = await query<T>(sql, values);
          if (sql === "BEGIN") { await query("SET LOCAL statement_timeout='8s'"); await query("SET LOCAL lock_timeout='8s'"); }
          // Scheduling only: forward exact statements/values and the unmodified real result.
          if (afterHead && sql.startsWith("SELECT id FROM periodontal_records")) await afterHead();
          return result;
        },
        release: () => client.release(),
      };
    },
  };
  return { source, pids };
}
async function blockedSaves(patientId: number, inputs: ReturnType<typeof draft>[]) {
  const blocker = await pool().connect(); const tracked = trackingPool();
  const pending: ReturnType<typeof observed<Awaited<ReturnType<ReturnType<typeof domain>["save"]>>>>[] = [];
  try {
    await blocker.query("BEGIN"); await blocker.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [patientId]);
    for (const input of inputs) pending.push(observed(domain(tracked.source).save(patientId, input)));
    await until(async () => {
      if (tracked.pids.length !== inputs.length) return false;
      const { rows: [row] } = await pool().query<{ count: number }>(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND pid=ANY($1::int[]) AND wait_event_type='Lock'`, [tracked.pids]);
      return row.count === inputs.length;
    }, "all save clients wait on the actual patient row lock");
    await blocker.query("COMMIT");
    return (await Promise.all(pending)).map(unwrap);
  } finally {
    await blocker.query("ROLLBACK").catch(() => {}); blocker.release(); await Promise.all(pending);
  }
}

beforeAll(async () => { fixture = await openPeriodontalFixture(); }, 180_000);
afterAll(async () => { await fixture?.close(); }, 30_000);

describe("proposed periodontal DDL on fresh owned PostgreSQL", () => {
  it("protects a deferred composite predecessor identity in both directions", async () => {
    const { rows } = await pool().query<{ definition: string; condeferrable: boolean; condeferred: boolean }>(`SELECT
      pg_get_constraintdef(oid) AS definition,condeferrable,condeferred FROM pg_constraint
      WHERE conrelid='periodontal_records'::regclass AND conname='periodontal_record_predecessor_owner'`);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ condeferrable: true, condeferred: true });
    expect(rows[0].definition).toContain("FOREIGN KEY (prior_record_id, patient_id, tooth_code)");
    expect(rows[0].definition).toContain("REFERENCES periodontal_records(id, patient_id, tooth_code)");
    const a = await patient(), b = await patient(); const root = await save(a); const child = await save(a, draft(nextKey(), root.id));
    const before = await state(a);
    // Incoming edge: moving the predecessor alone must fail at COMMIT.
    await expect(transaction(async (client) => { await client.query("UPDATE periodontal_records SET patient_id=$2 WHERE id=$1", [root.id, b]); }))
      .rejects.toMatchObject({ code: "23503" });
    // Outgoing edge: moving the referencing record alone must also fail.
    await expect(transaction(async (client) => { await client.query("UPDATE periodontal_records SET patient_id=$2 WHERE id=$1", [child.id, b]); }))
      .rejects.toMatchObject({ code: "23503" });
    expect(await state(a)).toEqual(before); expect((await state(b)).records).toEqual([]); await noForeignPredecessors();
  });
  it("rejects cross-patient and cross-tooth predecessors on direct insert", async () => {
    const a = await patient(), b = await patient(), root = await save(a);
    await expect(transaction((client) => rawRevision(client, b, { priorId: root.id }))).rejects.toMatchObject({ code: "23503" });
    await expect(transaction((client) => rawRevision(client, a, { priorId: root.id, toothCode: 17 }))).rejects.toMatchObject({ code: "23503" });
    expect((await state(a)).records).toHaveLength(1); expect((await state(b)).records).toHaveLength(0);
  });
  it("allows a whole-history ownership move to settle before deferred checking", async () => {
    const a = await patient(), b = await patient(), first = await save(a); await save(a, draft(nextKey(), first.id));
    const before = await state(a);
    await transaction(async (client) => { await client.query("UPDATE periodontal_records SET patient_id=$2 WHERE patient_id=$1", [a, b]); });
    const after = await state(b);
    expect(after.records.map((row) => ({ ...row, patient_id: a }))).toEqual(before.records);
    expect(after.sites).toEqual(before.sites); await noForeignPredecessors();
  });
  it("refuses incomplete/empty snapshots at commit and keeps clinical values immutable", async () => {
    const a = await patient(); const before = await state(a);
    await expect(transaction((client) => rawRevision(client, a, { sites: draft().sites.slice(0, 5) }))).rejects.toMatchObject({ code: "P0001" });
    await expect(transaction((client) => rawRevision(client, a, { sites: emptyPeriodontalSites() }))).rejects.toMatchObject({ code: "P0001" });
    expect(await state(a)).toEqual(before);
    const row = await save(a);
    for (const sql of ["UPDATE periodontal_sites SET depth_mm=9 WHERE record_id=$1", "DELETE FROM periodontal_sites WHERE record_id=$1",
      "UPDATE periodontal_records SET recorded_by='replacement' WHERE id=$1", "DELETE FROM periodontal_records WHERE id=$1"]) {
      await expect(pool().query(sql, [row.id])).rejects.toMatchObject({ code: "P0001" });
    }
  });
  it.each(["\n", "\r", "\r\n", "\u2028", "\u2029"])("rejects raw key/fingerprint terminator %j in PostgreSQL too", async (suffix) => {
    const a = await patient();
    for (const key of [`valid-key${suffix}`, `${"k".repeat(128)}${suffix}`]) {
      await expect(transaction((client) => rawRevision(client, a, { requestKey: key }))).rejects.toMatchObject({ code: "23514" });
    }
    await expect(transaction((client) => rawRevision(client, a, { fingerprint: `${"a".repeat(64)}${suffix}` })))
      .rejects.toMatchObject({ code: "23514" });
    expect((await state(a)).records).toHaveLength(0);
  });
  it("reapplies the proposal without changing saved values or replacing ownership semantics", async () => {
    const a = await patient(); await save(a); const before = await state(a);
    await pool().query(PERIODONTAL_SQL); await pool().query(PERIODONTAL_SQL);
    expect(await state(a)).toEqual(before); await noForeignPredecessors();
  });
  it("serializes a deferred FK check against a concurrent predecessor owner move", async () => {
    const a = await patient(), b = await patient(), root = await save(a);
    const mover = await pool().connect(), append = await pool().connect();
    let pending: ReturnType<typeof observed<QueryResult>> | undefined;
    try {
      await mover.query("BEGIN"); await mover.query("SET LOCAL statement_timeout='8s'");
      await mover.query("UPDATE periodontal_records SET patient_id=$2 WHERE id=$1", [root.id, b]);
      await append.query("BEGIN"); await append.query("SET LOCAL statement_timeout='8s'");
      const pid = (await append.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      await rawRevision(append, a, { priorId: root.id });
      pending = observed(append.query("COMMIT"));
      await until(async () => (await pool().query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE pid=$1 AND wait_event_type='Lock') AS waiting`, [pid])).rows[0].waiting, "deferred FK waits for changed predecessor");
      await mover.query("COMMIT");
      const outcome = await pending; expect("error" in outcome && outcome.error).toMatchObject({ code: "23503" });
      expect((await state(a)).records).toHaveLength(0); expect((await state(b)).records).toHaveLength(1);
      await noForeignPredecessors();
    } finally {
      await mover.query("ROLLBACK").catch(() => {}); mover.release();
      await pending; await append.query("ROLLBACK").catch(() => {}); append.release();
    }
  });
});

describe("inactive periodontal domain with real PostgreSQL and audit", () => {
  it("round-trips exact depth/null/false values and atomically writes the audit", async () => {
    const a = await patient(); const body = draft(); body.sites[2].depthMm = "0"; body.sites[3].depthMm = "0.00000000000001";
    const row = await save(a, body); const read = await domain().read(a);
    expect(read).toMatchObject({ ok: true, records: [row], nextBeforeId: null });
    expect(row.sites.map((site) => site.depthMm)).toEqual(["3.5", null, "0", "0.00000000000001", null, null]);
    expect(row.sites[1].bleeding).toBe(false); expect(row.sites[0].bleeding).toBeNull();
    const saved = await state(a); expect(saved.records).toHaveLength(1); expect(saved.sites).toHaveLength(6); expect(saved.audits).toHaveLength(1);
    expect(saved.audits[0]).toMatchObject({ actor: ACTOR, actor_role: "admin" });
  });
  it("allows only one winner from two actual patient-lock waiters with the same expected head", async () => {
    const a = await patient(); const results = await blockedSaves(a, [draft(), draft()]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([expect.objectContaining({ reason: "head_conflict" })]);
    const saved = await state(a); expect(saved.records).toHaveLength(1); expect(saved.audits).toHaveLength(1);
  });
  it("reconciles concurrent identical keys and a later unknown-response retry without another effect", async () => {
    const a = await patient(); const body = draft(); const results = await blockedSaves(a, [body, structuredClone(body)]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(results.filter((result) => result.ok && result.replayed)).toHaveLength(1);
    expect(await domain().save(a, body)).toMatchObject({ ok: true, replayed: true });
    const saved = await state(a); expect(saved.records).toHaveLength(1); expect(saved.audits).toHaveLength(1);
  });
  it("resolves a same-key cross-patient race without returning another patient's record", async () => {
    const a = await patient(), b = await patient(); const body = draft();
    let arrived = 0; let open!: () => void; const gate = new Promise<void>((resolve) => { open = resolve; });
    const tracked = trackingPool(async () => { arrived++; if (arrived === 2) open(); await gate; });
    const pending = [observed(domain(tracked.source).save(a, body)), observed(domain(tracked.source).save(b, body))];
    try {
      await until(async () => arrived === 2, "both real head reads completed before either insert");
      const results = (await Promise.all(pending)).map(unwrap);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([expect.objectContaining({ reason: "request_conflict" })]);
      expect(results[0].ok ? results[0].record.patientId : results[1].ok && results[1].record.patientId).toBe(results[0].ok ? a : b);
      expect((await state(a)).records.length + (await state(b)).records.length).toBe(1);
      expect((await state(a)).audits.length + (await state(b)).audits.length).toBe(1);
    } finally { open(); await Promise.all(pending); }
  });
  it("rolls back header, sites and an actual inserted audit if the transaction fails", async () => {
    const a = await patient(); const before = await state(a);
    const failing = createPeriodontalDomain({ pool: pool(), authorizePatient: async () => ({ username: ACTOR, role: "admin" }),
      insertAudit: async (client, audit) => { await fixture!.db.insertAuditRow(client, audit); throw new Error("synthetic audit failure"); } });
    await expect(failing.save(a, draft())).rejects.toThrow("synthetic audit failure");
    expect(await state(a)).toEqual(before);
  });
  it("retains both histories through the actual canonical whole-patient merge", async () => {
    const source = await patient(), target = await patient(); const original = draft();
    const first = await save(source, original); await save(source, draft(nextKey(), first.id)); await save(target);
    const beforeSource = await state(source), beforeTarget = await state(target);
    const merge = await fixture!.db.mergeDuplicatePatient(source, target, { actor: ACTOR, actorRole: "admin", reason: "synthetic duplicate" });
    expect(merge.ok).toBe(true);
    const after = await state(target);
    expect(after.records).toEqual([...beforeSource.records.map((row) => ({ ...row, patient_id: target })), ...beforeTarget.records].sort((a, b) => a.id - b.id));
    expect(after.sites).toEqual([...beforeSource.sites, ...beforeTarget.sites]);
    expect(await domain().save(source, original)).toMatchObject({ reason: "not_found" });
    expect(await domain().save(target, original)).toMatchObject({ reason: "request_conflict" });
    await noForeignPredecessors();
  });
  it("provides the existing deletion owner's count while database RESTRICT preserves history", async () => {
    const a = await patient(); await save(a); const before = await state(a);
    await transaction(async (client) => { expect(await periodontalHistoryCount(client, a)).toBe(1); });
    await expect(pool().query("DELETE FROM patients WHERE id=$1", [a])).rejects.toMatchObject({ code: "23503" });
    expect(await state(a)).toEqual(before);
    // deletePatientCascade's new refusal hook is only in the separate activation proposal.
  });
});
