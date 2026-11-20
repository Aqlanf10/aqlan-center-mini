import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolClient } from "pg";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SyntheticNumberingWriterAdmission, type WriterGeneration } from "../../lib/patient-numbering-writer-generation";
import { executeNumberingCommand } from "../../lib/patient-numbering-command";
import { ownerContextFromTrustedBinding, resolveStaffCapabilities } from "../../lib/staff-capabilities";
import { validatePostgresTestTarget } from "./_safe-target";
import { NumberingPgFixture } from "./fixtures/patient-numbering-adapter";

const target = validatePostgresTestTarget(process.env);
const lineage = "ba3f640b-1234-4b62-9c16-d9f49f5c8d30";
const legacy = { version: 1, lineage, mode: "LEGACY", generation: "1" } as const;
const fenced = { ...legacy, mode: "FENCED", generation: "2" } as const;
const managed = { ...legacy, mode: "MANAGED", generation: "3" } as const;
const requests = {
  fence: { expected: legacy, target: "FENCED", requestId: "synthetic_writer_fence_01" },
  manage: { expected: fenced, target: "MANAGED", requestId: "synthetic_writer_manage_01" },
} as const;
let pool: Pool, schema: string, created: boolean, gate: SyntheticNumberingWriterAdmission;
let allocator: NumberingPgFixture | undefined;
const owner = () => resolveStaffCapabilities({
  subject: { userId: 99, role: "admin", isActive: true, clinicianPartyId: null },
  permissionDocument: { schemaVersion: 1, revision: 1, patientScope: "none", appointmentScope: "none", grants: {} },
}, ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "synthetic-generation-only" }));

function fixtureProof() {
  return vi.fn(async (client: PoolClient, current: WriterGeneration) => {
    // A synthetic proof only: no comparison with an external writer fence,
    // owner enrollment, archive, or deployed database is performed here.
    const { rows: [value] } = await client.query(`SELECT phase FROM ${schema}.generation_state WHERE id=1`);
    return current.mode === "FENCED" && value.phase === "FENCED";
  });
}
function withSyntheticProof() {
  return new SyntheticNumberingWriterAdmission({ pool, schema, lineage, verifyManagedHandoff: fixtureProof() });
}
beforeEach(async () => {
  created = false;
  allocator = undefined;
  pool = new Pool({ connectionString: target.testUrl.toString(), ssl: false, max: 12 });
  schema = "numbering_generation_fixture_" + randomUUID().replaceAll("-", "");
  expect((await pool.query("SELECT current_database() AS name")).rows).toEqual([{ name: "aqlan_p1_test" }]);
  await pool.query(`CREATE SCHEMA ${schema}`);
  created = true;
  await pool.query(`
    CREATE TABLE ${schema}.generation_state (
      id integer PRIMARY KEY CHECK(id=1), version int NOT NULL CHECK(version=1),
      lineage uuid NOT NULL, phase text NOT NULL CHECK(phase IN ('LEGACY','FENCED','MANAGED')),
      generation bigint NOT NULL CHECK(generation>0)
    );
    CREATE TABLE ${schema}.generation_receipts (
      request_id text PRIMARY KEY, intent text NOT NULL, before_state jsonb NOT NULL, applied_state jsonb NOT NULL
    );
    CREATE TABLE ${schema}.synthetic_files (number text PRIMARY KEY, writer text NOT NULL);
    CREATE SEQUENCE ${schema}.legacy_numbers START 7000;
  `);
  await pool.query(`INSERT INTO ${schema}.generation_state VALUES(1,1,$1,'LEGACY',1)`, [lineage]);
  gate = new SyntheticNumberingWriterAdmission({ pool, schema, lineage });
});
afterEach(async () => {
  const failures: unknown[] = [];
  try { await allocator?.dispose(); } catch (error) { failures.push(error); }
  try {
    if (created && /^numbering_generation_fixture_[a-f0-9]{32}$/.test(schema)) {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    }
  } catch (error) { failures.push(error); }
  try { await pool?.end(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Owned writer generation fixture cleanup failed");
});
function receipts() {
  return pool.query(`SELECT count(*)::int AS n FROM ${schema}.generation_receipts`);
}
async function waitForBlockedTransition() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rows } = await pool.query(`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity
       WHERE datname=current_database() AND query LIKE '/* numbering-writer-transition */%'
         AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0) AS waiting
    `);
    if (rows[0]?.waiting === true) return;
    await delay(20);
  }
  throw new Error("Transition never blocked behind the in-flight writer");
}

it("waits for a cooperative in-flight legacy writer before a fence, then forbids admission", async () => {
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const write = gate.withWriter(legacy, async client => {
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('patient_import'))");
    const { rows: [row] } = await client.query(`
      INSERT INTO ${schema}.synthetic_files(number,writer)
      VALUES('P-' || lpad(nextval('${schema}.legacy_numbers')::text,5,'0'),'cooperative')
      RETURNING number
    `);
    entered();
    await held;
    return row.number;
  });
  let fencing: ReturnType<typeof gate.transition> | undefined;
  try {
    await Promise.race([enteredPromise, write.then(() => { throw new Error("Writer exited before holding its admission lock"); })]);
    fencing = gate.transition(requests.fence);
    await waitForBlockedTransition();
    const { rows } = await pool.query(`SELECT phase FROM ${schema}.generation_state WHERE id=1`);
    expect(rows).toEqual([{ phase: "LEGACY" }]);
  } finally { release(); }
  expect(await write).toEqual({ ok: true, value: "P-07000" });
  expect(await fencing).toEqual({ ok: true, value: { before: legacy, applied: fenced, current: fenced, replay: false } });
  const notInvoked = vi.fn(async () => "not allowed");
  expect(await gate.withWriter(legacy, notInvoked)).toEqual({ ok: false, reason: "writers-fenced" });
  expect(notInvoked).not.toHaveBeenCalled();
  expect((await pool.query(`SELECT number FROM ${schema}.synthetic_files`)).rows).toEqual([{ number: "P-07000" }]);
});
it("replays a durable exact transition after reconnection, and never exposes a receipt as current state", async () => {
  expect(await gate.transition(requests.fence)).toMatchObject({ ok: true, value: { applied: fenced, replay: false } });
  // A different gate instance and pool demonstrate database-backed receipts.
  const otherPool = new Pool({ connectionString: target.testUrl.toString(), ssl: false });
  try {
    const proof = fixtureProof();
    const other = new SyntheticNumberingWriterAdmission({ pool: otherPool, schema, lineage, verifyManagedHandoff: proof });
    expect(await other.transition(requests.fence)).toMatchObject({ ok: true, value: { applied: fenced, current: fenced, replay: true } });
    expect(await other.transition(requests.manage)).toMatchObject({ ok: true, value: { applied: managed, current: managed, replay: false } });
    expect(await other.transition(requests.fence)).toMatchObject({ ok: true, value: { applied: fenced, current: managed, replay: true } });
    expect(await other.transition(requests.manage)).toMatchObject({ ok: true, value: { applied: managed, current: managed, replay: true } });
    expect(await other.readState()).toEqual({ ok: true, value: managed });
    expect(proof).toHaveBeenCalledOnce();
    expect(await other.transition({ ...requests.fence, expected: fenced, target: "MANAGED" }))
      .toEqual({ ok: false, reason: "idempotency-conflict" });
    expect(await other.transition({ ...requests.fence, requestId: "synthetic_new_old_fence_02" }))
      .toEqual({ ok: false, reason: "stale-generation" });
    expect(await other.transition({ ...requests.fence, expected: managed, requestId: "synthetic_downgrade_01" }))
      .toEqual({ ok: false, reason: "illegal-transition" });
    expect((await receipts()).rows).toEqual([{ n: 2 }]);
  } finally { await otherPool.end(); }
});
it("commits exactly one receipt for concurrent exact retries and a new generation once", async () => {
  const results = await Promise.all(Array.from({length: 12}, () => gate.transition(requests.fence)));
  expect(results.every(result => result.ok && result.value.current.generation === "2")).toBe(true);
  expect(results.filter(result => result.ok && !result.value.replay)).toHaveLength(1);
  expect(await gate.readState()).toEqual({ ok: true, value: fenced });
  expect((await receipts()).rows).toEqual([{ n: 1 }]);
});
it("rolls back on domain failure and admits only exact, known writer modes and generations", async () => {
  expect(await gate.withWriter(legacy, async client => {
    await client.query(`INSERT INTO ${schema}.synthetic_files VALUES('P-09999','synthetic rollback')`);
    throw new Error("domain rejected");
  })).toEqual({ ok: false, reason: "writer-transaction-failed" });
  expect((await pool.query(`SELECT * FROM ${schema}.synthetic_files`)).rows).toEqual([]);
  const work = vi.fn(async () => "never");
  for (const malformed of [null, fenced, { ...legacy, version: 2 }, { ...legacy, mode: "OTHER" },
    { ...legacy, generation: "01" }, { ...legacy, generation: "9223372036854775808" }]) {
    expect(await gate.withWriter(malformed, work)).toEqual({ ok: false, reason: "invalid-writer-token" });
  }
  for (const stale of [managed, { ...legacy, generation: "99" }, { ...legacy, lineage: "ba3f640b-1234-4b62-9c16-d9f49f5c8d31" }]) {
    expect(await gate.withWriter(stale, work)).toEqual({ ok: false, reason: "stale-generation" });
  }
  expect(work).not.toHaveBeenCalled();
});
it("holds FENCED without explicit handoff proof and does not burn a generation or receipt", async () => {
  expect(await gate.transition({ ...requests.manage, expected: legacy })).toEqual({ ok: false, reason: "illegal-transition" });
  expect(await gate.transition(requests.fence)).toMatchObject({ ok: true, value: { applied: fenced } });
  expect(await gate.transition(requests.manage)).toEqual({ ok: false, reason: "managed-handoff-unproven" });
  expect(await gate.readState()).toEqual({ ok: true, value: fenced });
  expect((await receipts()).rows).toEqual([{ n: 1 }]);
  const proven = withSyntheticProof();
  expect(await proven.transition(requests.manage)).toMatchObject({ ok: true, value: { applied: managed } });
});
it("runs real concurrent managed allocator operations in the admitted transaction; old tokens never enter", async () => {
  allocator = new NumberingPgFixture(pool, "numbering_fixture_" + randomUUID().replaceAll("-", ""), async () => owner());
  await allocator.initialize();
  expect(await executeNumberingCommand({
    prefix: "A", next: "1500", expectedRevision: (await allocator.preview("A")).revision,
    requestId: "synthetic_fixture_owner", reason: "Synthetic generation fixture provisioning",
  }, allocator)).toMatchObject({ ok: true });
  const chosen = allocator;
  const proven = withSyntheticProof();
  expect(await proven.transition(requests.fence)).toMatchObject({ ok: true, value: { applied: fenced } });
  expect(await proven.transition(requests.manage)).toMatchObject({ ok: true, value: { applied: managed } });
  const allocate = vi.fn(async (client: PoolClient) => {
    // Match the real allocator order: generation admission was acquired first.
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('patient_import'))");
    const number = await chosen.allocateInExistingTransaction(client);
    await client.query(`INSERT INTO ${schema}.synthetic_files VALUES($1,'managed')`, [number]);
    return number;
  });
  const results = await Promise.all([
    ...Array.from({length: 24}, () => proven.withWriter(managed, allocate)),
    proven.withWriter(legacy, allocate), proven.withWriter({ ...managed, generation: "4" }, allocate),
  ]);
  expect(results.slice(24)).toEqual([
    { ok: false, reason: "stale-generation" }, { ok: false, reason: "stale-generation" },
  ]);
  expect(results.slice(0, 24).every(result => result.ok)).toBe(true);
  expect(allocate).toHaveBeenCalledTimes(24);
  const { rows } = await pool.query(`SELECT number,writer FROM ${schema}.synthetic_files ORDER BY number`);
  expect(rows).toEqual(Array.from({length: 24}, (_, i) => ({ number: "A-" + String(1500+i).padStart(5,"0"), writer: "managed" })));
});
it("demonstrates that an old non-cooperative binary is not a database-level fence", async () => {
  expect(await gate.transition(requests.fence)).toMatchObject({ ok: true, value: { applied: fenced } });
  const cooperative = vi.fn(async () => "never");
  expect(await gate.withWriter(legacy, cooperative)).toEqual({ ok: false, reason: "writers-fenced" });
  expect(cooperative).not.toHaveBeenCalled();
  // This direct synthetic writer ignores generation just like old code.
  // Its success intentionally blocks any claim of operational fencing.
  await pool.query(`INSERT INTO ${schema}.synthetic_files VALUES('P-07000','ignores-generation')`);
  expect((await pool.query(`SELECT writer FROM ${schema}.synthetic_files`)).rows)
    .toEqual([{ writer: "ignores-generation" }]);
  expect(await gate.readState()).toEqual({ ok: true, value: fenced });
});
it("refuses a missing or wrong-lineage state and a generation overflow", async () => {
  const untouched = vi.fn(async () => "never");
  const wrong = new SyntheticNumberingWriterAdmission({
    pool, schema, lineage: "ba3f640b-1234-4b62-9c16-d9f49f5c8d31",
  });
  expect(await wrong.readState()).toEqual({ ok: false, reason: "writer-state-unavailable" });
  await pool.query(`UPDATE ${schema}.generation_state SET generation=9223372036854775807`);
  expect(await gate.transition({ ...requests.fence, expected: { ...legacy, generation: "9223372036854775807" } }))
    .toEqual({ ok: false, reason: "generation-exhausted" });
  await pool.query(`DELETE FROM ${schema}.generation_state`);
  expect(await gate.readState()).toEqual({ ok: false, reason: "writer-state-unavailable" });
  expect(await gate.withWriter(legacy, untouched)).toEqual({ ok: false, reason: "writer-state-unavailable" });
  expect(untouched).not.toHaveBeenCalled();
  expect((await receipts()).rows).toEqual([{ n: 0 }]);
});
