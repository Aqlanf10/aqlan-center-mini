import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, readFile, mkdir, cp } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { openBackupTimestampFixture } from "./_standalone-retained-fixture";
import { validateStandaloneWitnessEnvironment } from "./_standalone-restore-witness-guard";
import { fullBackupBlocks } from "../../lib/fullBackup";
import type { FollowupCoverageCommand } from "../../lib/ortho-followup-coverage";
import type { SessionPayload } from "../../lib/auth";
import { applyRuntimeMigrationFiles, loadMigrationFiles, migrate } from "../../lib/migrations";
import { parseTarBytes, documentEntryName } from "../../lib/restore/archive";
import { storageKeyOf } from "../helpers/backup-blocks";
import { backupStateDir } from "../../lib/backupVolume";
import { upsertBackupHistoryRecord } from "../../lib/backupHistory";
import { SESSION_COOKIE } from "../../lib/sessionCookie";
import { tarGzBytes } from "../helpers/backup-tar";

// Registered runtime bootstrap and migration-driven full archive restoration.
// All targets are newly owned, identity-verified synthetic PostgreSQL databases.
let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import("../../lib/db"), coverage: typeof import("../../lib/ortho-followup-coverage-db");
let historicalWriter: typeof import("./_historical-followup-coverage-writer");
let directory: string, actor: SessionPayload;
let patient: number, mergedPatient: number, ortho: number, visit: number, adjustment: number, invoice: number;
let firstCommand: FollowupCoverageCommand, rejectedCommand: FollowupCoverageCommand;
let firstRevision: string;
const documentBytes = Buffer.from("SYNTHETIC-RESTORE-HTTP-DOCUMENT-ONLY");
const documentKey = storageKeyOf(documentBytes.toString("utf8"));
let server: ChildProcess | undefined;
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
  // Enforce the single dedicated container before the fixture connects or
  // creates any database; post-creation URL checks are not sufficient.
  validateStandaloneWitnessEnvironment(process.env);
  vi.stubEnv("SESSION_SECRET", "synthetic-followup-restore-secret-at-least-32-characters");
  fixture = await openBackupTimestampFixture(process.env);
  directory = await mkdtemp(join(tmpdir(), "ortho-followup-restore-"));
  process.env.SKIP_SEED = "true";
  db = await import("../../lib/db"); coverage = await import("../../lib/ortho-followup-coverage-db");
  historicalWriter = await import("./_historical-followup-coverage-writer");
  await activate(fixture.source);
  await fixture.source.query("UPDATE schema_migrations SET applied_at='2025-03-04T05:06:07.123456Z' WHERE version='0079'");
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
    return historicalWriter.appendFollowupCoverage({ session: actor, patientId: patient, orthoCaseId: ortho, command });
  }
  firstRevision = (await decide("included")).revision.id;
  visit = (await q("INSERT INTO visits(patient_name,patient_id,doctor_id,chief_complaint,diagnosis) VALUES('Synthetic coverage restore',$1,$2,'Synthetic return','Synthetic review') RETURNING id", [patient, provider]))[0].id;
  const signed = await db.signClinicalVisit({ visitId: visit, baseCurrency: "YER", signedBy: actor.username, signerRole: "admin", signerDoctorPartyId: provider,
    orthoSession: { caseId: ortho, phase: null, upperWire: null, lowerWire: null, elastics: "none", elasticNote: null, done: "Synthetic documented routine followup", nextWeeks: 4, note: null } });
  expect(signed.reason).toBeNull(); expect(signed.invoiceId).toBeNull();
  adjustment = (await q("SELECT id FROM ortho_adjustments WHERE visit_id=$1", [visit]))[0].id;
  await decide("excluded");
  rejectedCommand = { ...firstCommand, commandId: randomUUID() };
  await expect(historicalWriter.appendFollowupCoverage({ session: actor, patientId: patient, orthoCaseId: ortho, command: rejectedCommand })).rejects.toMatchObject({ code: "stale_coverage" });
  expect((await q("SELECT command_id::text FROM ortho_followup_coverage_rejections"))).toEqual([{ command_id: rejectedCommand.commandId }]);
  // Exercise the supported merge writer: immutable recorded ownership must
  // survive even after the old patient record has actually been removed.
  await q("UPDATE invoices SET status='cancelled' WHERE id=$1", [invoice]);
  expect(await db.mergeDuplicatePatient(patient, mergedPatient, {actor:actor.username,actorRole:'admin',reason:'Synthetic duplicate patient merge'})).toMatchObject({ok:true});
  expect(await q("SELECT id FROM patients WHERE id=$1",[patient])).toEqual([]);
  await q("CREATE INDEX synthetic_followup_reverse ON ortho_followup_coverage_revisions(ortho_case_id,version DESC); CLUSTER ortho_followup_coverage_revisions USING synthetic_followup_reverse; DROP INDEX synthetic_followup_reverse");
  expect((await q("SELECT version FROM ortho_followup_coverage_revisions")).map(row => row.version)).toEqual([2, 1]);
  await q("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES ($1,'xray','synthetic only','image/png',$2,$3,$4,'synthetic')", [mergedPatient, documentBytes.length, createHash("sha256").update(documentBytes).digest("hex"), documentKey]);
  const client = await fixture.source.connect();
  try {
    const blocks: Uint8Array[] = [];
    for await (const block of fullBackupBlocks({ source: client, readDocument: async (key) => key === documentKey ? documentBytes : null })) blocks.push(block);
    await writeFile(join(directory, "synthetic-followup.tar.gz"), gzipSync(Buffer.concat(blocks)));
  } finally { client.release(); }
}, 180000);
afterAll(async () => {
  if (server && server.exitCode === null) { await new Promise<void>((resolve) => { server!.once("exit", () => resolve()); server!.kill("SIGTERM"); setTimeout(() => { if (server?.exitCode === null) server.kill("SIGKILL"); }, 3000).unref(); }); }
  try { await db?.resetPoolForTesting(); } finally {
    if (originalUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalUrl;
    if (originalSeed === undefined) delete process.env.SKIP_SEED; else process.env.SKIP_SEED = originalSeed;
    await fixture?.close(); if (directory) console.log(`SYNTHETIC_EVIDENCE_DIRECTORY=${directory}`); vi.unstubAllEnvs();
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

// This witness is intentionally explicit: it can destroy only a random database
// created and identity-checked by openBackupTimestampFixture on the dedicated
// loopback PostgreSQL service. Never point it at a shared server or a real volume.
it("standalone HTTP restores old and fresh synthetic archives and rejects traversal before target reset", async () => {
  const serverEntry = process.env.SYNTHETIC_STANDALONE_SERVER;
  if (!serverEntry || !path.isAbsolute(serverEntry) || !serverEntry.endsWith("/.next/standalone/server.js")) {
    throw new Error("SYNTHETIC_STANDALONE_SERVER must name the local built standalone server");
  }
  const sourceUrl = fixture.source.options.connectionString!;
  const targetUrl = fixture.archiveTarget.options.connectionString!;
  for (const urlText of [sourceUrl, targetUrl, fixture.sqlTarget.options.connectionString!]) {
    const u = new URL(urlText);
    if (u.hostname !== "127.0.0.1" || u.port !== "55472" || !/^\/aqlan_backup_precision_[a-f0-9]{32}$/.test(u.pathname)) {
      throw new Error("synthetic owned loopback database required");
    }
  }
  if (sourceUrl === targetUrl) throw new Error("source and dedicated restore target must differ");
  const targetIdentity = (await fixture.archiveTarget.query("SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows[0];
  const assertOwnedTarget = async () => {
    const actual = (await fixture.archiveTarget.query("SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows[0];
    expect(actual).toEqual(targetIdentity);
    expect(actual.name).toMatch(/^aqlan_backup_precision_[a-f0-9]{32}$/);
  };
  const port = await new Promise<number>((resolve, reject) => {
    const s = createServer(); s.on("error", reject); s.listen(0, "127.0.0.1", () => {
      const addr = s.address(); if (!addr || typeof addr === "string") return reject(new Error("no test port"));
      const selected = addr.port; s.close((error) => error ? reject(error) : resolve(selected));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const volume = join(directory, "synthetic-volume"), backupDir = join(volume, "backups"), stage = join(backupStateDir(backupDir), "restore-drill-current");
  await mkdir(backupStateDir(backupDir), { recursive: true });
  await mkdir(join(volume, "documents"), { recursive: true });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SESSION_SECRET: process.env.SESSION_SECRET, CLINIC_TIME_ZONE: "Asia/Aden",
    NODE_ENV: "production", PORT: String(port), HOSTNAME: "127.0.0.1", APP_ORIGIN: base,
    DATABASE_URL: sourceUrl, TEST_DATABASE_URL: sourceUrl, DATABASE_ENVIRONMENT: "test", USE_LOCAL_DB: "false", SKIP_SEED: "true", CI: "false",
    RESTORE_DRILL_DATABASE_URL: targetUrl, RESTORE_DRILL_DATABASE_ENVIRONMENT: "test", RESTORE_DRILL_DEDICATED_TARGET: "true",
    RAILWAY_VOLUME_MOUNT_PATH: volume, DOCUMENTS_DIR: join(volume, "documents") };
  server = spawn(process.execPath, [serverEntry], { cwd: directory, env, stdio: ["ignore", "ignore", "ignore"] });
  const deadline = Date.now() + 60000;
  while (true) {
    if (server.exitCode !== null) throw new Error("synthetic standalone server exited during startup");
    try { if ((await fetch(`${base}/api/ping`)).ok) break; } catch { /* starting */ }
    if (Date.now() > deadline) throw new Error("synthetic standalone startup timed out");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const { createSessionToken } = await import("../../lib/auth");
  const cookie = `${SESSION_COOKIE}=${createSessionToken(actor)}`;
  const post = (backupId: string, useCookie = true) => fetch(`${base}/api/settings/backup/restore`, {
    method: "POST", headers: { ...(useCookie ? {cookie} : {}), Origin: base, "Sec-Fetch-Site":"same-origin", "Content-Type":"application/json" },
    body: JSON.stringify({ backupId, confirmation: backupId }),
  });
  async function register(backupId: string, bytes: Uint8Array) {
    const parsed = parseTarBytes(gunzipSync(bytes));
    const manifest = JSON.parse(Buffer.from(parsed.entries.get("manifest.json")!.data).toString("utf8"));
    await writeFile(join(backupDir, backupId), bytes);
    await upsertBackupHistoryRecord(backupDir, { backupId, createdAt: new Date().toISOString(), triggerType:"manual",
      archiveSha256:createHash("sha256").update(bytes).digest("hex"), archiveBytes:bytes.byteLength,
      databaseSha256:manifest.databaseSha256, documentCount:manifest.documents.length,
      status:"verified", replicationStatus:"none", destinations:[] });
  }
  const oldId = "production-backup-20261117-010203-001-abcde123-abcdef12.tar.gz";
  const oldBytes = await readFile(join(directory, "synthetic-followup.tar.gz"));
  await register(oldId, oldBytes);
  // No real target is ever reset before identity verification.
  await assertOwnedTarget(); expect((await post(oldId, false)).status).toBe(401);
  await assertOwnedTarget(); const old = await post(oldId); expect(old.status).toBe(200);
  expect(await old.json()).toMatchObject({ok:true,readyForCutover:true,documentsVerified:1});
  expect(await readFile(join(stage, documentKey))).toEqual(documentBytes);
  await cp(stage, join(directory, "preserved-old-stage"), { recursive: true, errorOnExist: true, force: false });
  expect((await fixture.archiveTarget.query("SELECT version,name,checksum,applied_at::text,adopted FROM schema_migrations WHERE version='0079'")).rows)
    .toEqual((await fixture.source.query("SELECT version,name,checksum,applied_at::text,adopted FROM schema_migrations WHERE version='0079'")).rows);
  process.env.DATABASE_URL=targetUrl; await db.resetPoolForTesting(); await verify(fixture.archiveTarget);

  // A verified-record-shaped, otherwise consistent tar contains a traversal
  // key. The existing route must reject it before its dedicated target reset.
  const parsed = parseTarBytes(gunzipSync(oldBytes));
  const manifest = JSON.parse(Buffer.from(parsed.entries.get("manifest.json")!.data).toString("utf8"));
  const originalName = documentEntryName(manifest.documents[0].storageKey);
  manifest.documents[0].storageKey = "../synthetic-outside.png";
  const tampered = tarGzBytes(parsed.order.map(name => ({
    name: name === originalName ? documentEntryName(manifest.documents[0].storageKey) : name,
    data: name === "manifest.json" ? Buffer.from(JSON.stringify(manifest)) : parsed.entries.get(name)!.data,
  })));
  const badId = "production-backup-20261117-010203-002-abcde123-abcdef12.tar.gz";
  await register(badId, tampered);
  const before = await snapshots(fixture.archiveTarget);
  await assertOwnedTarget(); const bad = await post(badId); expect(bad.status).toBe(500);
  expect(await bad.json()).toMatchObject({ok:false,reason:"archive-integrity-mismatch"});
  expect(await snapshots(fixture.archiveTarget)).toEqual(before);
  await expect(readFile(join(volume, "synthetic-outside.png"))).rejects.toMatchObject({code:"ENOENT"});

  // A second valid archive is deliberately fresh: 0079 must remain absent.
  await migrate(fixture.sqlTarget, {apply:true, files:await loadMigrationFiles()});
  const patient = (await fixture.sqlTarget.query("INSERT INTO patients(patient_number,full_name) VALUES('SYN-FRESH-HTTP','Synthetic fresh only') RETURNING id")).rows[0].id;
  await fixture.sqlTarget.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES ($1,'xray','synthetic only','image/png',$2,$3,$4,'synthetic')", [patient, documentBytes.length, createHash("sha256").update(documentBytes).digest("hex"), documentKey]);
  const client = await fixture.sqlTarget.connect(), parts: Uint8Array[] = [];
  try { for await (const part of fullBackupBlocks({source:client, readDocument:async (key)=>key===documentKey?documentBytes:null})) parts.push(part); }
  finally { client.release(); }
  const freshId = "production-backup-20261117-010203-003-abcde123-abcdef12.tar.gz";
  await register(freshId, gzipSync(Buffer.concat(parts)));
  await assertOwnedTarget(); const fresh = await post(freshId); expect(fresh.status).toBe(200);
  expect(await fresh.json()).toMatchObject({ok:true,readyForCutover:true,documentsVerified:1});
  expect(await readFile(join(stage, documentKey))).toEqual(documentBytes);
  expect((await fixture.archiveTarget.query("SELECT to_regclass('public.ortho_followup_coverage_revisions') AS name")).rows[0].name).toBeNull();
  expect((await fixture.archiveTarget.query("SELECT patient_number FROM patients WHERE patient_number='SYN-FRESH-HTTP'")).rows).toHaveLength(1);
}, 300000);
