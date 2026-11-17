import { DatabaseError } from 'pg-protocol';
import { beforeEach, expect, it, vi } from 'vitest';
import { restoreDiagnostic, restorePreflightDiagnostic } from '../lib/restore/error-diagnostic.mjs';
import { stagedRestore } from '../lib/restore/staging';
import { parseManifest } from '../lib/restore/validate';

const state = vi.hoisted(() => ({ fail: '', calls: [] as string[], write: vi.fn(), end: vi.fn() }));
const secret = 'SYNTHETIC_SECRET_VALUE';
const fault = () => Object.assign(new DatabaseError(`invalid input ${secret}`, 1, "error"), { code:'22P02', detail:secret, hint:secret, query:`SELECT '${secret}'`, stack:secret });
vi.mock('node:fs/promises', () => ({ mkdir:vi.fn(), writeFile:state.write, readFile:vi.fn(), rm:vi.fn() }));
vi.mock('pg', () => ({ Client: class {
  async connect() { if (state.fail === 'connect') throw fault(); }
  async end() { state.end(); }
  async query(sql:string) { state.calls.push(sql); if (state.fail === 'replay' && sql === 'SELECT 1;') throw fault();
    if (sql.includes('information_schema.tables')) return {rows:[{tables:0}]}; return {rows:[]}; }
} }));
vi.mock('../lib/migrations', () => ({ loadMigrationFiles: async () => [], migrate: async () => {
  if (state.fail === 'migration') throw fault(); return {appliedVersions:[]}; },
  migrationStatus: async () => ({probe:{ok:true,missing:[]},consistent:true}) }));
vi.mock('../lib/restore/client-config', () => ({restoreClientConfigFor:() => ({})}));
vi.mock('../lib/restore/archive', () => ({readTarGzEntries:async () => ({})}));
vi.mock('../lib/restore/validate', async importOriginal => ({...(await importOriginal<typeof import('../lib/restore/validate')>()),
  validateBackupArchive:() => ({ok:true,manifest:{},sql:Buffer.from('SELECT 1;'),documents:[]})}));
vi.mock('../lib/restore/sql.mjs', () => ({prepareBackupSql:() => ({dataSql:'SELECT 1;',skippedMigrationRecordLines:0,sqlRowsStatementLines:1})}));
vi.mock('../lib/files', () => ({putFile:vi.fn(),readFileByKey:vi.fn()}));
const options = {archivePath:'synthetic.tar.gz',targetUrl:'postgres://synthetic@localhost/synthetic',stagingDir:'/synthetic/staging'};
beforeEach(() => {state.fail='';state.calls.length=0;vi.clearAllMocks();});
it.each(['connect','migration','replay'])('returns safe diagnostics for %s failure', async phase => {
  state.fail=phase; const result=await stagedRestore(options); const output=JSON.stringify(result);
  expect(result.ok).toBe(false); expect(output).toContain(`RESTORE_${phase.toUpperCase()}_FAILED`);
  expect(output).toContain('SQLSTATE 22P02'); expect(output).not.toContain(secret);
  expect(output).not.toContain("SELECT '"); expect(state.end).toHaveBeenCalledOnce();
  if(phase==='replay') { expect(state.calls).toContain('ROLLBACK'); expect(state.calls).not.toContain('COMMIT'); expect(state.write).not.toHaveBeenCalled(); }
});
it('does not interpolate unknown phases, unbounded codes or arbitrary messages', () => {
  expect(restoreDiagnostic(secret, {code:secret,message:secret})).toBe('RESTORE_UNKNOWN_FAILED');
  expect(restoreDiagnostic('replay', new Error(secret))).toBe('RESTORE_REPLAY_FAILED');
  expect(restoreDiagnostic('replay', {code:'22P02'})).toBe('RESTORE_REPLAY_FAILED');
  expect(restorePreflightDiagnostic(new Error(secret))).toBe('RESTORE_PREFLIGHT_FAILED');
  expect(restorePreflightDiagnostic(new Error('Invalid historical 0079 registry record'))).toBe('Invalid historical 0079 registry record');
});
it('does not echo untrusted manifest fields', () => {
  const value=parseManifest({format:secret, version:secret, documents:[]});
  expect(JSON.stringify(value)).not.toContain(secret);
  const duplicate=parseManifest({format:'aqlan-full-backup',version:1,createdAt:'2026-01-01',databaseSha256:'a'.repeat(64),documents:[{storageKey:secret,sha256:'a'.repeat(64),sizeBytes:1},{storageKey:secret,sha256:'a'.repeat(64),sizeBytes:1}]});
  expect(JSON.stringify(duplicate)).not.toContain(secret);
});
