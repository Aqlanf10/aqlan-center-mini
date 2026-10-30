import { describe, expect, it } from 'vitest';
import { insertStatement } from '../lib/backup';
import { prepareBackupSql } from '../lib/restore/sql.mjs';

describe('writer backup SQL boundaries', () => {
  it.each(['\n', '\r\n'])('keeps exact literal bytes with %j newlines and removes only complete registry INSERTs', (newline) => {
    const text = [
      "العربية ' \\ $$ /* -- ;",
      "INSERT INTO schema_migrations (version) VALUES ('9999');",
      'COMMIT;',
      "UPDATE hr_staff SET full_name='UNINTENDED';",
      'INSERT INTO schema_migrations trailing text',
    ].join(newline);
    const row = insertStatement('hr_staff', ['id', 'note'], { id: 1, note: text });
    const metadata = insertStatement('schema_migrations', ['version', 'name'], {
      version: '0058', name: `historical${newline}UPDATE hr_staff SET full_name='UNINTENDED';`,
    });
    const before = `-- backup${newline}BEGIN;${newline}${row}${newline}${metadata}${newline}COMMIT;${newline}`;
    const expected = before.replace(metadata, '');
    const result = prepareBackupSql(before);
    expect(Buffer.from(result.sql)).toEqual(Buffer.from(expected));
    expect(result.dataSql).toBe(`${newline}${row}${newline}${newline}`);
    expect(result.skippedMigrationRecordLines).toBe(1);
    expect(result.sqlRowsStatementLines).toBe(1);
  });

  it('ignores comment decoys, nested block comments and quoted identifier semicolons', () => {
    const body = `\n/* outer ; COMMIT; /* INSERT INTO schema_migrations */ end */\n`
      + `-- INSERT INTO schema_migrations ('decoy');\n`
      + `INSERT INTO example ("semi;""colon", "note") VALUES (1, 'INSERT INTO schema_migrations');\n`;
    const sql = `BEGIN;${body}COMMIT;\n-- trailing comment`;
    expect(prepareBackupSql(sql)).toEqual({ sql, dataSql: body, skippedMigrationRecordLines: 0, sqlRowsStatementLines: 1 });
  });

  it('does not silently discard unknown application tables with migration-like names', () => {
    const sql = "BEGIN; INSERT INTO schema_migrations_extra (id) VALUES (1); COMMIT;";
    expect(prepareBackupSql(sql).sql).toBe(sql);
    expect(prepareBackupSql(sql).skippedMigrationRecordLines).toBe(0);
  });

  it('retains predecessor ledger filtering for INSERTs without an explicit column list', () => {
    const metadata = "INSERT INTO schema_migrations VALUES ('9999', 'historical', 'checksum', NOW(), FALSE);";
    const result = prepareBackupSql(`BEGIN;\n${metadata}\nCOMMIT;`);
    expect(result.sql).toBe('BEGIN;\n\nCOMMIT;');
    expect(result.skippedMigrationRecordLines).toBe(1);
    expect(result.sqlRowsStatementLines).toBe(0);
  });

  it.each([
    "BEGIN; INSERT INTO hr_staff (note) VALUES ('missing quote); COMMIT;",
    "BEGIN; /* missing comment close COMMIT;",
    "BEGIN; INSERT INTO hr_staff (note) VALUES ('COMMIT;');",
    "BEGIN; INSERT INTO hr_staff (note) VALUES ('text'); COMMIT; SELECT 1;",
    "BEGIN; COMMIT; BEGIN; COMMIT;",
    "BEGIN; SET standard_conforming_strings=off; COMMIT;",
    "BEGIN; INSERT INTO hr_staff (note) VALUES (E'escape\\'text'); COMMIT;",
    "BEGIN; INSERT INTO hr_staff (note) VALUES ($tag$unsupported$tag$); COMMIT;",
  ])('rejects incomplete or unsupported writer framing without returning altered SQL: %s', (sql) => {
    expect(() => prepareBackupSql(sql)).toThrow();
  });
});

describe('guarded restore migration provenance',()=>{
  const checksum='a'.repeat(64);
  const migrationFiles=[{version:'0001',checksum},{version:'0080',checksum}];
  const record=(version:string,hash=checksum)=>`INSERT INTO schema_migrations (version,name,checksum) VALUES ('${version}','synthetic','${hash}');`;
  const guard=(body:string)=>prepareBackupSql(`BEGIN;${body}COMMIT;`,{migrationFiles});
  it('allows historical subsets, gaps and legacy absence without claiming schema equivalence',()=>{
    expect(guard(record('0080')).skippedMigrationRecordLines).toBe(1);
    expect(guard('').skippedMigrationRecordLines).toBe(0);
  });
  it('refuses unknown versions even when there are no application rows',()=>{
    expect(()=>guard(record('0090'))).toThrow('Unknown archived migration version: 0090');
  });
  it('refuses reused versions with different SQL and duplicate records',()=>{
    expect(()=>guard(record('0080','b'.repeat(64)))).toThrow('Archived migration checksum mismatch: 0080');
    expect(()=>guard(record('0080')+record('0080'))).toThrow('Duplicate archived migration version');
  });
  it('supports known columnless history and explicit reordered quoted columns',()=>{
    expect(guard(`INSERT INTO schema_migrations VALUES ('0080','old name','${checksum}',NOW(),FALSE);`).skippedMigrationRecordLines).toBe(1);
    expect(guard(`INSERT INTO schema_migrations ("checksum", "name", "version") VALUES ('${checksum}','historical, name','0080');`).skippedMigrationRecordLines).toBe(1);
  });
  it('ignores migration-looking application literals and comments, not real metadata',()=>{
    const note="literal ' quote;\nINSERT INTO schema_migrations (version) VALUES ('0090');";
    const row=insertStatement('hr_staff',['id','note'],{id:1,note});
    const metadata=insertStatement('schema_migrations',['version','name','checksum'],{version:'0080',name:note,checksum});
    const body=`/* INSERT INTO schema_migrations VALUES ('0090'); */\n${row}\n${metadata}`;
    expect(guard(body).sql).toContain(row);
    expect(guard(body).skippedMigrationRecordLines).toBe(1);
  });
  it.each([
    "INSERT INTO schema_migrations (version) VALUES ('0080');",
    "INSERT/**/INTO schema_migrations (version,checksum) VALUES ('0090','bad');",
    "INSERT INTO/**/schema_migrations (version,checksum) VALUES ('0090','bad');",
    "INSERT INTO ONLY schema_migrations (version,checksum) VALUES ('0090','bad');",
    "INSERT INTO only schema_migrations (version,checksum) VALUES ('0090','bad');",
    "insert into schema_migrations (version,checksum) values ('0090','bad');",
    `INSERT INTO "schema_migrations" (version,checksum) VALUES ('0090','bad');`,
    "INSERT INTO public.schema_migrations (version,checksum) VALUES ('0090','bad');",
    "INSERT INTO schema_migrations (version,checksum) VALUES ('0080',NULL);",
    "INSERT INTO schema_migrations (version,checksum) VALUES ('0080','bad');",
    "INSERT INTO schema_migrations (version,version,checksum) VALUES ('0080','0080','bad');",
    "INSERT INTO schema_migrations (version,checksum) VALUES ('0080','bad'),('0090','bad');",
  ])('refuses unsupported metadata: %s',body=>expect(()=>guard(body)).toThrow());
});
