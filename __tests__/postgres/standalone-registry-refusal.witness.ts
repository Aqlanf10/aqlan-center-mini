import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Pool } from 'pg';
import { openRegistryHttpFixture } from './_registry-http-fixture';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { loadMigrationFiles, migrate } from '../../lib/migrations';
import { parseTarBytes } from '../../lib/restore/archive';
import { validateBackupArchive } from '../../lib/restore/validate';
import { backupStateDir } from '../../lib/backupVolume';
import { upsertBackupHistoryRecord } from '../../lib/backupHistory';
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from '../../lib/auth';
import { SESSION_COOKIE } from '../../lib/sessionCookie';
import { tarGzBytes } from '../helpers/backup-tar';
import { registryMutations } from '../helpers/standalone-registry-mutations.mjs';

const variants = ['control','wrong-name','wrong-checksum','adopted','invalid-time','0090-missing-fields'] as const;
type Variant = typeof variants[number];
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const prior = Buffer.from('synthetic-previous-stage');
let fixture: Awaited<ReturnType<typeof openRegistryHttpFixture>>;
let directory: string, actor: SessionPayload, server: ChildProcess | undefined;
let archives: Record<Variant, Buffer>, sourceRegistry: unknown;

async function stopServer() {
  const child = server;
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000);
      timer.unref(); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
    });
  }
  server = undefined;
}

beforeAll(async () => {
  vi.stubEnv('SESSION_SECRET','synthetic-registry-http-secret-at-least-32-characters');
  fixture = await openRegistryHttpFixture(process.env, variants.length);
  expect(new Set([fixture.source.identity.name,...fixture.targets.map(target => target.identity.name)]).size).toBe(variants.length + 1);
  directory = await mkdtemp(path.join(tmpdir(),'synthetic-registry-http-'));
  const source = fixture.source.pool, files = await loadMigrationFiles();
  expect(files.some(file => file.version === '0090')).toBe(false);
  await migrate(source, {apply:true, files, historical0079:true});
  await source.query("UPDATE schema_migrations SET applied_at='2025-03-04T05:06:07.123456Z' WHERE version='0079'");
  const user = (await source.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('synthetic-registry-admin','Synthetic registry admin','synthetic-hash','admin') RETURNING id")).rows[0].id;
  actor = {userId:user,username:'synthetic-registry-admin',role:'admin',expiresAt:Date.now()+3600000,credentialVersion:sessionCredentialVersion('synthetic-hash')};
  sourceRegistry = (await source.query("SELECT version,name,checksum,applied_at::text,adopted FROM schema_migrations ORDER BY version")).rows;
  const client = await source.connect(), blocks: Uint8Array[] = [];
  try { for await (const block of fullBackupBlocks({source:client,readDocument:async () => { throw new Error('Unexpected synthetic document'); }})) blocks.push(block); }
  finally { client.release(); }
  const control = gzipSync(Buffer.concat(blocks)), tar = parseTarBytes(gunzipSync(control));
  const originalSql = Buffer.from(tar.entries.get('database.sql')!.data).toString('utf8');
  const lines = originalSql.split('\n').filter(line => /^INSERT INTO schema_migrations /.test(line) && line.includes("'0079'"));
  expect(lines.length).toBe(1);
  const record = lines[0];
  expect(record).toContain("'ortho_followup_coverage'");
  expect(record).toContain("'5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99'");
  expect(record).toContain("'2025-03-04T05:06:07.123456");
  expect(record).toMatch(/, FALSE\);$/);
  const mutations = registryMutations(record);
  archives = {control} as Record<Variant,Buffer>;
  for (const kind of variants.slice(1) as Exclude<Variant,'control'>[]) {
    expect(mutations[kind] === record).toBe(false);
    const data = Buffer.from(originalSql.replace(record,mutations[kind]));
    const manifest = JSON.parse(Buffer.from(tar.entries.get('manifest.json')!.data).toString('utf8'));
    manifest.databaseSha256 = hash(data); manifest.databaseBytes = data.length;
    archives[kind] = tarGzBytes(tar.order.map(name => ({name,data:name === 'database.sql' ? data : name === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : tar.entries.get(name)!.data})));
  }
  for (const kind of variants) await writeFile(path.join(directory,`synthetic-${kind}.tar.gz`),archives[kind]);
},180000);

afterEach(stopServer);
afterAll(async () => {
  await stopServer(); await fixture?.close();
  if (directory) console.log(`SYNTHETIC_REGISTRY_EVIDENCE_DIRECTORY=${directory}`);
  vi.unstubAllEnvs();
});

async function snapshot(pool: Pool) {
  const identity = (await pool.query("SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows;
  const relations = (await pool.query("SELECT c.relname,c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' ORDER BY c.relname")).rows;
  const sentinel = (await pool.query('SELECT value FROM synthetic_registry_sentinel ORDER BY value')).rows;
  const sequence = (await pool.query('SELECT last_value::text,is_called FROM synthetic_registry_sequence')).rows;
  return {identity,relations,sentinel,sequence};
}

it.each(variants)('standalone HTTP preserves target and stage for %s registry case', async kind => {
  const target = fixture.targets[variants.indexOf(kind)], sourceUrl = fixture.source.pool.options.connectionString!, targetUrl = target.restoreUrl;
  for (const urlText of [sourceUrl,targetUrl]) {
    const url = new URL(urlText);
    if (url.hostname !== '127.0.0.1' || url.port !== '55472' || !/^\/aqlan_registry_http_[a-f0-9]{32}$/.test(url.pathname)) throw new Error('Synthetic owned loopback required');
  }
  expect(new URL(sourceUrl).pathname === new URL(targetUrl).pathname).toBe(false);
  const currentIdentity = (await target.pool.query("SELECT current_database() AS name, oid::text, datdba::text AS owner FROM pg_database WHERE datname=current_database()")).rows[0];
  expect(currentIdentity).toEqual(target.identity);
  if (kind !== 'control') {
    await target.pool.query('CREATE TABLE synthetic_registry_sentinel (value text NOT NULL)');
    await target.pool.query("INSERT INTO synthetic_registry_sentinel VALUES ('synthetic-must-remain')");
    await target.pool.query('CREATE SEQUENCE synthetic_registry_sequence START 7');
    await target.pool.query("SELECT setval('synthetic_registry_sequence',17,true)");
  }
  const before = kind === 'control' ? null : await snapshot(target.pool);
  const port = await new Promise<number>((resolve,reject) => {
    const socket=createServer(); socket.on('error',reject); socket.listen(0,'127.0.0.1',() => {
      const addr=socket.address(); if (!addr || typeof addr === 'string') return reject(new Error('No synthetic port'));
      socket.close(error => error ? reject(error) : resolve(addr.port));
    });
  });
  const base=`http://127.0.0.1:${port}`, volume=path.join(directory,`volume-${kind}`), backups=path.join(volume,'backups');
  const stage=path.join(backupStateDir(backups),'restore-drill-current');
  await mkdir(stage,{recursive:true}); await mkdir(path.join(volume,'documents'),{recursive:true});
  if (kind !== 'control') await writeFile(path.join(stage,'synthetic-prior-document.txt'),prior);
  const bytes=archives[kind], parsed=parseTarBytes(gunzipSync(bytes)), validation=validateBackupArchive(parsed,{documentsDir:stage});
  expect(validation.ok).toBe(true);
  if (!validation.ok) throw new Error('Synthetic archive failed structural validation');
  const id=`production-backup-20261117-010203-${String(110+variants.indexOf(kind))}-abcde123-abcdef12.tar.gz`;
  const archivePath=path.join(backups,id); await writeFile(archivePath,bytes);
  await upsertBackupHistoryRecord(backups,{backupId:id,createdAt:'2026-11-17T00:00:00.000Z',triggerType:'manual',archiveSha256:hash(bytes),archiveBytes:bytes.length,
    databaseSha256:validation.sqlSha256,documentCount:validation.documents.length,status:'verified',replicationStatus:'none',destinations:[]});
  await writeFile(path.join(directory,`evidence-${kind}-before.json`),JSON.stringify({identity:target.identity,archiveSha256:hash(bytes),before,stageSha256:kind === 'control' ? null : hash(prior)})+'\n');
  const entry=process.env.SYNTHETIC_STANDALONE_SERVER!;
  server=spawn(process.execPath,[entry],{cwd:directory,env:{PATH:process.env.PATH,SESSION_SECRET:process.env.SESSION_SECRET,CLINIC_TIME_ZONE:'Asia/Aden',
    NODE_ENV:'production',PORT:String(port),HOSTNAME:'127.0.0.1',APP_ORIGIN:base,DATABASE_URL:sourceUrl,TEST_DATABASE_URL:sourceUrl,
    DATABASE_ENVIRONMENT:'test',USE_LOCAL_DB:'false',SKIP_SEED:'true',CI:'false',RESTORE_DRILL_DATABASE_URL:targetUrl,
    RESTORE_DRILL_DATABASE_ENVIRONMENT:'test',RESTORE_DRILL_DEDICATED_TARGET:'true',RAILWAY_VOLUME_MOUNT_PATH:volume,DOCUMENTS_DIR:path.join(volume,'documents')},stdio:['ignore','ignore','ignore']});
  const deadline=Date.now()+60000;
  while (true) {
    if (server.exitCode !== null) throw new Error('Synthetic server exited');
    try { if ((await fetch(`${base}/api/ping`)).ok) break; } catch { /* starting */ }
    if (Date.now()>deadline) throw new Error('Synthetic server startup timed out');
    await new Promise(resolve => setTimeout(resolve,200));
  }
  const response=await fetch(`${base}/api/settings/backup/restore`,{method:'POST',headers:{cookie:`${SESSION_COOKIE}=${createSessionToken(actor)}`,Origin:base,'Sec-Fetch-Site':'same-origin','Content-Type':'application/json'},body:JSON.stringify({backupId:id,confirmation:id})});
  const body=await response.json().catch(()=>null) as {ok?:unknown;reason?:unknown;readyForCutover?:unknown}|null;
  if (kind === 'control') {
    expect(response.status).toBe(200); expect(body?.ok === true && body.readyForCutover === true).toBe(true);
    expect((await target.pool.query("SELECT version FROM schema_migrations WHERE version='0079'")).rows.length).toBe(1);
    await writeFile(path.join(directory,`evidence-${kind}-after.json`),JSON.stringify({status:response.status,controlOk:body?.ok === true && body.readyForCutover === true})+'\n');
  } else {
    expect.soft(response.status).toBe(500);
    expect.soft(body?.ok === false && body.reason === 'archive-integrity-mismatch').toBe(true);
    // Stop before reading the sentinel if reset removed it; keep a failing assertion.
    const exists=(await target.pool.query("SELECT to_regclass('public.synthetic_registry_sentinel') IS NOT NULL AS present")).rows[0].present;
    expect.soft(exists).toBe(true);
    const after = exists ? await snapshot(target.pool).catch(()=>null) : null;
    const stageBytes = await readFile(path.join(stage,'synthetic-prior-document.txt')).catch(()=>null);
    await writeFile(path.join(directory,`evidence-${kind}-after.json`),JSON.stringify({status:response.status,
      expectedRefusal:body?.ok === false && body.reason === 'archive-integrity-mismatch',after,
      stageSha256:stageBytes ? hash(stageBytes) : null})+'\n');
    expect.soft(after).toEqual(before);
    expect.soft(stageBytes?.equals(prior)).toBe(true);
  }
  expect(await readFile(archivePath)).toEqual(bytes);
  expect((await fixture.source.pool.query("SELECT version,name,checksum,applied_at::text,adopted FROM schema_migrations ORDER BY version")).rows).toEqual(sourceRegistry);
},300000);
