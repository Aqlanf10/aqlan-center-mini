import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {ORTHO_FOLLOWUP_COVERAGE_SQL} from '../lib/ortho-followup-coverage-schema';
import {checksumOf,loadMigrationFiles} from '../lib/migration-files';
import {ORTHO_FOLLOWUP_HISTORY_TABLES,RESET_KEEP_TABLES,RESET_WIPE_TABLES} from '../lib/clinic-reset';
it('registers exact reviewed 0079 bytes without changing adjacent migrations or adopting proposal tables',async()=>{
 const files=await loadMigrationFiles();
 expect(checksumOf(ORTHO_FOLLOWUP_COVERAGE_SQL)).toBe('5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99');
 expect(readFileSync('migrations/0079_ortho_followup_coverage.sql','utf8')).toBe(ORTHO_FOLLOWUP_COVERAGE_SQL);
 expect(files.find(f=>f.version==='0079')).toEqual({version:'0079',name:'ortho_followup_coverage',filename:'0079_ortho_followup_coverage.sql',sql:ORTHO_FOLLOWUP_COVERAGE_SQL,checksum:checksumOf(ORTHO_FOLLOWUP_COVERAGE_SQL)});
 expect(files.filter(f=>f.version>='0078').map(f=>f.version)).toEqual(['0078','0079','0080','0081','0082']);
 const runtime=readFileSync('lib/db.ts','utf8');
 expect(runtime).toContain('sql: ORTHO_FOLLOWUP_COVERAGE_SQL, checksum: checksumOf(ORTHO_FOLLOWUP_COVERAGE_SQL)');
 expect(runtime.indexOf('version: "0078"')).toBeLessThan(runtime.indexOf('version: "0079"'));
 expect(runtime.indexOf('version: "0079"')).toBeLessThan(runtime.indexOf('version: "0080"'));
 expect(ORTHO_FOLLOWUP_COVERAGE_SQL).not.toMatch(/DISABLE TRIGGER|session_replication_role|CREATE TABLE IF NOT EXISTS|UPDATE visits SET|UPDATE ortho_adjustments SET/);
 expect(ORTHO_FOLLOWUP_COVERAGE_SQL).toContain('DEFERRABLE INITIALLY DEFERRED');
});
it('keeps both immutable success and refusal history outside reset wipe ownership',()=>{
 expect(ORTHO_FOLLOWUP_HISTORY_TABLES).toEqual(['ortho_followup_coverage_revisions','ortho_followup_coverage_rejections']);
 for(const table of ORTHO_FOLLOWUP_HISTORY_TABLES){expect(RESET_KEEP_TABLES).toContain(table);expect(RESET_WIPE_TABLES).not.toContain(table);}
});
