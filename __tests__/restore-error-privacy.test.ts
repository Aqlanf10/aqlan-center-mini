import { DatabaseError } from 'pg';
import { createHash } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { restoreDiagnostic, restorePreflightDiagnostic } from '../lib/restore/error-diagnostic.mjs';
import { stagedRestore } from '../lib/restore/staging';
import { parseManifest } from '../lib/restore/validate';

const state = vi.hoisted(() => ({ fail: '', photoProblem: '', calls: [] as string[], write: vi.fn(), end: vi.fn(), documents: [] as {relativePath:string;bytes:Buffer;sha256:string}[] }));
const secret = 'SYNTHETIC_SECRET_VALUE';
const fault = () => Object.assign(new DatabaseError(`invalid input ${secret}`, 1, "error"), { code:'22P02', detail:secret, hint:secret, query:`SELECT '${secret}'`, stack:secret });
vi.mock('node:fs/promises', () => ({ mkdir:vi.fn(), writeFile:state.write, readFile:vi.fn(async () => Buffer.from('SYNTHETIC FIRST DOCUMENT')), rm:vi.fn() }));
vi.mock('pg', async () => ({ DatabaseError: (await vi.importActual<typeof import('pg')>('pg')).DatabaseError, Client: class {
  async connect() { if (state.fail === 'connect') throw fault(); }
  async end() { state.end(); }
  async query(sql:string) { state.calls.push(sql); if (state.fail === 'replay' && sql === 'SELECT 1;') throw fault();
    if (state.fail === 'unique' && sql === 'SELECT 1;') throw Object.assign(fault(), {code:'23505'});
    if (sql.includes("to_regclass('public.staff_authority_identity')")) return {rows:[{identity:false,epochs:false,subjects:false}]};
    if (sql.includes('information_schema.tables')) return {rows:[{tables:0}]}; return {rows:[]}; }
} }));
vi.mock('../lib/migrations', () => ({ loadMigrationFiles: async () => [], migrate: async () => {
  if (state.fail === 'migration') throw fault(); return {appliedVersions:[]}; },
  migrationStatus: async () => ({probe:{ok:true,missing:[]},consistent:true}) }));
vi.mock('../lib/restore/login-photo', () => ({loginPhotoRestoreProblem:() => state.photoProblem || null}));
vi.mock('../lib/restore/client-config', () => ({restoreClientConfigFor:() => ({})}));
vi.mock('../lib/restore/archive', () => ({readTarGzEntries:async () => {if (state.fail === 'archive') throw new Error(secret); return {};}}));
vi.mock('../lib/restore/validate', async importOriginal => ({...(await importOriginal<typeof import('../lib/restore/validate')>()),
  validateBackupArchive:() => ({ok:true,manifest:{},sql:Buffer.from('SELECT 1;'),documents:state.documents})}));
vi.mock('../lib/restore/sql.mjs', () => ({prepareBackupSql:() => ({dataSql:'SELECT 1;',skippedMigrationRecordLines:0,sqlRowsStatementLines:1,...(state.fail === 'history' ? {historical0079:{appliedAt:'2026-01-01T00:00:00Z'}} : {})})}));
vi.mock('../lib/files', () => ({putFile:vi.fn(),readFileByKey:vi.fn()}));
const options = {archivePath:'synthetic.tar.gz',targetUrl:'postgres://synthetic@localhost/synthetic',stagingDir:'/synthetic/staging'};
beforeEach(() => {state.fail='';state.photoProblem='';state.calls.length=0;state.documents=[];vi.clearAllMocks();state.write.mockReset();});
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

it('keeps archive and duplicate-key diagnostics without exposing database values', async () => {
  state.fail='archive'; const archive=await stagedRestore(options);
  expect(archive.ok).toBe(false); expect(archive.errors.join()).toContain('تعذّرت قراءة الأرشيف؛ قد يكون تالفًا أو مبترًا');
  expect(state.calls).toEqual([]); expect(JSON.stringify(archive)).not.toContain(secret);
  state.fail='unique'; const collision=await stagedRestore(options);
  expect(collision.ok).toBe(false); expect(collision.errors.join()).toMatch(/مفتاح|اصطدام/);
  expect(collision.errors.join()).toContain('SQLSTATE 23505'); expect(JSON.stringify(collision)).not.toContain(secret);
  expect(state.calls).toContain('ROLLBACK'); expect(state.calls).not.toContain('COMMIT');
});
it('throws a safe document-write error after the first document while retaining the partial target', async () => {
  const bytes=Buffer.from('SYNTHETIC FIRST DOCUMENT'); const sha256=createHash('sha256').update(bytes).digest('hex');
  state.documents=[{relativePath:'first',bytes,sha256},{relativePath:'second',bytes,sha256}];
  state.write.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error(secret));
  const failure = await stagedRestore(options).then(() => null, error => error);
  expect(failure).toBeInstanceOf(Error); expect(failure.message).toBe('RESTORE_DOCUMENTS_FAILED');
  expect(failure.message).not.toContain(secret);
  expect(state.write).toHaveBeenCalledTimes(2); expect(state.write.mock.calls[0][1]).toEqual(bytes);
  expect(state.calls).toContain('COMMIT'); expect(state.calls).not.toContain('ROLLBACK');
  expect(state.end).toHaveBeenCalledOnce();
});

it('retains the fixed historical registry diagnostic and rolls back', async () => {
  state.fail='history'; const result=await stagedRestore(options);
  expect(result.ok).toBe(false); expect(result.errors).toContain('historical_0079_registry_mismatch');
  expect(state.calls).toContain('ROLLBACK'); expect(state.calls).not.toContain('COMMIT');
  expect(state.write).not.toHaveBeenCalled();
});

it('preserves only the reviewed photo diagnostics and rolls back', async () => {
  const allowed=[
    'بيانات صورة الدخول المستعادة غير صالحة؛ الاستعادة مرفوضة.',
    'صورة الدخول المحددة غير موجودة مرة واحدة في الأرشيف؛ الاستعادة مرفوضة.',
    'صورة الدخول لا تطابق بياناتها المستعادة أو مفتاح الأرشيف؛ الاستعادة مرفوضة.',
    'محتوى صورة الدخول أو أبعادها لا يطابق البيانات المستعادة؛ الاستعادة مرفوضة.',
  ];
  for (const problem of [...allowed, `synthetic future diagnostic ${secret}`]) {
    state.calls.length=0; state.photoProblem=problem;
    const result=await stagedRestore(options); expect(result.ok).toBe(false);
    expect(result.errors).toEqual([allowed.includes(problem) ? problem : 'فشل التحقق من صورة الدخول المستعادة.']);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(state.calls).toContain('ROLLBACK'); expect(state.calls).not.toContain('COMMIT');
    expect(state.write).not.toHaveBeenCalled();
  }
});
