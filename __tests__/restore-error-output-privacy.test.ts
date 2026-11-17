import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseError } from 'pg-protocol';
import { restoreDiagnostic } from '../lib/restore/error-diagnostic.mjs';

const marker = 'SYNTHETIC_PRIVATE_MARKER';
const synthetic = Buffer.from('SYNTHETIC ENCRYPTED ARCHIVE');
const hash = createHash('sha256').update(synthetic).digest('hex');
vi.mock('node:fs/promises', () => ({
  mkdtemp:async () => '/synthetic/drill-temp', readdir:async () => [],
  realpath:async (p:string) => p, rm:async () => {}, writeFile:async () => {},
}));
vi.mock('../lib/backupEncryption', () => ({
  decryptArchiveBuffer:() => synthetic, encryptionKeyFingerprint:() => 'synthetic-fingerprint',
}));
vi.mock('../lib/restore/staging', () => ({stagedRestore:async () => {
  const error=Object.assign(new DatabaseError(`invalid ${marker}`,1,'error'),{code:'22P02',detail:marker,hint:marker,query:marker,stack:marker});
  return {ok:false,errors:[restoreDiagnostic('replay',error)],validationErrors:[],documentsRestored:0,documentsVerified:0,
    verification:{tablesCount:0,criticalProbeOk:false,migrationConsistent:false}};
}}));
import { drillReportText, runOffsiteRestoreDrill } from '../lib/backup-offsite-drill';

describe('restore diagnostic consumers', () => {
  it('does not print a synthetic PostgreSQL error from the raw CLI', () => {
    const dir=mkdtempSync(path.join(tmpdir(),'synthetic-cli-output-'));
    try {
      const file=path.join(dir,'synthetic.sql');
      writeFileSync(file,"BEGIN;\nINSERT INTO synthetic_rows (\"value\") VALUES ('SYNTHETIC');\nCOMMIT;\n");
      // The preload replaces the pg methods before restore.mjs executes. No socket is opened.
      const preload = `import {createRequire} from 'node:module'; const require=createRequire(process.cwd()+'/package.json'); const pg=require('pg'); pg.Client.prototype.connect=async function(){}; pg.Client.prototype.end=async function(){}; pg.Client.prototype.query=async function(sql){if(sql.includes('INSERT INTO synthetic_rows')){const e=new pg.DatabaseError('invalid ${marker}',1,'error'); e.code='22P02'; e.detail='${marker}'; e.hint='${marker}'; e.stack='${marker}'; throw e;} return {rows:[]};};`;
      const preloadUrl='data:text/javascript;base64,'+Buffer.from(preload).toString('base64');
      const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',DATABASE_ENVIRONMENT:'test',DATABASE_URL:`postgresql://synthetic:synthetic@127.0.0.1:1/aqlan_backup_precision_${'a'.repeat(32)}?sslmode=disable`};
      delete env.TEST_DATABASE_URL;
      const result=spawnSync(process.execPath,['--import',preloadUrl,'scripts/restore.mjs',file],{env,encoding:'utf8'});
      expect(result.status).toBe(1); expect(result.stderr).toContain('RESTORE_REPLAY_FAILED');
      expect(result.stderr).toContain('SQLSTATE 22P02'); expect(result.stderr).not.toContain(marker);
      expect(result.stderr).not.toContain('INSERT INTO synthetic_rows');
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('keeps safe diagnostics in both offsite report output forms', async () => {
    const client={headObject:async () => ({metadata:{'encrypted-sha256':hash,'archive-sha256':hash,'key-fingerprint':'synthetic-fingerprint'}}),getObject:async () => synthetic};
    const report=await runOffsiteRestoreDrill({client:client as never,keyHex:'a'.repeat(64),targetUrl:'postgres://synthetic',stagingDir:'/synthetic/stage',witness:'synthetic',operator:'synthetic',objectKey:'synthetic.enc',env:{}});
    expect(report.ok).toBe(false);
    for (const output of [JSON.stringify(report),drillReportText(report)]) {
      expect(output).toContain('RESTORE_REPLAY_FAILED'); expect(output).toContain('SQLSTATE 22P02');
      expect(output).not.toContain(marker); expect(output).not.toContain('INSERT INTO');
    }
  });
});
