import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { PatientNumberingPreviewClaims } from "../../lib/patient-numbering-controller";
import { admitManagedNumberingCheckpoint, encodeManagedNumberingCheckpoint, type ManagedNumberingPayload } from "../../lib/patient-numbering-recovery-v2";
import { parseTarBytes } from "../../lib/restore/archive";
import { createPatientNumberingSettings } from "../../lib/patient-numbering-settings";
import { SyntheticNumberingWriterAdmission } from "../../lib/patient-numbering-writer-generation";
import { PatientNumberingPostgresBackend } from "../../lib/patient-numbering-postgres";
import { ownerContextFromTrustedBinding, resolveStaffCapabilities } from "../../lib/staff-capabilities";
import { validatePostgresTestTarget } from "./_safe-target";
import { NumberingPgFixture } from "./fixtures/patient-numbering-adapter";

const target = validatePostgresTestTarget(process.env);
const bound = ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "synthetic-settings-only" });
const access = (userId: number) => resolveStaffCapabilities({
  subject: { userId, role: "admin", isActive: true, clinicianPartyId: null },
  permissionDocument: { schemaVersion: 2, confirmation: "owner", revision: 1, patientScope: "none", appointmentScope: "none", grants: {} },
}, bound);
let pool: Pool, fixture: NumberingPgFixture;
let generation: SyntheticNumberingWriterAdmission | undefined, generationSchema: string | undefined;
const managed = { version: 1, lineage: "666aabbc-3333-4cdd-9ebb-177888999abc", mode: "MANAGED", generation: "3" } as const;
let clock: number, tokenCounter: number, claims: Map<string, PatientNumberingPreviewClaims>;
const draft = { prefix: "A", next: "1500", reason: "synthetic non-public reasoning" };
beforeEach(async () => {
  pool = new Pool({ connectionString: target.testUrl.toString(), ssl: false });
  fixture = new NumberingPgFixture(pool, "numbering_fixture_" + randomUUID().replaceAll("-", ""), async () => null);
  await fixture.initialize();
  generation = undefined; generationSchema = undefined;
  clock = Date.now(); tokenCounter = 0; claims = new Map();
});
afterEach(async () => {
  try {
    if (generationSchema && /^numbering_generation_fixture_[a-f0-9]{32}$/.test(generationSchema)) {
      await pool.query(`DROP SCHEMA ${generationSchema} CASCADE`);
    }
    await fixture?.dispose();
  } finally { await pool?.end(); }
});
function transport(source = pool, userId = 99, binding = () => "synthetic-existing-session") {
  const backend = new PatientNumberingPostgresBackend({
    pool: source, schema: fixture.schema, ownerSession: async () => ({ access: access(userId), sessionBinding: binding() }),
  });
  return createPatientNumberingSettings({
    backend, now: () => clock,
    // In-process test double only, not an authenticator, signer, or secret.
    issuePreview: async approved => {
      const token = "synthetic-preview-index-" + ++tokenCounter; claims.set(token, approved); return token;
    },
    verifyPreview: async token => claims.get(token) ?? null,
  });
}

it("defaults to no reads or issuance without both trusted providers", async () => {
  const inactive = createPatientNumberingSettings();
  expect(await inactive.read(null)).toEqual({ ok: false, reason: "owner-numbering-not-activated" });
  expect(await inactive.preview(draft)).toEqual({ ok: false, reason: "owner-numbering-not-activated" });
});
it("saves exact once and reloads the actual PG receipt independently of the current next value", async () => {
  const settings = transport();
  const prepared = await settings.preview(draft);
  expect(prepared).toMatchObject({ ok: true, ticket: { preview: "A-01500" } });
  if (!prepared.ok) throw new Error("Synthetic preview refused");
  const { ticket } = prepared;
  expect(await settings.save(ticket)).toMatchObject({ ok: true, replay: false });
  clock += 61_000;
  expect(await settings.save(ticket)).toMatchObject({ ok: true, replay: true });
  expect(await fixture.issue()).toBe("A-01500");
  const reconnect = new Pool({ connectionString: target.testUrl.toString(), ssl: false });
  try {
    // Reload does not use the client preview token or a mutation to prove outcome.
    claims.clear();
    const reloaded = await transport(reconnect).read(ticket.requestId);
    expect(reloaded).toMatchObject({
      ok: true, current: { prefix: "A", next: "1501" },
      receipt: { requestId: ticket.requestId, value: { prefix: "A", next: "1500", preview: "A-01500" } },
    });
    expect(JSON.stringify(reloaded)).not.toContain(draft.reason);
    expect(JSON.stringify(reloaded)).not.toContain(ticket.previewToken);
    expect((await pool.query(`SELECT count(*)::int AS n FROM ${fixture.schema}.audit`)).rows).toEqual([{ n: 1 }]);
  } finally { await reconnect.end(); }
});
it("never reports a missing or mismatching persisted intent as safe to retry with a new command", async () => {
  const settings = transport();
  const prepared = await settings.preview(draft);
  if (!prepared.ok) throw new Error("Synthetic preview refused");
  expect(await settings.read(prepared.ticket.requestId)).toEqual({ ok: false, reason: "receipt-unresolved" });
  expect(await settings.save(prepared.ticket)).toMatchObject({ ok: true });
  await pool.query(`UPDATE ${fixture.schema}.receipts SET result=jsonb_set(result,'{revision}','"bad:revision"')`);
  expect(await settings.read(prepared.ticket.requestId)).toEqual({ ok: false, reason: "receipt-unresolved" });
});
it("refuses ordinary administrator and a changed owner session without exposing a receipt", async () => {
  const settings = transport(), prepared = await settings.preview(draft);
  if (!prepared.ok) throw new Error("Synthetic preview refused");
  expect(await settings.save(prepared.ticket)).toMatchObject({ ok: true });
  expect(await transport(pool, 100).read(prepared.ticket.requestId)).toEqual({ ok: false, reason: "owner-required" });
  expect(await transport(pool, 100).save(prepared.ticket)).toMatchObject({ ok: false, reason: "owner-required" });
  let calls = 0;
  const changing = transport(pool, 99, () => ++calls === 1 ? "existing-session" : "changed-session");
  expect(await changing.read(prepared.ticket.requestId)).toEqual({ ok: false, reason: "owner-required" });
});

it("recovers the persisted maximum reservation after issue/exhaustion; a different prefix remains available", async () => {
  const settings = transport(), max = "999999999999999999";
  const preview = await settings.preview({ ...draft, next: max });
  if (!preview.ok) throw new Error("Synthetic preview refused");
  const { ticket } = preview;
  expect(await settings.save(ticket)).toMatchObject({ ok: true, replay: false });
  expect(await fixture.issue()).toBe(`A-${max}`);
  await expect(fixture.issue()).rejects.toMatchObject({ code: "2200H" });
  claims.clear();
  expect(await settings.read(ticket.requestId)).toMatchObject({
    ok: true, current: { prefix: "A", next: null },
    receipt: { requestId: ticket.requestId, value: { prefix: "A", next: max, preview: `A-${max}` } },
  });
  expect(await settings.read(null)).toMatchObject({ ok: true, current: { prefix: "A", next: null }, receipt: null });
  expect(await settings.read("synthetic_missing_max_request")).toEqual({ ok: false, reason: "receipt-unresolved" });
  expect(await settings.preview({ ...draft, next: max })).toEqual({ ok: false, reason: "would-reuse-or-rewind" });
  const switchPrefix = await settings.preview({ ...draft, prefix: "B", next: "1" });
  if (!switchPrefix.ok) throw new Error("Different prefix unexpectedly held");
  expect(await settings.save(switchPrefix.ticket)).toMatchObject({ ok: true, replay: false });
  expect(await fixture.issue()).toBe("B-00001");
  expect(await settings.read(ticket.requestId)).toMatchObject({
    ok: true, current: { prefix: "B", next: "2" }, receipt: { value: { preview: `A-${max}` } },
  });
});

const dispositionLineage = managed.lineage;
const enrolled = "synthetic_immutable_owner";
async function provisionDisposition() {
  generationSchema = "numbering_generation_fixture_" + randomUUID().replaceAll("-", "");
  await pool.query(`CREATE SCHEMA ${generationSchema}; CREATE TABLE ${generationSchema}.generation_state(
    id int PRIMARY KEY CHECK(id=1), version int NOT NULL CHECK(version=1), lineage uuid NOT NULL,
    phase text NOT NULL CHECK(phase IN ('LEGACY','FENCED','MANAGED')), generation bigint NOT NULL CHECK(generation>0)
  )`);
  await pool.query(`INSERT INTO ${generationSchema}.generation_state VALUES(1,1,$1,'MANAGED',3)`, [managed.lineage]);
  generation = new SyntheticNumberingWriterAdmission({ pool, schema: generationSchema, lineage: managed.lineage });
  await pool.query(`CREATE TABLE ${fixture.schema}.preview_dispositions(
    lineage text NOT NULL, enrollment text NOT NULL, actor bigint NOT NULL,
    request text PRIMARY KEY, expires_at_ms bigint NOT NULL CHECK(expires_at_ms>0),
    state text NOT NULL CHECK(state IN ('issued','committed','retired'))
  )`);
}
function durable({ enrolledId = enrolled, userId = 99, ttlMs = 60_000, admitted = true,
  credential = (): string => "synthetic-existing-session", lineageId = dispositionLineage as string, source = pool } = {}) {
  const admission = source === pool ? generation : generationSchema && new SyntheticNumberingWriterAdmission({ pool: source, schema: generationSchema, lineage: managed.lineage });
  const backend = new PatientNumberingPostgresBackend({
    pool: source, schema: fixture.schema,
    ownerSession: async () => ({ access: access(userId), sessionBinding: credential() }),
    disposition: {
      ttlMs,
      admitBeforeConfig: client => {
        if (!admission) throw Error("Fixture generation not provisioned");
        return admission.admitExistingTransaction(client, admitted ? managed : { ...managed, generation: "2" });
      },
      enrollmentOnLockedClient: async () => ({ actorId: userId, enrollment: enrolledId, lineage: lineageId }),
    },
  });
  return createPatientNumberingSettings({
    backend, now: () => 1, // Deliberately irrelevant in durable mode.
    issuePreview: async approved => {
      const token = "synthetic-preview-index-" + ++tokenCounter; claims.set(token, approved); return token;
    },
    verifyPreview: async token => claims.get(token) ?? null,
  });
}
const ledger = () => pool.query(`SELECT request,state,expires_at_ms,actor FROM ${fixture.schema}.preview_dispositions ORDER BY request`);
async function expiredInOwnedFixture(requestId: string) {
  const { rows: [row] } = await pool.query(`SELECT count(*)::int AS n FROM ${fixture.schema}.preview_dispositions WHERE request=$1`, [requestId]);
  expect(row.n).toBe(1);
  // Wait on the database clock, not an injected JavaScript expiry decision.
  await pool.query(`SELECT pg_sleep(greatest(0::double precision,
    (expires_at_ms::double precision / 1000 - extract(epoch FROM clock_timestamp())::double precision) + 0.01))
    FROM ${fixture.schema}.preview_dispositions WHERE request=$1`, [requestId]);
}
it("records only prefenced metadata at issuance; valid pending saves commit/replay, not retire", async () => {
  await provisionDisposition();
  const configured = durable(), issued = await configured.preview(draft);
  if (!issued.ok) throw Error("Synthetic preview refused");
  const { ticket } = issued;
  expect(await configured.readDisposition(ticket.requestId)).toEqual({ ok: true, state: "open" });
  expect(await configured.retireExpired(ticket.requestId)).toEqual({ ok: true, state: "open" });
  expect(await configured.read(ticket.requestId)).toEqual({ ok: false, reason: "receipt-unresolved" });
  const row = (await pool.query(`SELECT * FROM ${fixture.schema}.preview_dispositions`)).rows[0];
  expect(Object.keys(row).sort()).toEqual(["actor","enrollment","expires_at_ms","lineage","request","state"]);
  expect(JSON.stringify(row)).not.toContain(ticket.previewToken);
  expect(JSON.stringify(row)).not.toContain(ticket.reason);
  const [first, second] = await Promise.all([configured.save(ticket), configured.save(ticket)]);
  expect([first, second]).toEqual(expect.arrayContaining([
    expect.objectContaining({ ok: true, replay: false }), expect.objectContaining({ ok: true, replay: true }),
  ]));
  expect(await configured.retireExpired(ticket.requestId)).toEqual({ ok: true, state: "committed" });
  expect(await configured.read(ticket.requestId)).toMatchObject({ ok: true, receipt: { requestId: ticket.requestId } });
  expect((await pool.query(`SELECT count(*)::int AS n FROM ${fixture.schema}.audit`)).rows).toEqual([{ n: 1 }]);
});
it("uses database-clock expiry, treats inspection as nonmutating, retires exactly once and denies late submit", async () => {
  await provisionDisposition();
  const configured = durable({ ttlMs: 450 }), issued = await configured.preview(draft);
  if (!issued.ok) throw Error("Synthetic preview refused");
  const { ticket } = issued;
  await expiredInOwnedFixture(ticket.requestId);
  expect(await configured.readDisposition(ticket.requestId)).toEqual({ ok: true, state: "expired" });
  expect(await configured.read(ticket.requestId)).toEqual({ ok: false, reason: "receipt-unresolved" });
  expect((await ledger()).rows).toMatchObject([{ state: "issued" }]);
  const results = await Promise.all([configured.retireExpired(ticket.requestId), configured.save(ticket), configured.retireExpired(ticket.requestId)]);
  expect(results[0]).toEqual({ ok: true, state: "retired" });
  expect(results[1]).toMatchObject({ ok: false });
  expect(results[2]).toEqual({ ok: true, state: "retired" });
  expect(await configured.readDisposition(ticket.requestId)).toEqual({ ok: true, state: "retired" });
  expect(await configured.save(ticket)).toEqual({ ok: false, reason: "receipt-unresolved" });
  expect((await ledger()).rows).toMatchObject([{ state: "retired" }]);
  expect((await pool.query(`SELECT count(*)::int AS n FROM ${fixture.schema}.audit`)).rows).toEqual([{ n: 0 }]);
  expect(await fixture.issue()).toBe("P-07000");
});
it("ledger transition rolls back with allocator, audit and receipt; old untracked previews are not adopted", async () => {
  await provisionDisposition();
  const configured = durable(), previous = transport();
  const untracked = await previous.preview(draft);
  if (!untracked.ok) throw Error("Synthetic old preview refused");
  expect(await configured.save(untracked.ticket)).toEqual({ ok: false, reason: "receipt-unresolved" });
  const issued = await configured.preview({ ...draft, reason: "SYNTHETIC_AUDIT_FAIL" });
  if (!issued.ok) throw Error("Synthetic preview refused");
  expect(await configured.save(issued.ticket)).toEqual({ ok: false, reason: "numbering-transaction-failed" });
  expect(await configured.readDisposition(issued.ticket.requestId)).toEqual({ ok: true, state: "open" });
  expect((await ledger()).rows).toMatchObject([{ state: "issued" }]);
  expect(await fixture.issue()).toBe("P-07000");
});
it("retirement rolls back if canonical owner proof changes before commit", async () => {
  await provisionDisposition();
  const settings = durable({ ttlMs: 450 }), issued = await settings.preview(draft);
  if (!issued.ok) throw Error("Synthetic preview refused");
  await expiredInOwnedFixture(issued.ticket.requestId);
  let calls = 0;
  const changes = durable({ credential: () => ++calls === 4 ? "changed-binding" : "synthetic-existing-session" });
  expect(await changes.retireExpired(issued.ticket.requestId)).toEqual({ ok: false, reason: "owner-required" });
  expect((await ledger()).rows).toMatchObject([{ state: "issued" }]);
  expect(await settings.retireExpired(issued.ticket.requestId)).toEqual({ ok: true, state: "retired" });
});
it("hides even a committed receipt from another same-actor enrollment or lineage", async () => {
  await provisionDisposition();
  const settings = durable(), issued = await settings.preview(draft);
  if (!issued.ok) throw Error("Synthetic preview refused");
  expect(await settings.save(issued.ticket)).toMatchObject({ ok: true });
  const request = issued.ticket.requestId;
  for (const other of [durable({ enrolledId: "synthetic_reenrolled_owner" }), durable({ lineageId: "synthetic_other_clinic_lineage" })]) {
    expect(await other.read(request)).toEqual({ ok: false, reason: "receipt-unresolved" });
    expect(await other.readDisposition(request)).toEqual({ ok: false, reason: "receipt-unresolved" });
    expect(await other.retireExpired(request)).toEqual({ ok: false, reason: "receipt-unresolved" });
    expect(await other.save(issued.ticket)).toEqual({ ok: false, reason: "receipt-unresolved" });
  }
  expect(await durable({ userId: 100 }).readDisposition(request)).toEqual({ ok: false, reason: "owner-required" });
  expect(await durable({ admitted: false }).readDisposition(request)).toEqual({ ok: false, reason: "numbering-transaction-failed" });
});

it("takes generation admission before the config lock and rejects a stale in-flight preview", async () => {
  await provisionDisposition();
  const client = await pool.connect(), witness = await pool.connect();
  let call: ReturnType<ReturnType<typeof durable>["preview"]> | undefined;
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM ${generationSchema}.generation_state WHERE id=1 FOR UPDATE`);
    call = durable().preview(draft);
    let waiting = false;
    for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
      const { rows: [row] } = await witness.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE wait_event_type='Lock' AND query LIKE $1) AS waiting`, [`%numbering-writer-admission%${generationSchema}%`]);
      waiting = row.waiting;
      if (!waiting) await delay(10);
    }
    expect(waiting).toBe(true);
    await witness.query("BEGIN");
    await witness.query(`SELECT id FROM ${fixture.schema}.config WHERE id=1 FOR UPDATE NOWAIT`);
    await witness.query("ROLLBACK");
    await client.query(`UPDATE ${generationSchema}.generation_state SET generation=4 WHERE id=1`);
    await client.query("COMMIT");
    expect(await call).toEqual({ ok: false, reason: "numbering-transaction-failed" });
    expect((await ledger()).rows).toEqual([]);
  } finally {
    await witness.query("ROLLBACK").finally(() => witness.release());
    await client.query("ROLLBACK").finally(() => client.release());
    await call;
  }
});

it("owns a PostgreSQL capture before and after a ledger-only retirement and refuses stale or mixed exact archives", async () => {
  await provisionDisposition();
  await pool.query(`CREATE TABLE ${fixture.schema}.retired_aliases(number text PRIMARY KEY,patient_id bigint NOT NULL)`);
  const committed = durable(), first = await committed.preview(draft);
  if (!first.ok) throw Error("Committed fixture preview refused");
  expect(await committed.save(first.ticket)).toMatchObject({ ok: true, replay: false });
  const expiring = durable({ ttlMs: 650 }), second = await expiring.preview({ ...draft, prefix: "B" });
  if (!second.ok || !generationSchema) throw Error("Lost-response fixture not provisioned");
  const expected = { schema: generationSchema, lineage: managed.lineage, generation: managed.generation };
  const beforeV1 = await fixture.exportRecoverySidecar(managed.lineage);
  const before = await fixture.exportManagedRecoverySidecar(expected);
  const old = JSON.parse(before.bytes.toString("utf8")) as ManagedNumberingPayload;
  expect(old.dispositions).toEqual(expect.arrayContaining([
    expect.objectContaining({ request: first.ticket.requestId, state: "committed" }),
    expect.objectContaining({ request: second.ticket.requestId, state: "issued" }),
  ]));
  await expiredInOwnedFixture(second.ticket.requestId);
  expect(await expiring.retireExpired(second.ticket.requestId)).toEqual({ ok: true, state: "retired" });
  const afterV1 = await fixture.exportRecoverySidecar(managed.lineage);
  const after = await fixture.exportManagedRecoverySidecar(expected);
  expect(afterV1).toEqual(beforeV1);
  expect(after.manifest.sha256).not.toBe(before.manifest.sha256);
  const latest = JSON.parse(after.bytes.toString("utf8")) as ManagedNumberingPayload;
  expect(latest.dispositions.find(d => d.request === second.ticket.requestId)?.state).toBe("retired");
  expect(latest.numbering).toEqual(old.numbering);
  expect(latest.managed).toEqual(old.managed);

  const a = Buffer.from("private exact synthetic application attachment previous"),
    b = Buffer.from("private exact synthetic application attachment current");
  const previous = encodeManagedNumberingCheckpoint(old, a), current = encodeManagedNumberingCheckpoint(latest, b);
  // Fixture substitutes the independently stored checkpoint, never archive self-proof.
  const authority = { expectedLineage: managed.lineage, expectedGeneration: managed.generation,
    readCurrent: async () => ({
      version: 2 as const, lineage: managed.lineage, generation: managed.generation,
      stateSha256: after.manifest.sha256, archiveSha256: createHash("sha256").update(current).digest("hex"),
    }),
  };
  expect(await admitManagedNumberingCheckpoint(current, authority)).toEqual({ ok: true, payload: latest });
  for (const staleOrMixed of [previous, encodeManagedNumberingCheckpoint(old, b), encodeManagedNumberingCheckpoint(latest, a)]) {
    expect(await admitManagedNumberingCheckpoint(staleOrMixed, authority)).toEqual({ ok: false, reason: "freshness-mismatch" });
  }
  expect(await expiring.save(second.ticket)).toEqual({ ok: false, reason: "receipt-unresolved" });
  await expect(fixture.exportManagedRecoverySidecar({ ...expected, generation: "99" })).rejects.toThrow("Managed writer proof unavailable");
  await pool.query(`DELETE FROM ${fixture.schema}.preview_dispositions WHERE request=$1`, [first.ticket.requestId]);
  await expect(fixture.exportManagedRecoverySidecar(expected)).rejects.toThrow("Invalid or incomplete");
});

// Optional owned fixture only: never run against an existing clinic DB.
it.runIf(process.env.NUMBERING_V2_OWNED_PHYSICAL_WITNESS === "1")(
  "re-projects exact managed v2 state after a real cold synthetic pg_restore and preserves patient IDs and next allocation",
  async () => {
    const bin = process.env.NUMBERING_PG_BIN;
    if (!bin) throw new Error("NUMBERING_PG_BIN required for physical checkpoint witness");
    const toolsEnv = { PATH: process.env.PATH, PGCONNECT_TIMEOUT: "5", NODE_ENV: "test" as const };
    const command = (tool: string, args: string[], input?: Buffer) => {
      const result = spawnSync(join(bin, tool), args, { input, env: toolsEnv, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
      if (result.status !== 0) throw new Error(tool + " failed in owned fixture: " + (result.stderr?.toString() ?? result.error?.message));
      return result.stdout;
    };
    await provisionDisposition();
    if (!generationSchema) throw new Error("Required synthetic generation schema not provisioned");
    const expected = { schema: generationSchema, lineage: managed.lineage, generation: managed.generation };
    // Owned schema deliberately uses a minimal patient identity table, not a
    // copy of any clinical schema/data. Only ID and assigned file number matter.
    await pool.query(`CREATE TABLE ${fixture.schema}.synthetic_patient_ids(id bigint PRIMARY KEY, patient_number text NOT NULL UNIQUE);
      CREATE TABLE ${fixture.schema}.retired_aliases(number text PRIMARY KEY,patient_id bigint NOT NULL REFERENCES ${fixture.schema}.synthetic_patient_ids);
      INSERT INTO ${fixture.schema}.synthetic_patient_ids VALUES (12,'P-00012');
      UPDATE ${fixture.schema}.history SET historical=12 WHERE prefix='P';
      INSERT INTO ${fixture.schema}.retired_aliases VALUES('P-00011',12);`);
    const committed = durable(), first = await committed.preview(draft);
    if (!first.ok) throw new Error("Synthetic owner preview refused");
    expect(await committed.save(first.ticket)).toMatchObject({ ok: true, replay: false });
    expect(await fixture.issue()).toBe("A-01500");
    await pool.query(`INSERT INTO ${fixture.schema}.synthetic_patient_ids VALUES (42,'A-01500')`);
    const expiring = durable({ ttlMs: 650 }), second = await expiring.preview({ ...draft, prefix: "B" });
    if (!second.ok) throw new Error("Synthetic expiring preview refused");
    await expiredInOwnedFixture(second.ticket.requestId);
    const schemaArgs = ["--schema", fixture.schema, "--schema", generationSchema];
    const dump = () => command("pg_dump", [
      "--dbname", target.testUrl.toString(), "--format=custom", "--no-owner", "--no-privileges", ...schemaArgs,
    ]);
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const old = await fixture.exportManagedRecoverySidecar(expected);
    const staleArchive = encodeManagedNumberingCheckpoint(JSON.parse(old.bytes.toString()), dump());
    expect(await expiring.retireExpired(second.ticket.requestId)).toEqual({ ok: true, state: "retired" });
    const checkpoint = await fixture.exportManagedRecoverySidecar(expected);
    const attachment = dump();
    expect(await fixture.exportManagedRecoverySidecar(expected)).toEqual(checkpoint);
    const archive = encodeManagedNumberingCheckpoint(JSON.parse(checkpoint.bytes.toString()), attachment);
    // Independently held *test* witness. It is not read from the incoming TAR
    // on replay and does not impersonate approval for a deployed target.
    const record = Object.freeze({ version: 2 as const, lineage: managed.lineage, generation: managed.generation,
      stateSha256: checkpoint.manifest.sha256, archiveSha256: digest(archive) });
    const custody = { expectedLineage: managed.lineage, expectedGeneration: managed.generation, readCurrent: async () => record };
    expect(await admitManagedNumberingCheckpoint(staleArchive, custody)).toEqual({ ok: false, reason: "freshness-mismatch" });
    expect(await admitManagedNumberingCheckpoint(archive, custody)).toMatchObject({ ok: true });
    const packed = parseTarBytes(archive);
    const exactAttachment = packed.entries.get("application-checkpoint.bin")?.data;
    if (packed.truncated || !exactAttachment || digest(exactAttachment) !== digest(attachment)) throw new Error("Synthetic approved attachment mismatch");

    const name = "aqlan_numbering_restore_" + randomUUID().replaceAll("-", "");
    const identitySql = "SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1";
    await pool.query(`CREATE DATABASE ${name} TEMPLATE template0`);
    const { rows: [identity] } = await pool.query(identitySql, [name]);
    if (!identity) throw new Error("Cannot establish newly created synthetic target ownership");
    const url = new URL(target.testUrl); url.pathname = "/" + name;
    const removeOwnedTarget = async () => {
      if (JSON.stringify((await pool.query(identitySql, [name])).rows) !== JSON.stringify([identity])) {
        throw new Error("Synthetic target ownership changed; cleanup refused");
      }
      await pool.query(`DROP DATABASE ${name}`);
    };
    let restored: Pool | undefined;
    try {
      restored = new Pool({ connectionString: url.toString(), ssl: false });
      const connected = (await restored.query("SELECT current_database() AS name,oid::text,datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows[0];
      expect(connected).toEqual({ name, ...identity });
      command("pg_restore", ["--dbname", url.toString(), "--exit-on-error", "--no-owner", "--no-privileges"], Buffer.from(exactAttachment));
      await restored.end();
      restored = new Pool({ connectionString: url.toString(), ssl: false });
      const restarted = new NumberingPgFixture(restored, fixture.schema, async () => null);
      expect(await restarted.exportManagedRecoverySidecar(expected)).toEqual(checkpoint);
      const rows = async (source: Pool) => (await source.query(`SELECT id::text,patient_number FROM ${fixture.schema}.synthetic_patient_ids ORDER BY id`)).rows;
      const identities = [{id:"12",patient_number:"P-00012"}, {id:"42",patient_number:"A-01500"}];
      expect(await rows(restored)).toEqual(identities);
      expect((await restored.query(`SELECT last_value::text,is_called FROM ${fixture.schema}.seq_p`)).rows).toEqual([{last_value:"7000",is_called:false}]);
      const restoredOwner = durable({ source: restored });
      expect(await restoredOwner.read(first.ticket.requestId)).toMatchObject({ ok: true, current: { prefix: "A", next: "1501" }, receipt: { requestId: first.ticket.requestId } });
      expect(await restoredOwner.readDisposition(second.ticket.requestId)).toEqual({ ok: true, state: "retired" });
      expect(await restoredOwner.save(second.ticket)).toEqual({ ok: false, reason: "receipt-unresolved" });
      expect(await durable({ source: restored, enrolledId: "synthetic_foreign_owner" }).read(first.ticket.requestId))
        .toEqual({ ok: false, reason: "receipt-unresolved" });
      expect(await restarted.issue()).toBe("A-01501");
      expect(await rows(restored)).toEqual(identities);
      expect(await rows(pool)).toEqual(identities);
      expect(await fixture.exportManagedRecoverySidecar(expected)).toEqual(checkpoint);
    } finally {
      try { await restored?.end(); }
      finally { await removeOwnedTarget(); }
    }
  }, 60_000,
);
