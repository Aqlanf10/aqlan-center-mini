import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { tarGzBytes } from './helpers/backup-tar';

const target = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn(), end: vi.fn() }));
vi.mock('pg', async () => ({ DatabaseError: (await vi.importActual<typeof import('pg')>('pg')).DatabaseError, Client: class { connect = target.connect; query = target.query; end = target.end; } }));
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
