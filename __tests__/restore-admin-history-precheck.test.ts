import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tarGzBytes } from './helpers/backup-tar';
import { gunzipSync } from 'node:zlib';
import { loadMigrationFiles } from '../lib/migration-files';
import { parseTarBytes } from '../lib/restore/archive';
import { validateBackupArchive } from '../lib/restore/validate';
import { prepareBackupSql } from '../lib/restore/sql.mjs';

const target = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn(), constructed: vi.fn() }));
vi.mock('pg', () => ({ Client: class { constructor(config:unknown) { target.constructed(config); } connect = target.connect; query = target.query; end = target.end; } }));
import { backupStateDir } from '../lib/backupVolume';
import { upsertBackupHistoryRecord } from '../lib/backupHistory';
import { runAdminRestoreDrill } from '../lib/restore/admin';
import * as staging from '../lib/restore/staging';
import { readTarGzSnapshot } from '../lib/restore/archive';
import * as catalog from '../lib/restore/migration-catalog';
import { AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID, AQLAN_CENTER_MINI_DATABASE_NAME } from '../lib/database-scope';

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const id = 'production-backup-20261117-010203-001-abcde123-abcdef12.tar.gz';
const environment = { DATABASE_URL:'postgres://source:synthetic@source.invalid:5432/clinic',
  RESTORE_DRILL_DATABASE_URL:'postgres://target:synthetic@target.invalid:5432/dedicated_test',
  RESTORE_DRILL_DATABASE_ENVIRONMENT:'test', RESTORE_DRILL_DEDICATED_TARGET:'true' };

beforeEach(() => { vi.stubEnv('PGSSL_ROOT_CERT_PEM', '-----BEGIN CERTIFICATE-----\nSYNTHETIC-NO-NETWORK-CA\n-----END CERTIFICATE-----'); vi.clearAllMocks(); target.connect.mockRejectedValue(new Error('unexpected target connection')); target.end.mockResolvedValue(undefined); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('administrative restore validation precedes target changes', () => {
  it.each(['wrong-name','invalid-time','missing-fields'])('rejects inconsistent baseline metadata (%s) before reset', async kind => {
    const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-baseline-registry-'));
    try {
      const backups=path.join(directory,'backups'), stage=path.join(backupStateDir(backups),'restore-drill-current');
      await mkdir(stage,{recursive:true}); await writeFile(path.join(stage,'prior.txt'),'SYNTHETIC PRIOR STAGE');
      const baseline=(await loadMigrationFiles()).find(file=>file.version==='0001')!;
      const record=kind==='missing-fields'
        ? `INSERT INTO schema_migrations ("version", "checksum") VALUES ('0001', '${baseline.checksum}');`
        : `INSERT INTO schema_migrations ("version", "name", "checksum", "applied_at", "adopted") VALUES ('0001', '${kind==='wrong-name' ? 'incorrect_baseline' : baseline.name}', '${baseline.checksum}', '${kind==='invalid-time' ? '2026-99-99T77:99:99Z' : '2026-01-01T00:00:00Z'}', TRUE);`;
      const sql=Buffer.from(`BEGIN;\n${record}\nCOMMIT;\n`);
      const manifest={format:'aqlan-full-backup',version:1,createdAt:'2026-01-01T00:00:00.000Z',databaseSha256:hash(sql),documents:[]};
      const archive=tarGzBytes([{name:'database.sql',data:sql},{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest))}]);
      expect(validateBackupArchive(parseTarBytes(gunzipSync(archive)),{documentsDir:stage}).ok).toBe(true);
      expect(() => prepareBackupSql(sql.toString('utf8'),{inspectHistorical0079:true,migrationFiles:[baseline]})).toThrow();
      await writeFile(path.join(backups,id),archive);
      await upsertBackupHistoryRecord(backups,{backupId:id,createdAt:'2026-01-01T00:00:00.000Z',triggerType:'manual',archiveSha256:hash(archive),archiveBytes:archive.length,databaseSha256:hash(sql),documentCount:0,status:'verified',replicationStatus:'none',destinations:[]});
      expect(await runAdminRestoreDrill({backupDir:backups,backupId:id,actor:'synthetic',env:environment})).toEqual({ok:false,reason:'archive-integrity-mismatch'});
      expect(target.connect).not.toHaveBeenCalled(); expect(target.query).not.toHaveBeenCalled();
      expect(await readFile(path.join(stage,'prior.txt'),'utf8')).toBe('SYNTHETIC PRIOR STAGE');
      expect(await readFile(path.join(backups,id))).toEqual(archive);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it('rejects an impossible 0079 timestamp before reset while preserving the prior synthetic stage', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-invalid-0079-time-'));
    try {
      const backups=path.join(directory,'backups'), stage=path.join(backupStateDir(backups),'restore-drill-current');
      await mkdir(stage,{recursive:true}); await writeFile(path.join(stage,'prior.txt'),'SYNTHETIC PRIOR STAGE');
      const badTime='2026-99-99T77:99:99Z';
      const checksum='5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99';
      const record=`INSERT INTO schema_migrations ("version", "name", "checksum", "applied_at", "adopted") VALUES ('0079', 'ortho_followup_coverage', '${checksum}', '${badTime}', FALSE);`;
      const sql=Buffer.from(`BEGIN;\n${record}\nCOMMIT;\n`);
      const manifest={format:'aqlan-full-backup',version:1,createdAt:'2026-01-01T00:00:00.000Z',databaseSha256:hash(sql),documents:[]};
      const archive=tarGzBytes([{name:'database.sql',data:sql},{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest))}]);
      expect(validateBackupArchive(parseTarBytes(gunzipSync(archive)),{documentsDir:stage}).ok).toBe(true);
      const catalog=await loadMigrationFiles();
      try { prepareBackupSql(sql.toString('utf8'),{inspectHistorical0079:true,migrationFiles:catalog}); throw new Error('unexpected acceptance'); }
      catch(error) { expect((error as Error).message).toBe('Invalid historical 0079 registry record'); expect((error as Error).message).not.toContain(badTime); }
      await writeFile(path.join(backups,id),archive);
      await upsertBackupHistoryRecord(backups,{backupId:id,createdAt:'2026-01-01T00:00:00.000Z',triggerType:'manual',archiveSha256:hash(archive),archiveBytes:archive.length,databaseSha256:hash(sql),documentCount:0,status:'verified',replicationStatus:'none',destinations:[]});
      expect(await runAdminRestoreDrill({backupDir:backups,backupId:id,actor:'synthetic',env:environment})).toEqual({ok:false,reason:'archive-integrity-mismatch'});
      expect(target.connect).not.toHaveBeenCalled(); expect(target.query).not.toHaveBeenCalled();
      expect(await readFile(path.join(stage,'prior.txt'),'utf8')).toBe('SYNTHETIC PRIOR STAGE');
      expect(await readFile(path.join(backups,id))).toEqual(archive);
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
  it.each([[[]], [[{version:'0090', name:'synthetic', filename:'0090_synthetic.sql', sql:'synthetic', checksum:'a'.repeat(64)}]]])('refuses an untrusted migration catalogue before opening the staged target', async supplied => {
    const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-empty-catalog-'));
    try {
      const stage = path.join(directory, 'stage'); await mkdir(stage);
      await writeFile(path.join(stage, 'prior.txt'), 'SYNTHETIC STAGE');
      const sql = Buffer.from('BEGIN;\nCOMMIT;\n');
      const manifest = { format:'aqlan-full-backup', version:1, createdAt:'2026-01-01T00:00:00.000Z', databaseSha256:hash(sql), documents:[] };
      const archive = tarGzBytes([{name:'database.sql',data:sql},{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest))}]);
      const file=path.join(directory, 'synthetic.tar.gz'); await writeFile(file, archive);
      const result=await staging.stagedRestore({archivePath:file,targetUrl:environment.RESTORE_DRILL_DATABASE_URL,stagingDir:stage,migrationFilesSnapshot:supplied});
      expect(result.ok).toBe(false);
      expect(result.errors.some(message => message.includes('Untrusted restore migration catalogue'))).toBe(true);
      expect(target.connect).not.toHaveBeenCalled(); expect(target.query).not.toHaveBeenCalled();
      expect(await readFile(path.join(stage, 'prior.txt'), 'utf8')).toBe('SYNTHETIC STAGE');
    } finally { await rm(directory, { recursive:true, force:true }); }
  });
  it.each([false, true])('refuses unknown 0090 with synthetic booking rows=%s before reset and preserves the archive and stage', async populated => {
    const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-admin-provenance-'));
    try {
      const backups = path.join(directory, 'backups'), stage = path.join(backupStateDir(backups), 'restore-drill-current');
      await mkdir(stage, { recursive: true });
      const sentinel = Buffer.from('SYNTHETIC PRIOR STAGE');
      await writeFile(path.join(stage, 'synthetic-document.txt'), sentinel);
      const registry = `INSERT INTO schema_migrations ("version", "name", "checksum", "applied_at", "adopted") VALUES ('0090', 'synthetic_unknown', '${'a'.repeat(64)}', '2026-01-01T00:00:00Z', FALSE);`;
      const booking = populated ? 'INSERT INTO booking_requests ("request_key") VALUES (\'SYNTHETIC\');\n' : '';
      const sql = Buffer.from(`BEGIN;\n${registry}\n${booking}COMMIT;\n`);
      const manifest = { format:'aqlan-full-backup', version:1, createdAt:'2026-01-01T00:00:00.000Z', databaseSha256:hash(sql), documents:[] };
      const archive = tarGzBytes([{name:'database.sql',data:sql},{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest))}]);
      expect(validateBackupArchive(parseTarBytes(gunzipSync(archive)), { documentsDir:stage }).ok).toBe(true);
      const catalog = await loadMigrationFiles();
      expect(() => prepareBackupSql(sql.toString('utf8'), { inspectHistorical0079:true, migrationFiles:catalog })).toThrow('Unknown archived migration version: 0090');
      await writeFile(path.join(backups,id), archive);
      await upsertBackupHistoryRecord(backups,{backupId:id,createdAt:'2026-01-01T00:00:00.000Z',triggerType:'manual',archiveSha256:hash(archive),archiveBytes:archive.length,databaseSha256:hash(sql),documentCount:0,status:'verified',replicationStatus:'none',destinations:[]});
      expect(await runAdminRestoreDrill({ backupDir:backups, backupId:id, actor:'synthetic', env:environment })).toEqual({ok:false,reason:'archive-integrity-mismatch'});
      const staged = await staging.stagedRestore({ archivePath:path.join(backups,id), targetUrl:environment.RESTORE_DRILL_DATABASE_URL, stagingDir:stage });
      expect(staged.ok).toBe(false);
      expect(staged.errors.some(message => message.includes('Unknown archived migration version: 0090'))).toBe(true);
      expect(target.connect).not.toHaveBeenCalled(); expect(target.query).not.toHaveBeenCalled();
      expect(await readFile(path.join(stage, 'synthetic-document.txt'))).toEqual(sentinel);
      expect(await readFile(path.join(backups,id))).toEqual(archive);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('refuses a hash-valid contradictory 0079 archive before target connection and preserves existing staged documents', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-admin-0079-'));
    const backups = path.join(directory, 'backups'), stage = path.join(backupStateDir(backups), 'restore-drill-current');
    await mkdir(stage, {recursive:true});
    await writeFile(path.join(stage, 'synthetic-previous-document.txt'), 'PRESERVE SYNTHETIC PRIOR STAGE');
    const sql = Buffer.from('BEGIN;\nINSERT INTO visits ("ortho_followup_coverage_proof") VALUES (NULL);\nCOMMIT;\n');
    const manifest = { format:'aqlan-full-backup', version:1, createdAt:'2026-01-01T00:00:00.000Z', databaseSha256:hash(sql), documents:[] };
    const archive = tarGzBytes([{name:'database.sql',data:sql},{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest))}]);
    await writeFile(path.join(backups,id), archive);
    await upsertBackupHistoryRecord(backups,{backupId:id,createdAt:'2026-01-01T00:00:00.000Z',triggerType:'manual',archiveSha256:hash(archive),archiveBytes:archive.length,databaseSha256:hash(sql),documentCount:0,status:'verified',replicationStatus:'none',destinations:[]});
    const result = await runAdminRestoreDrill({backupDir:backups,backupId:id,actor:'synthetic',env:environment});
    expect(result).toEqual({ok:false,reason:'archive-integrity-mismatch'});
    expect(target.connect).not.toHaveBeenCalled(); expect(target.query).not.toHaveBeenCalled();
    expect(await readFile(path.join(stage,'synthetic-previous-document.txt'),'utf8')).toBe('PRESERVE SYNTHETIC PRIOR STAGE');
  });
  it('rejects a FIFO without waiting and retains regular-file symlink support', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-admin-filetype-'));
    const fifo = path.join(directory, 'synthetic-pipe');
    execFileSync('mkfifo', [fifo]);
    await expect(readTarGzSnapshot(fifo)).rejects.toThrow('Invalid archive file');
    const sql = Buffer.from('BEGIN;\nCOMMIT;\n');
    const archive = tarGzBytes([{name:'database.sql',data:sql}]);
    const file = path.join(directory,'archive.gz'), link = path.join(directory,'archive-link.gz');
    await writeFile(file,archive); await symlink(file,link);
    const snapshot = await readTarGzSnapshot(link);
    expect(snapshot.sha256).toBe(hash(archive)); expect(snapshot.bytes).toBe(archive.length);
    expect(Buffer.from(snapshot.archive.entries.get('database.sql')!.data)).toEqual(sql);
  });
  it.each([false,true])('restores the same verified snapshot with project scope=%s even if the archive path changes before target reset', async scoped => {
    if (scoped) vi.stubEnv('RAILWAY_PROJECT_ID', AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID);
    const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-admin-snapshot-'));
    const backups = path.join(directory, 'backups'); await mkdir(backupStateDir(backups), {recursive:true});
    const sql = Buffer.from('BEGIN;\nCOMMIT;\n');
    const manifest = { format:'aqlan-full-backup', version:1, createdAt:'2026-01-01T00:00:00.000Z', databaseSha256:hash(sql), documents:[] };
    const archive = tarGzBytes([{name:'database.sql',data:sql},{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest))}]);
    const archivePath = path.join(backups,id); await writeFile(archivePath, archive);
    await upsertBackupHistoryRecord(backups,{backupId:id,createdAt:'2026-01-01T00:00:00.000Z',triggerType:'manual',archiveSha256:hash(archive),archiveBytes:archive.length,databaseSha256:hash(sql),documentCount:0,status:'verified',replicationStatus:'none',destinations:[]});
    target.connect.mockImplementation(async () => { await writeFile(archivePath, 'replacement synthetic bytes'); });
    target.query.mockResolvedValue({rows:[]});
    const restore = vi.spyOn(staging, 'stagedRestore').mockResolvedValue({ok:true,readyForCutover:true,documentsVerified:0,verification:{tablesCount:1}} as never);
    const result = await runAdminRestoreDrill({backupDir:backups,backupId:id,actor:'synthetic',env:environment});
    expect(result).toMatchObject({ok:true,readyForCutover:true});
    expect(restore).toHaveBeenCalledOnce();
    const call = restore.mock.calls[0][0];
    const snapshot = call.archiveSnapshot;
    expect(Buffer.from(snapshot!.entries.get('database.sql')!.data)).toEqual(sql);
    expect(target.constructed).toHaveBeenCalledOnce();
    expect(target.query).toHaveBeenCalledWith('DROP SCHEMA IF EXISTS public CASCADE');
    expect(call.targetSnapshot?.config).toBe(target.constructed.mock.calls[0][0]);
    expect(call.targetUrl).toBe(call.targetSnapshot?.targetUrl);
    expect(await readFile(archivePath,'utf8')).toBe('replacement synthetic bytes');
  });
});


describe('administrative effective target identity guard', () => {
  const valid = { DATABASE_URL:'postgresql://prod:synthetic@prod.invalid:5432/clinic',
    RESTORE_DRILL_DATABASE_URL:'postgresql://restore:synthetic@restore.invalid:5432/restore_drill',
    RESTORE_DRILL_DATABASE_ENVIRONMENT:'test', RESTORE_DRILL_DEDICATED_TARGET:'true' };
  const unsafeTargets = [
    'postgresql://restore:synthetic@127.0.0.1:5432/restore_drill?host=prod.invalid',
    'postgresql://restore:synthetic@127.0.0.1:5432/restore_drill?%68ost=prod.invalid',
    'postgresql://restore:synthetic@127.0.0.1:5432/restore_drill?port=5555',
    'postgresql://restore:synthetic@127.0.0.1:5432/restore_drill?dbname=clinic',
    'postgresql://restore:synthetic@127.0.0.1:5432/restore_drill?sslmode=disable&sslmode=disable',
    'postgresql://restore:synthetic@restore.invalid:5432/restore_drill?sslrootcert=/synthetic/no-read',
    'postgresql://restore:synthetic@restore.invalid/restore_drill',
    'postgresql://restore:synthetic@restore.invalid:5432/',
    'postgresql://restore.invalid:5432/restore_drill',
    'postgresql://restore:synthetic@%2Ftmp:5432/restore_drill',
    'postgresql://restore%00:synthetic@restore.invalid:5432/restore_drill',
    'postgresql://restore:synthetic%0d%0a@restore.invalid:5432/restore_drill',
  ];
  async function checkRefusal(env:Record<string,string>, reason='unsafe-classification') {
    const directory=await mkdtemp(path.join(tmpdir(),'synthetic-target-guard-'));
    try {
      const stage=path.join(backupStateDir(directory),'restore-drill-current'); await mkdir(stage,{recursive:true});
      await writeFile(path.join(stage,'prior.txt'),'SYNTHETIC PRIOR');
      await writeFile(path.join(directory,id),'SYNTHETIC ARCHIVE');
      const result=await runAdminRestoreDrill({backupDir:directory,backupId:id,actor:'synthetic',env});
      expect(result).toEqual({ok:false,reason}); expect(target.constructed).not.toHaveBeenCalled();
      expect(target.connect).not.toHaveBeenCalled(); expect(target.query).not.toHaveBeenCalled();
      expect(await readFile(path.join(stage,'prior.txt'),'utf8')).toBe('SYNTHETIC PRIOR');
      expect(await readFile(path.join(directory,id),'utf8')).toBe('SYNTHETIC ARCHIVE');
    } finally {await rm(directory,{recursive:true,force:true});}
  }
  it.each(unsafeTargets)('refuses ambiguous target before stage removal or Client', async url => {
    await checkRefusal({...valid,RESTORE_DRILL_DATABASE_URL:url});
  });
  it.each(['DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING'])('rejects collision against %s even with a different user', async alias => {
    await checkRefusal({...valid,[alias]:'postgresql://different:synthetic@restore.invalid:5432/restore_drill'}, 'production-collision');
  });
  it.each(['DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','POSTGRES_URL_NON_POOLING'])('rejects the project-scoped database behind %s before Client or stage removal', async alias => {
    await checkRefusal({...valid,RAILWAY_PROJECT_ID:AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID,
      RESTORE_DRILL_DATABASE_URL:`postgresql://restore:synthetic@restore.invalid:5432/${AQLAN_CENTER_MINI_DATABASE_NAME}`,
      [alias]:'postgresql://different:synthetic@restore.invalid:5432/railway'}, 'production-collision');
  });
  it('rejects an unrelated Railway project before Client or stage removal', async () => {
    await checkRefusal({...valid,RAILWAY_PROJECT_ID:'synthetic-wrong-project'});
  });
  it('checks scoped provided aliases using the real process project identity', async () => {
    vi.stubEnv('RAILWAY_PROJECT_ID',AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID);
    await checkRefusal({...valid,POSTGRES_URL:'postgresql://different:synthetic@restore.invalid:5432/railway',
      RESTORE_DRILL_DATABASE_URL:`postgresql://restore:synthetic@restore.invalid:5432/${AQLAN_CENTER_MINI_DATABASE_NAME}`}, 'production-collision');
  });
  it.each(['PGHOST','PGHOSTADDR','PGPORT','PGDATABASE','PGUSER','PGPASSWORD','PGSERVICE','PGOPTIONS','PGSSLMODE','PGSSLROOTCERT','PGAPPNAME'])('rejects ambient %s before stage removal or Client', async key => {
    vi.stubEnv(key,'synthetic-ambient-override'); await checkRefusal(valid);
  });
  it('checks the real process aliases in addition to the provided environment', async () => {
    vi.stubEnv('POSTGRES_URL','postgresql://different:synthetic@restore.invalid:5432/restore_drill');
    await checkRefusal(valid, 'production-collision');
  });
  it('rejects ambiguous configured source aliases', async () => {
    await checkRefusal({...valid,POSTGRES_URL:'postgresql://prod:synthetic@elsewhere.invalid:5432/clinic?host=restore.invalid'});
  });
  it('treats literal loopback spellings as the same target', async () => {
    await checkRefusal({...valid,DATABASE_URL:'postgresql://prod:synthetic@localhost:5432/clinic',RESTORE_DRILL_DATABASE_URL:'postgresql://restore:synthetic@127.0.0.1:5432/clinic'}, 'production-collision');
  });
  it.each(['PGHOST','POSTGRES_URL','RAILWAY_PROJECT_ID'])('rechecks changed %s after archive reading before removing the prior stage', async key => {
    const directory=await mkdtemp(path.join(tmpdir(),'synthetic-guard-race-'));
    try {
      const backups=path.join(directory,'backups'), stage=path.join(backupStateDir(backups),'restore-drill-current');
      await mkdir(stage,{recursive:true}); await writeFile(path.join(stage,'prior.txt'),'SYNTHETIC PRIOR');
      const sql=Buffer.from('BEGIN;\nCOMMIT;\n');
      const manifest={format:'aqlan-full-backup',version:1,createdAt:'2026-01-01T00:00:00.000Z',databaseSha256:hash(sql),documents:[]};
      const archive=tarGzBytes([{name:'database.sql',data:sql},{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest))}]);
      await writeFile(path.join(backups,id),archive);
      await upsertBackupHistoryRecord(backups,{backupId:id,createdAt:'2026-01-01T00:00:00.000Z',triggerType:'manual',archiveSha256:hash(archive),archiveBytes:archive.length,databaseSha256:hash(sql),documentCount:0,status:'verified',replicationStatus:'none',destinations:[]});
      const actual=catalog.createRestoreMigrationSnapshot;
      const spy=vi.spyOn(catalog,'createRestoreMigrationSnapshot').mockImplementation(async () => {
        const snapshot=await actual();
        vi.stubEnv(key,key==='PGHOST' ? 'synthetic-override' : key==='POSTGRES_URL' ? 'postgresql://other:synthetic@restore.invalid:5432/restore_drill' : AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID);
        return snapshot;
      });
      const env=key==='RAILWAY_PROJECT_ID' ? {...valid,DATABASE_URL:'postgresql://source:synthetic@restore.invalid:5432/railway',
        RESTORE_DRILL_DATABASE_URL:`postgresql://restore:synthetic@restore.invalid:5432/${AQLAN_CENTER_MINI_DATABASE_NAME}`} : valid;
      expect(await runAdminRestoreDrill({backupDir:backups,backupId:id,actor:'synthetic',env})).toEqual({ok:false,reason:'unsafe-classification'});
      expect(spy).toHaveBeenCalledOnce(); expect(target.constructed).not.toHaveBeenCalled(); expect(target.query).not.toHaveBeenCalled();
      expect(await readFile(path.join(stage,'prior.txt'),'utf8')).toBe('SYNTHETIC PRIOR');
      expect(await readFile(path.join(backups,id))).toEqual(archive);
    } finally {await rm(directory,{recursive:true,force:true});}
  });
});

it.each(['override','alias','scoped','wrong-project'])('staged direct invocation rejects a target %s before constructing a client', async kind => {
  const directory=await mkdtemp(path.join(tmpdir(),'synthetic-staged-target-'));
  try {
    const sql=Buffer.from('BEGIN;\nCOMMIT;\n');
    const manifest={format:'aqlan-full-backup',version:1,createdAt:'2026-01-01T00:00:00.000Z',databaseSha256:hash(sql),documents:[]};
    const archive=tarGzBytes([{name:'database.sql',data:sql},{name:'manifest.json',data:Buffer.from(JSON.stringify(manifest))}]);
    const file=path.join(directory,'synthetic.tar.gz'), stage=path.join(directory,'stage');
    await writeFile(file,archive); await mkdir(stage); await writeFile(path.join(stage,'prior.txt'),'SYNTHETIC PRIOR');
    if (kind === 'alias') vi.stubEnv('POSTGRES_URL','postgresql://different:synthetic@localhost:5432/db');
    if (kind === 'scoped') {vi.stubEnv('POSTGRES_URL','postgresql://different:synthetic@localhost:5432/railway'); vi.stubEnv('RAILWAY_PROJECT_ID',AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID);}
    if (kind === 'wrong-project') vi.stubEnv('RAILWAY_PROJECT_ID','synthetic-wrong-project');
    const targetUrl=kind === 'override' ? 'postgresql://x:y@127.0.0.1:5432/db?host=remote.invalid' :
      kind === 'scoped' ? `postgresql://x:y@127.0.0.1:5432/${AQLAN_CENTER_MINI_DATABASE_NAME}` : 'postgresql://x:y@127.0.0.1:5432/db';
    const error=kind === 'override' ? 'RESTORE_TARGET_UNSAFE_QUERY' : kind === 'wrong-project' ? 'RESTORE_TARGET_SCOPE_INVALID' : 'RESTORE_TARGET_COLLISION';
    await expect(staging.stagedRestore({archivePath:file,targetUrl,stagingDir:stage})).rejects.toThrow(error);
    expect(target.constructed).not.toHaveBeenCalled(); expect(target.connect).not.toHaveBeenCalled();
    expect(await readFile(path.join(stage,'prior.txt'),'utf8')).toBe('SYNTHETIC PRIOR');
  } finally {await rm(directory,{recursive:true,force:true});}
});
