import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Client, Pool } from "pg";
import { afterEach, beforeEach, expect, it } from "vitest";
import { executeNumberingCommand } from "../../lib/patient-numbering-command";
import { ownerContextFromTrustedBinding, resolveStaffCapabilities } from "../../lib/staff-capabilities";
import { validateLocalVerificationTarget } from "../../lib/verification-target-policy.mjs";
import { validatePostgresTestTarget } from "./_safe-target";
import { NumberingPgFixture } from "./fixtures/patient-numbering-adapter";
import { bootstrapLegacyFixture, prepareLegacyFixture } from "./fixtures/patient-numbering-bootstrap";

const target = validatePostgresTestTarget(process.env);
const lineage = "ba3f640b-1234-4b62-9c16-d9f49f5c8d20";
const identitySql = "SELECT oid::text, datdba::text AS owner FROM pg_database WHERE datname=$1";
const owner = () => resolveStaffCapabilities({
  subject: { userId: 99, role: "admin", isActive: true, clinicianPartyId: null },
  permissionDocument: { schemaVersion: 2, confirmation: "owner", revision: 1, patientScope: "none", appointmentScope: "none", grants: {} },
}, ownerContextFromTrustedBinding({ ownerUserId: 99, bindingVersion: "synthetic-cold-start-only" }));
let name: string, admin: Client, pool: Pool, f: NumberingPgFixture;
let owned: {oid: string; owner: string} | undefined;
let archive: Awaited<ReturnType<NumberingPgFixture["exportRecoverySidecar"]>>;
const readLegacy = async () => (await pool.query("SELECT last_value::text, is_called FROM public.patient_number_seq")).rows;
const rows = async () => (await pool.query("SELECT id, patient_number FROM public.patients ORDER BY id")).rows;

beforeEach(async () => {
  owned = undefined;
  name = "aqlan_numbering_cold_" + randomUUID().replaceAll("-", "");
  const url = new URL(target.testUrl);
  url.pathname = "/" + name;
  validateLocalVerificationTarget(url.toString(), process.env, { varName: "OWNED_NUMBERING_COLD", databaseName: name });
  admin = new Client({ connectionString: target.maintenanceUrl.toString(), ssl: false });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  owned = (await admin.query<{oid: string; owner: string}>(identitySql, [name])).rows[0];
  if (!owned) throw new Error("Synthetic cold-start target ownership unverified");
  pool = new Pool({ connectionString: url.toString(), ssl: false, max: 4 });
  expect((await pool.query(
    "SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()",
  )).rows).toEqual([{name, ...owned}]);
  await pool.query(`CREATE SEQUENCE public.patient_number_seq;
    CREATE TABLE public.patients (id bigint PRIMARY KEY, patient_number text NOT NULL UNIQUE);
    INSERT INTO public.patients VALUES (1,'P-00042'),(2,'A-900000');
    SELECT setval('public.patient_number_seq',7000,false);`);
  f = new NumberingPgFixture(pool, "numbering_fixture_" + randomUUID().replaceAll("-", ""), async () => owner());
  await f.initialize();
  await prepareLegacyFixture(f, "7000", false, ["P-00042", "A-900000"]);
  await bootstrapLegacyFixture(f);
  await pool.query(`CREATE TABLE ${f.schema}.retired_aliases (number text PRIMARY KEY, patient_id bigint NOT NULL)`);
  const before = await f.preview("A");
  expect(await executeNumberingCommand({
    prefix: "A", next: "1500", expectedRevision: before.revision, reason: "Synthetic high floor",
    requestId: "synthetic_cold_rewind",
  }, f)).toEqual({ ok: false, reason: "would-reuse-or-rewind" });
  expect(await executeNumberingCommand({
    prefix: "A", next: "900001", expectedRevision: before.revision, reason: "Synthetic valid high floor",
    requestId: "synthetic_cold_valid",
  }, f)).toMatchObject({ ok: true, value: { preview: "A-900001" } });
  archive = await f.exportRecoverySidecar(lineage);
});
afterEach(async () => {
  const failures: unknown[] = [];
  try { await pool?.end(); } catch (error) { failures.push(error); }
  try {
    if (owned && /^aqlan_numbering_cold_[0-9a-f]{32}$/.test(name)) {
      for (let attempt = 0;; attempt++) {
        if (JSON.stringify((await admin.query(identitySql, [name])).rows[0]) !== JSON.stringify(owned)) {
          throw new Error("Synthetic cold-start database identity changed");
        }
        try { await admin.query(`DROP DATABASE "${name}"`); break; }
        catch (error) { if ((error as {code?: string}).code !== "55006" || attempt === 4) throw error; await delay(100); }
      }
    }
  } catch (error) { failures.push(error); }
  try { await admin?.end(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Synthetic cold-start fixture cleanup failed");
});
function witness(sha256 = archive.manifest.sha256, legacyP = { lastValue: "7000", isCalled: false }) {
  return { expectedLineage: lineage, readCurrent: async () => ({
    version: 1 as const, lineage, stateSha256: sha256, legacyP,
  }) };
}

it("checks high A history, never inflates P, and issues A-900001 after cold reconciliation", async () => {
  const before = await rows();
  expect(await f.reconcileProvenLegacyP(archive, witness())).toEqual({ ok: true, next: "7000" });
  expect(await rows()).toEqual(before);
  expect(await readLegacy()).toEqual([{ last_value: "7000", is_called: false }]);
  expect(await f.issue()).toBe("A-900001");
});
it("reconciles a fresh restore's low public sequence from proven P only and can run again without rewind", async () => {
  await pool.query("SELECT setval('public.patient_number_seq',1,true)");
  expect(await f.reconcileProvenLegacyP(archive, witness())).toEqual({ ok: true, next: "7000" });
  expect(await f.reconcileProvenLegacyP(archive, witness())).toEqual({ ok: true, next: "7000" });
  expect(await readLegacy()).toEqual([{ last_value: "7000", is_called: false }]);
  expect(await rows()).toEqual([{ id: "1", patient_number: "P-00042" }, { id: "2", patient_number: "A-900000" }]);
  expect(await f.issue()).toBe("A-900001");
});
it("does not invent a universal floor when independent compatible P evidence proves a lower reservation", async () => {
  await pool.query(`SELECT setval('${f.schema}.seq_p',50,false);
    SELECT setval('public.patient_number_seq',1,true)`);
  const lower = await f.exportRecoverySidecar(lineage);
  expect(await f.reconcileProvenLegacyP(lower, witness(lower.manifest.sha256, { lastValue: "50", isCalled: false })))
    .toEqual({ ok: true, next: "50" });
  expect(await readLegacy()).toEqual([{ last_value: "50", is_called: false }]);
});
it("keeps A-01500 proven after re-reserving A-02000 even when historicalThrough remains zero", async () => {
  // Replace only the isolated test's high-A example with an independently
  // initialized schema where A truly has no prior allocation.
  await pool.query("DELETE FROM public.patients WHERE id=2 AND patient_number='A-900000'");
  const fresh = new NumberingPgFixture(pool, "numbering_fixture_" + randomUUID().replaceAll("-", ""), async () => owner());
  await fresh.initialize();
  await prepareLegacyFixture(fresh, "7000", false, ["P-00042"]);
  await bootstrapLegacyFixture(fresh);
  await pool.query(`CREATE TABLE ${fresh.schema}.retired_aliases (number text PRIMARY KEY, patient_id bigint NOT NULL)`);
  async function reserve(next: string) {
    return executeNumberingCommand({
      prefix: "A", next, expectedRevision: (await fresh.preview("A")).revision,
      reason: "Synthetic reservation rollover", requestId: "synthetic_rollover_" + next,
    }, fresh);
  }
  expect(await reserve("1500")).toMatchObject({ ok: true });
  const first = await fresh.issue();
  expect(first).toBe("A-01500");
  await pool.query("INSERT INTO public.patients VALUES (2,$1)", [first]);
  expect(await reserve("2000")).toMatchObject({ ok: true });
  expect(await fresh.preview("A")).toMatchObject({
    allocatedThrough: 0n, pendingNext: 2000n, historicalThrough: 0n,
  });
  expect((await pool.query(
    `SELECT before_state->>'allocatedThrough' AS previous FROM ${fresh.schema}.audit ORDER BY id`,
  )).rows).toEqual([{previous: "0"}, {previous: "1500"}]);
  const rollover = await fresh.exportRecoverySidecar(lineage);
  const wanted = witness(rollover.manifest.sha256);
  // The audit proves through A-01500, not every gap before pending A-02000.
  await pool.query("INSERT INTO public.patients VALUES (3,'A-01501')");
  expect(await fresh.reconcileProvenLegacyP(rollover, wanted)).toEqual({
    ok: false, reason: "patient-number-beyond-proven-counter",
  });
  await pool.query("DELETE FROM public.patients WHERE id=3 AND patient_number='A-01501'");
  expect(await fresh.reconcileProvenLegacyP(rollover, wanted)).toEqual({ ok: true, next: "7000" });
  expect(await rows()).toEqual([{ id: "1", patient_number: "P-00042" }, { id: "2", patient_number: first }]);
  expect(await readLegacy()).toEqual([{ last_value: "7000", is_called: false }]);
  expect(await fresh.issue()).toBe("A-02000");
});
it("fails closed if a surviving high A would collide with the supposedly pending next number", async () => {
  await pool.query("INSERT INTO public.patients VALUES (3,'A-900001'); SELECT setval('public.patient_number_seq',1,true)");
  const before = await rows();
  expect(await f.reconcileProvenLegacyP(archive, witness())).toEqual({ ok: false, reason: "patient-number-beyond-proven-counter" });
  expect(await rows()).toEqual(before);
  expect(await readLegacy()).toEqual([{ last_value: "1", is_called: true }]);
  expect((await f.preview("A")).pendingNext).toBe(900001n);
});
it("does not use an archive when external evidence is missing, newer, or inconsistent with the restored namespace", async () => {
  await pool.query("SELECT setval('public.patient_number_seq',1,true)");
  expect(await f.reconcileProvenLegacyP(archive, null)).toEqual({ ok: false, reason: "trusted-witness-unavailable" });
  expect(await f.issue()).toBe("A-900001");
  const newer = await f.exportRecoverySidecar(lineage);
  expect(await f.reconcileProvenLegacyP(archive, witness(newer.manifest.sha256)))
    .toEqual({ ok: false, reason: "freshness-mismatch" });
  expect(await f.reconcileProvenLegacyP(archive, witness())).toEqual({ ok: false, reason: "restored-numbering-state-mismatch" });
  expect(await readLegacy()).toEqual([{ last_value: "1", is_called: true }]);
});
it("rolls back a P mirror advance if the independent witness changes before commit", async () => {
  await pool.query("SELECT setval('public.patient_number_seq',1,true)");
  let calls = 0;
  const changing = { expectedLineage: lineage, readCurrent: async () => ({
    version: 1 as const, lineage,
    stateSha256: ++calls === 1 ? archive.manifest.sha256 : "b".repeat(64),
    legacyP: { lastValue: "7000", isCalled: false },
  }) };
  expect(await f.reconcileProvenLegacyP(archive, changing)).toEqual({ ok: false, reason: "freshness-mismatch" });
  expect(calls).toBe(2);
  expect(await readLegacy()).toEqual([{ last_value: "1", is_called: true }]);
});
it("does not confuse a low restored P with the source's independently observed higher P", async () => {
  await pool.query("SELECT setval('public.patient_number_seq',1,true)");
  expect(await f.reconcileProvenLegacyP(archive, witness(archive.manifest.sha256, { lastValue: "880000", isCalled: true })))
    .toEqual({ ok: false, reason: "independent-legacy-P-ahead" });
  expect(await readLegacy()).toEqual([{ last_value: "1", is_called: true }]);
});
it("rolls back if independently observed legacy P changes but the namespace digest stays the same", async () => {
  await pool.query("SELECT setval('public.patient_number_seq',1,true)");
  let calls = 0;
  const changing = { expectedLineage: lineage, readCurrent: async () => ({
    version: 1 as const, lineage, stateSha256: archive.manifest.sha256,
    legacyP: { lastValue: ++calls === 1 ? "7000" : "7001", isCalled: false },
  }) };
  expect(await f.reconcileProvenLegacyP(archive, changing)).toEqual({ ok: false, reason: "recovery-proof-changed" });
  expect(await readLegacy()).toEqual([{ last_value: "1", is_called: true }]);
});
it("rolls back when the raw witness changes from called to pending despite identical next", async () => {
  await pool.query("SELECT setval('public.patient_number_seq',1,true)");
  let calls = 0;
  const changing = { expectedLineage: lineage, readCurrent: async () => ({
    version: 1 as const, lineage, stateSha256: archive.manifest.sha256,
    legacyP: ++calls === 1 ? { lastValue: "6999", isCalled: true } : { lastValue: "7000", isCalled: false },
  }) };
  expect(await f.reconcileProvenLegacyP(archive, changing)).toEqual({ ok: false, reason: "recovery-proof-changed" });
  expect(calls).toBe(2);
  expect(await readLegacy()).toEqual([{ last_value: "1", is_called: true }]);
});
it("holds an equivalent next value with the wrong raw target state rather than rewriting it backwards", async () => {
  await pool.query(`SELECT setval('${f.schema}.seq_p',7000,true);
    SELECT setval('public.patient_number_seq',7001,false);`);
  const called = await f.exportRecoverySidecar(lineage);
  expect(await f.reconcileProvenLegacyP(called, witness(called.manifest.sha256, { lastValue: "7000", isCalled: true })))
    .toEqual({ ok: false, reason: "legacy-P-state-mismatch" });
  expect(await readLegacy()).toEqual([{ last_value: "7001", is_called: false }]);
  expect((await f.preview("P")).allocatedThrough).toBe(7000n);
});
it("takes an ahead legacy P as evidence to hold rather than lower it or enable the smaller managed P", async () => {
  await pool.query("SELECT setval('public.patient_number_seq',900000,true)");
  const before = await rows();
  expect(await f.reconcileProvenLegacyP(archive, witness())).toEqual({ ok: false, reason: "legacy-P-state-mismatch" });
  expect(await readLegacy()).toEqual([{ last_value: "900000", is_called: true }]);
  expect((await f.preview("P")).pendingNext).toBe(7000n);
  expect(await rows()).toEqual(before);
});
it("does not guess a prefix or rewrite an ambiguous existing identifier", async () => {
  await pool.query("INSERT INTO public.patients VALUES (3,'LEGACY-900123')");
  const before = await rows();
  expect(await f.reconcileProvenLegacyP(archive, witness())).toEqual({ ok: false, reason: "ambiguous-patient-identifier" });
  expect(await rows()).toEqual(before);
  expect(await readLegacy()).toEqual([{ last_value: "7000", is_called: false }]);
});
it("rejects a restored live patient whose number conflicts with a retired alias owner", async () => {
  await pool.query(`INSERT INTO ${f.schema}.retired_aliases VALUES ('A-0900000', 99)`);
  const conflicts = await f.exportRecoverySidecar(lineage);
  expect(await f.reconcileProvenLegacyP(conflicts, witness(conflicts.manifest.sha256)))
    .toEqual({ ok: false, reason: "retired-alias-owner-conflict" });
});
