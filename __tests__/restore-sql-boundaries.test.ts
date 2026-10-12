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
