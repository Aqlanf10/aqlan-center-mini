import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import { openBackupTimestampFixture } from './_backup-timestamp-fixture';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { stagedRestore } from '../../lib/restore/staging';
import { sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { hrTemporalAuthority } from '../../lib/hr-temporal-authority';
import { parseHrHistoryCommand } from '../../lib/hr-temporal-request';
import { recordHrHistory } from '../../lib/hr-temporal-write';
import { RESET_KEEP_TABLES } from '../../lib/clinic-reset';

vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

let fixture: Awaited<ReturnType<typeof openBackupTimestampFixture>>;
let db: typeof import('../../lib/db'), actor: SessionPayload, directory: string, sql: string, archive: Buffer;
let originalReceipt: Awaited<ReturnType<typeof recordHrHistory>>;
let originalCommand: ReturnType<typeof parseHrHistoryCommand>;
const originalUrl = process.env.DATABASE_URL, originalSeed = process.env.SKIP_SEED;
async function rows(pool: Pool) {
  const tables = (await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'schema_migrations' ORDER BY tablename")).rows;
  const result: Record<string, unknown> = {};
  for (const { tablename } of tables) result[tablename] = (await pool.query(`SELECT to_jsonb(t)::text AS value FROM "${tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}
beforeAll(async () => {
  fixture = await openBackupTimestampFixture({ ...process.env });
  directory = await mkdtemp(join(tmpdir(), 'hr-composed-backup-'));
  process.env.DATABASE_URL = fixture.source.options.connectionString!;
  process.env.SKIP_SEED = 'true';
  db = await import('../../lib/db'); await db.resetPoolForTesting(); await db.ensureSchema();
  expect((await fixture.source.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version)).toEqual(['0051', '0052', '0056', '0057', '0058', '0063', '0064', '0065', '0066', '0067', '0068', '0069', '0074', '0078', '0079', '0080', '0081', '0082']);
  await fixture.source.query("INSERT INTO users(id,username,display_name,password_hash,role) VALUES(710,'composed-admin','Synthetic administrator','synthetic-hash','admin')");
  await fixture.source.query("INSERT INTO hr_staff(id,full_name,created_by,contract_kind,salary_amount_minor,salary_currency,salary_period,salary_effective_on,hire_date) VALUES(810,'Synthetic receptionist','test','salary',90000,'YER','monthly','2020-01-01','2020-01-01')");
  // A real financial DATE must survive both supported restore entry points too.
  // Synthetic fixture rows only; no financial calculation or posting is changed.
  await fixture.source.query("INSERT INTO parties(id,name,kind) VALUES(820,'Synthetic backup supplier','supplier')");
  await fixture.source.query("INSERT INTO payables(id,party_id,description,amount_minor,currency,base_amount_minor,due_date,created_by) VALUES(830,820,'Synthetic backup due date',12345,'YER',12345,'2028-02-29','test')");
  await fixture.source.query("SELECT setval(pg_get_serial_sequence('hr_effective_streams','id'),91000,true)");
  actor = { userId:710,username:'composed-admin',role:'admin',expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion('synthetic-hash') };
  originalCommand = parseHrHistoryCommand({ requestId:'composed-durable-request-0001',expectedUsername:actor.username,expectedRevision:0,reason:'Synthetic approved employment dates',supersedeIds:[],append:[{id:'active-1',kind:'known',from:'2020-01-01',to:null,value:{status:'active'}}] },'employment',810);
  originalReceipt = await recordHrHistory(db.getPool(),hrTemporalAuthority(actor),originalCommand);
  await recordHrHistory(db.getPool(),hrTemporalAuthority(actor),parseHrHistoryCommand({requestId:'composed-durable-request-0002',expectedUsername:actor.username,expectedRevision:1,reason:'Synthetic reviewed correction',supersedeIds:['active-1'],append:[{id:'active-2',kind:'known',from:'2020-02-01',to:null,value:{status:'active'}}]},'employment',810));
  // Deliberately make physical order disagree with revision order, without bypassing a constraint/trigger.
  await fixture.source.query('CREATE INDEX synthetic_revision_reverse ON hr_effective_revisions(stream_id,revision DESC); CLUSTER hr_effective_revisions USING synthetic_revision_reverse; DROP INDEX synthetic_revision_reverse');
  expect((await fixture.source.query('SELECT revision FROM hr_effective_revisions')).rows.map(r=>r.revision)).toEqual([2,1]);
  const client = await fixture.source.connect();
  try {
    sql=''; for await (const line of db.backupSqlLines(client)) sql+=line;
    const blocks:Uint8Array[]=[];
    for await (const block of fullBackupBlocks({source:client,readDocument:async()=>{throw new Error('No synthetic documents expected');}})) blocks.push(block);
    archive=gzipSync(Buffer.concat(blocks));
  } finally {client.release();}
  await writeFile(join(directory,'synthetic-full-backup.tar.gz'),archive);
  await writeFile(join(directory, 'synthetic-backup.sql'), sql);
});
afterAll(async () => {
  try {await db?.resetPoolForTesting();} finally {
    process.env.DATABASE_URL=originalUrl; process.env.SKIP_SEED=originalSeed;
    await fixture?.close(); if(directory) await rm(directory,{recursive:true,force:true});
  }
});

it('SQL backup restores every application table, explicit identities, revision order and exact durable receipt replay',async()=>{
  process.env.DATABASE_URL=fixture.sqlTarget.options.connectionString!;
  await db.resetPoolForTesting();await db.ensureSchema();
  // Exercise the supported SQL restore CLI against a runtime-owned target registry.
  const restored = await promisify(execFile)(process.execPath, ['scripts/restore.mjs', join(directory, 'synthetic-backup.sql')], { env: { ...process.env } });
  expect(restored.stdout).toContain('تمت الاستعادة');
  expect((await fixture.sqlTarget.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version)).toEqual(['0051', '0052', '0056', '0057', '0058', '0063', '0064', '0065', '0066', '0067', '0068', '0069', '0074', '0078', '0079', '0080', '0081', '0082']);
  expect(await rows(fixture.sqlTarget)).toEqual(await rows(fixture.source));
  expect(await recordHrHistory(db.getPool(),hrTemporalAuthority(actor),originalCommand)).toEqual(originalReceipt);
  expect((await fixture.sqlTarget.query('SELECT count(*)::int AS n FROM hr_effective_revisions')).rows[0].n).toBe(2);
  const next=await fixture.sqlTarget.query("INSERT INTO hr_effective_streams(kind,subject_key) VALUES('policy','proration') RETURNING id");
  expect(Number(next.rows[0].id)).toBeGreaterThan(91001);
  await expect(fixture.sqlTarget.query('UPDATE hr_temporal_write_receipts SET response=response')).rejects.toMatchObject({code:'23514'});
  await expect(fixture.sqlTarget.query('TRUNCATE hr_effective_streams CASCADE')).rejects.toMatchObject({code:'23514'});
});

it('actual full archive restore owns its schema and preserves original immutable receipt after later revisions',async()=>{
  const result=await stagedRestore({archivePath:join(directory,'synthetic-full-backup.tar.gz'),targetUrl:fixture.archiveTarget.options.connectionString!,stagingDir:join(directory,'restored-documents')});
  expect(result.errors).toEqual([]);expect(result.validationErrors).toEqual([]);expect(result.ok).toBe(true);
  expect(await rows(fixture.archiveTarget)).toEqual(await rows(fixture.source));
  expect(await recordHrHistory(fixture.archiveTarget,hrTemporalAuthority(actor),originalCommand)).toEqual(originalReceipt);
});

it('reset explicitly classifies all immutable HR history and receipt tables as retained',()=>{
  for(const table of ['hr_staff','hr_contracts','hr_effective_streams','hr_effective_revisions','hr_temporal_write_receipts']) expect(RESET_KEEP_TABLES).toContain(table);
});

it('patient-free reset backs up HR history under the freeze, retains it byte for byte, and leaves original receipt replay valid', async () => {
  process.env.DATABASE_URL = fixture.sqlTarget.options.connectionString!;
  await db.resetPoolForTesting();
  const retained = ['users', 'hr_staff', 'hr_contracts', 'hr_effective_streams', 'hr_effective_revisions', 'hr_temporal_write_receipts'];
  const before = await rows(fixture.sqlTarget);
  expect(before.patients).toEqual([]); // Issued patient identities are now protected from reset.
  let snapshot = '';
  const result = await db.resetClinicData({ actor: actor.username, actorRole: actor.role }, async (client) => {
    for await (const line of db.backupSqlLines(client)) snapshot += line;
    return { ok: true, backupId: 'synthetic-local-reset-backup' };
  });
  expect(result).toMatchObject({ ok: true, backupId: 'synthetic-local-reset-backup', counts: { patients: 0 } });
  expect(snapshot).toContain('composed-durable-request-0001');
  const after = await rows(fixture.sqlTarget);
  for (const table of retained) expect(after[table], table).toEqual(before[table]);
  expect(after.patients).toEqual([]);
  expect(await recordHrHistory(db.getPool(), hrTemporalAuthority(actor), originalCommand)).toEqual(originalReceipt);
  await expect(fixture.sqlTarget.query('DELETE FROM hr_temporal_write_receipts')).rejects.toMatchObject({ code: '23514' });
  expect((await fixture.sqlTarget.query('SHOW session_replication_role')).rows[0].session_replication_role).toBe('origin');
});
