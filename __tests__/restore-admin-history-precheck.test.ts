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

const target = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }));
vi.mock('pg', () => ({ Client: class { connect = target.connect; query = target.query; end = target.end; } }));
import { backupStateDir } from '../lib/backupVolume';
import { upsertBackupHistoryRecord } from '../lib/backupHistory';
import { runAdminRestoreDrill } from '../lib/restore/admin';
import * as staging from '../lib/restore/staging';
import { readTarGzSnapshot } from '../lib/restore/archive';

const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const id = 'production-backup-20261117-010203-001-abcde123-abcdef12.tar.gz';
const environment = { DATABASE_URL:'postgres://source:synthetic@source.invalid:5432/clinic',
  RESTORE_DRILL_DATABASE_URL:'postgres://target:synthetic@target.invalid:5432/dedicated_test',
  RESTORE_DRILL_DATABASE_ENVIRONMENT:'test', RESTORE_DRILL_DEDICATED_TARGET:'true' };

beforeEach(() => { vi.clearAllMocks(); target.connect.mockRejectedValue(new Error('unexpected target connection')); target.end.mockResolvedValue(undefined); });
afterEach(() => { vi.restoreAllMocks(); });

describe('administrative restore validation precedes target changes', () => {
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
  it('restores the same verified snapshot even if the archive path changes before target reset', async () => {
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
    const snapshot = restore.mock.calls[0][0].archiveSnapshot;
    expect(Buffer.from(snapshot!.entries.get('database.sql')!.data)).toEqual(sql);
    expect(await readFile(archivePath,'utf8')).toBe('replacement synthetic bytes');
  });
});
