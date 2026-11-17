import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { fullBackupBlocks } from "../../lib/fullBackup";
import { stagedRestore } from "../../lib/restore/staging";
import { prepareBackupSql } from "../../lib/restore/sql.mjs";
import type { FollowupCoverageCommand } from "../../lib/ortho-followup-coverage";
import type { SessionPayload } from "../../lib/auth";
import { applyRuntimeMigrationFiles, loadMigrationFiles, migrate } from "../../lib/migrations";
import { parseTarBytes } from "../../lib/restore/archive";
import { tarGzBytes } from "../helpers/backup-tar";

// Registered runtime bootstrap and migration-driven full archive restoration.
// All targets are newly owned, identity-verified synthetic PostgreSQL databases.
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import("../../lib/db"), coverage: typeof import("../../lib/ortho-followup-coverage-db");
let directory: string, sql: string, actor: SessionPayload;
let patient: number, mergedPatient: number, ortho: number, visit: number, adjustment: number, invoice: number;
let firstCommand: FollowupCoverageCommand, rejectedCommand: FollowupCoverageCommand;
let firstRevision: string, initialReset: unknown, emptyBackupCalls = 0;
const originalUrl = process.env.DATABASE_URL, originalSeed = process.env.SKIP_SEED;
const q = async (sql: string, args: unknown[] = []) => (await db.getPool().query(sql, args)).rows;
async function activate(pool: Pool) {
  process.env.DATABASE_URL = pool.options.connectionString!;
  await db.resetPoolForTesting(); await db.ensureSchema();
  const historical = (await loadMigrationFiles()).find(file => file.version === '0079');
  if (!historical) throw new Error('Missing exact historical 0079');
  await applyRuntimeMigrationFiles(pool, [historical]);
  expect((await pool.query("SELECT version,adopted FROM schema_migrations WHERE version='0079'")).rows).toEqual([{version:"0079",adopted:false}]);
}
async function snapshots(pool: Pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations' ORDER BY tablename")).rows;
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) result[tablename] = (await pool.query(`SELECT to_jsonb(t)::text AS value FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-followup-restore-secret-at-least-32-characters");
  fixture = await openBackupTimestampFixture(process.env);
  directory = await mkdtemp(join(tmpdir(), "ortho-followup-restore-"));
  process.env.SKIP_SEED = "true";
  db = await import("../../lib/db"); coverage = await import("../../lib/ortho-followup-coverage-db");
  await activate(fixture.source);
  await fixture.source.query("UPDATE schema_migrations SET applied_at='2025-03-04T05:06:07.123456Z' WHERE version='0079'");
  initialReset = await db.resetClinicData({ actor: "synthetic-empty-reset", actorRole: "admin" }, async () => {
    emptyBackupCalls++; return { ok: true as const, backupId: "synthetic-empty-reset" };
  });
  const { sessionCredentialVersion } = await import("../../lib/auth");
  const user = (await q("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-followup-restore','Synthetic restore admin','synthetic-hash','admin') RETURNING id"))[0].id;
  actor = { userId: user, username: "synthetic-followup-restore", role: "admin", expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion("synthetic-hash") };
  patient = (await q("INSERT INTO patients(patient_number,full_name) VALUES('SYN-COVERAGE-RESTORE','Synthetic coverage restore') RETURNING id"))[0].id;
  mergedPatient = (await q("INSERT INTO patients(patient_number,full_name) VALUES('SYN-COVERAGE-MERGED','Synthetic merged identity') RETURNING id"))[0].id;
  const provider = (await db.createParty({name:"Synthetic treating provider",kind:"doctor",phone:null,commissionPercent:0,note:null})).id;
  const service = (await q("INSERT INTO services(name,category,price_minor) VALUES('Synthetic ortho service','ortho',250000) RETURNING id"))[0].id;
  ortho = (await q("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,$2) RETURNING id", [patient, actor.username]))[0].id;
  const clinical = (await q("INSERT INTO clinical_cases(patient_id,specialty,title,site,ortho_case_id,created_by) VALUES($1,'orthodontics','Synthetic case','both',$2,$3) RETURNING id", [patient, ortho, actor.username]))[0].id;
  const plan = (await q("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,consent_at,consent_by) VALUES($1,'Synthetic invoice agreement',250000,'YER',NOW(),$2) RETURNING id", [patient, actor.username]))[0].id;
  invoice = (await q("INSERT INTO invoices(patient_id,invoice_number,total_minor,base_currency) VALUES($1,'SYN-COVERAGE-INVOICE',250000,'YER') RETURNING id", [patient]))[0].id;
  const item = (await q(`INSERT INTO plan_items(plan_id,case_id,service_id,service_name,category,doctor_id,quantity,unit_price_minor,billing_status,billed_invoice_id,origin_invoice_id,origin,session_count)
    VALUES($1,$2,$3,'Synthetic ortho service','ortho',$4,1,250000,'billed',$5,$5,'invoice',12) RETURNING id`, [plan, clinical, service, provider, invoice]))[0].id;
  await q(`INSERT INTO invoice_items(invoice_id,service_id,doctor_id,description,quantity,unit_price_minor,total_minor,source_type,source_id,plan_item_id)
    VALUES($1,$2,$3,'Synthetic ortho service',1,250000,250000,'plan_item',$4::bigint,$4::int)`, [invoice, service, provider, item]);
  async function decide(decision: "included" | "excluded") {
    const read = await coverage.readFollowupCoverage({ session: actor, patientId: patient, orthoCaseId: ortho });
    const { fingerprint, invoiceNumber: _number, serviceName: _name, ...source } = read.sources[0];
    const command: FollowupCoverageCommand = {
      schemaVersion: 1, commandId: randomUUID(), expectedRevisionId: read.current?.id ?? null, source,
      expectedSourceFingerprint: fingerprint, scope: "routine_adjustments", decision, reason: "Synthetic explicit historical contract decision",
    };
    if (decision === "included") firstCommand = command;
    return coverage.appendFollowupCoverage({ session: actor, patientId: patient, orthoCaseId: ortho, command });
  }
  firstRevision = (await decide("included")).revision.id;
  visit = (await q("INSERT INTO visits(patient_name,patient_id,doctor_id,chief_complaint,diagnosis) VALUES('Synthetic coverage restore',$1,$2,'Synthetic return','Synthetic review') RETURNING id", [patient, provider]))[0].id;
  const signed = await db.signClinicalVisit({ visitId: visit, baseCurrency: "YER", signedBy: actor.username, signerRole: "admin", signerDoctorPartyId: provider,
    orthoSession: { caseId: ortho, phase: null, upperWire: null, lowerWire: null, elastics: "none", elasticNote: null, done: "Synthetic documented routine followup", nextWeeks: 4, note: null } });
  expect(signed.reason).toBeNull(); expect(signed.invoiceId).toBeNull();
  adjustment = (await q("SELECT id FROM ortho_adjustments WHERE visit_id=$1", [visit]))[0].id;
  await decide("excluded");
  rejectedCommand = { ...firstCommand, commandId: randomUUID() };
  await expect(coverage.appendFollowupCoverage({ session: actor, patientId: patient, orthoCaseId: ortho, command: rejectedCommand })).rejects.toMatchObject({ code: "stale_coverage" });
  expect((await q("SELECT command_id::text FROM ortho_followup_coverage_rejections"))).toEqual([{ command_id: rejectedCommand.commandId }]);
  // Exercise the supported merge writer: immutable recorded ownership must
  // survive even after the old patient record has actually been removed.
  await q("UPDATE invoices SET status='cancelled' WHERE id=$1", [invoice]);
  expect(await db.mergeDuplicatePatient(patient, mergedPatient, {actor:actor.username,actorRole:'admin',reason:'Synthetic duplicate patient merge'})).toMatchObject({ok:true});
  expect(await q("SELECT id FROM patients WHERE id=$1",[patient])).toEqual([]);
  await q("CREATE INDEX synthetic_followup_reverse ON ortho_followup_coverage_revisions(ortho_case_id,version DESC); CLUSTER ortho_followup_coverage_revisions USING synthetic_followup_reverse; DROP INDEX synthetic_followup_reverse");
  expect((await q("SELECT version FROM ortho_followup_coverage_revisions")).map(row => row.version)).toEqual([2, 1]);
  const client = await fixture.source.connect();
  try {
    sql = ""; for await (const line of db.backupSqlLines(client)) sql += line;
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client, readDocument: async () => { throw new Error("No synthetic documents expected"); } })) blocks.push(block);
    await writeFile(join(directory, "synthetic-followup.tar.gz"), gzipSync(Buffer.concat(blocks)));
  } finally { client.release(); }
}, 180000);
afterAll(async () => {
  try { await db?.resetPoolForTesting(); } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
    if (originalSeed === undefined) delete process.env.SKIP_SEED; else process.env.SKIP_SEED = originalSeed;
    await fixture?.close(); if (directory) await rm(directory, { recursive: true, force: true }); vi.unstubAllEnvs();
  }
});
async function verify(pool: Pool) {
  expect(await snapshots(pool)).toEqual(await snapshots(fixture.source));
  // Immutable original command receipts remain reconcilable after current owner
  // reassignment; access is checked against the case's current patient.
  expect(await coverage.readFollowupCoverageCommandStatus({ session: actor, patientId: patient, orthoCaseId: ortho, command: firstCommand })).toMatchObject({ state: "committed", revision: { id: firstRevision, commandId: firstCommand.commandId } });
  expect(await coverage.readFollowupCoverageCommandStatus({ session: actor, patientId: patient, orthoCaseId: ortho, command: rejectedCommand })).toMatchObject({ state: "rejected", rejection: { commandId: rejectedCommand.commandId, code: "stale_coverage", terminal: true, actor: actor.username, command: rejectedCommand } });
  expect((await coverage.readSignedFollowupProofs(db.getPool(), [adjustment])).get(adjustment)).toEqual({ invoiceId: invoice, valid: false });
  expect((await q("SELECT billing_class,followup_coverage_revision_id::text FROM ortho_adjustments WHERE id=$1", [adjustment]))[0]).toEqual({ billing_class: "INCLUDED", followup_coverage_revision_id: firstRevision });
  expect((await q("SELECT ortho_followup_coverage_proof FROM visits WHERE id=$1", [visit]))[0].ortho_followup_coverage_proof).toEqual([{ adjustmentId: adjustment, caseId: ortho, revisionId: firstRevision, patientId: patient }]);
  expect((await db.visitWalkout(visit))?.orthoAdjustment).toMatchObject({ billingClass: "INCLUDED", coverageReviewRequired: true, pendingDecision: false });
  expect(await snapshots(pool)).toEqual(await snapshots(fixture.source));
}
it("empty protected reset succeeds, while populated coverage refuses before requesting backup", async () => {
  expect(initialReset).toMatchObject({ ok: true, backupId: "synthetic-empty-reset" }); expect(emptyBackupCalls).toBe(1);
  const before = await snapshots(fixture.source), backup = vi.fn(async () => ({ ok: true as const, backupId: "must-not-run" }));
  await expect(db.resetClinicData({ actor: actor.username, actorRole: "admin" }, backup)).rejects.toMatchObject({ name: "ProtectedOrthoFollowupHistoryError" });
  expect(backup).not.toHaveBeenCalled(); expect(await snapshots(fixture.source)).toEqual(before);
});
it("exact SQL replay preserves historical signed proof and ordered revisions after cancellation and reassignment", async () => {
  await activate(fixture.sqlTarget);
  await fixture.sqlTarget.query(prepareBackupSql(sql).sql);
  await verify(fixture.sqlTarget);
});
it("migration-driven full archive restoration preserves committed and refused commands with historical guards", async () => {
  const result=await stagedRestore({archivePath:join(directory,"synthetic-followup.tar.gz"),targetUrl:fixture.archiveTarget.options.connectionString!,stagingDir:join(directory,"documents")});
  expect(result).toMatchObject({ok:true,errors:[],validationErrors:[]});
  expect(result.migrationsApplied).toContain('0079');
  expect((await fixture.archiveTarget.query("SELECT applied_at::text FROM schema_migrations WHERE version='0079'")).rows)
    .toEqual((await fixture.source.query("SELECT applied_at::text FROM schema_migrations WHERE version='0079'")).rows);
  process.env.DATABASE_URL=fixture.archiveTarget.options.connectionString!;
  await db.resetPoolForTesting();
  await verify(fixture.archiveTarget);
});
it("restores a fresh archive without activating 0079 and refuses an inconsistent old archive", async () => {
  const isolated = await openBackupTimestampFixture(process.env);
  try {
    await migrate(isolated.source, { apply: true });
    await isolated.source.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-FRESH-0079','Synthetic fresh restore')");
    const client = await isolated.source.connect(), blocks: Uint8Array[] = [];
    try { for await (const block of fullBackupBlocks({ source: client })) blocks.push(block); }
    finally { client.release(); }
    const freshPath = join(directory, 'fresh-without-0079.tar.gz');
    await writeFile(freshPath, gzipSync(Buffer.concat(blocks)));
    const fresh = await stagedRestore({ archivePath: freshPath, targetUrl: isolated.sqlTarget.options.connectionString!, stagingDir: join(directory, 'fresh-documents') });
    expect(fresh.errors).toEqual([]); expect(fresh.ok).toBe(true);
    expect(fresh.migrationsApplied).not.toContain('0079');
    expect((await isolated.sqlTarget.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS name")).rows[0].name).toBeNull();
    expect((await isolated.sqlTarget.query("SELECT patient_number FROM patients WHERE patient_number='SYN-FRESH-0079'")).rows).toHaveLength(1);

    const old = parseTarBytes(gunzipSync(await (await import('node:fs/promises')).readFile(join(directory, 'synthetic-followup.tar.gz'))));
    const original = Buffer.from(old.entries.get('database.sql')!.data).toString('utf8');
    const stripped = original.replace(/^INSERT INTO schema_migrations \("version", "name", "checksum", "applied_at", "adopted"\) VALUES \('0079'.*\);\n/m, '');
    expect(stripped).not.toBe(original);
    const faultySql = Buffer.from(stripped), manifest = JSON.parse(Buffer.from(old.entries.get('manifest.json')!.data).toString('utf8'));
    manifest.databaseSha256 = createHash('sha256').update(faultySql).digest('hex'); manifest.databaseBytes = faultySql.length;
    const inconsistentPath = join(directory, 'inconsistent-without-registry.tar.gz');
    await writeFile(inconsistentPath, tarGzBytes(old.order.map(name => ({ name, data: name === 'database.sql' ? faultySql : name === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : old.entries.get(name)!.data }))));
    const inconsistent = await stagedRestore({ archivePath: inconsistentPath, targetUrl: isolated.archiveTarget.options.connectionString!, stagingDir: join(directory, 'inconsistent-documents') });
    expect(inconsistent.ok).toBe(false); expect(inconsistent.readyForCutover).toBe(false);
    expect(inconsistent.errors.length).toBeGreaterThan(0);
    expect((await isolated.archiveTarget.query("SELECT count(*)::int AS n FROM patients")).rows[0].n).toBe(0);
    expect((await isolated.archiveTarget.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS name")).rows[0].name).toBeNull();
  } finally { await isolated.close(); }
}, 180000);
