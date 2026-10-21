import { describe, expect, it } from 'vitest';
import {
  createBackupSqlByteBoundaryMapper,
  prepareBackupSql,
  scanBackupSqlStatements,
} from '../lib/restore/sql.mjs';
import { prepareBackupSql as originalPrepareBackupSql } from './fixtures/restore-sql-before-boundary-extraction.mjs';

// Frozen oracle copied byte-for-byte from lib/restore/sql.mjs at
// 2667b71f815ee14781cdac6b37ebad3b4f8e246d, before mechanical extraction.
function outcome(prepare, sql) {
  try {
    return { result: prepare(sql) };
  } catch (error) {
    return { error: { name: error.name, message: error.message } };
  }
}

function quote(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

describe('writer backup SQL statement scanner', () => {
  it.each(['\n', '\r\n'])('returns exact top-level statements, not multiline quoted UPDATE text (%j)', (newline) => {
    const note = [
      "العربية 😀 ' \\ $$ /* -- ;",
      "UPDATE invoices SET currency='USD';",
      'COMMIT;',
      "INSERT INTO schema_migrations VALUES ('fake');",
    ].join(newline);
    const insert = `INSERT INTO example ("semi;""colon", note) VALUES (1, ${quote(note)});`;
    const update = "UPDATE invoices SET currency='SAR' WHERE id=1;";
    const sql = `-- header${newline}BEGIN;${newline}${insert}${newline}${update}${newline}COMMIT;${newline}`;
    const statements = scanBackupSqlStatements(sql);
    expect(statements.map(({ text }) => text)).toEqual(['BEGIN;', insert, update, 'COMMIT;']);
    for (const statement of statements) {
      expect(sql.slice(statement.start, statement.end)).toBe(statement.text);
      expect(sql[statement.end - 1]).toBe(';');
    }
    expect(statements.filter(({ text }) => text.startsWith('UPDATE'))).toHaveLength(1);
  });

  it('preserves interior comments and ignores nested and line-comment boundary decoys', () => {
    const insert = "INSERT /* middle ; /* nested UPDATE x; */ tail */ INTO example VALUES ('ok');";
    const sql = `/* outer ; /* UPDATE x; */ COMMIT; */\nBEGIN;\r-- UPDATE x;\r${insert}\nCOMMIT; -- final`;
    expect(scanBackupSqlStatements(sql).map(({ text }) => text)).toEqual(['BEGIN;', insert, 'COMMIT;']);
  });

  it('retains standard literal backslashes and doubled quotes without inventing escaping', () => {
    const sql = "INSERT INTO example VALUES ('backslash\\', 'quote'';still string', 'E'' $$ /* --');";
    expect(scanBackupSqlStatements(sql)).toEqual([{ start: 0, end: sql.length, text: sql }]);
  });

  it('only supplies statement boundaries, without adding framing or arbitrary SQL validation', () => {
    expect(scanBackupSqlStatements('NOT A VALID SQL COMMAND;')).toEqual([
      { start: 0, end: 24, text: 'NOT A VALID SQL COMMAND;' },
    ]);
    expect(scanBackupSqlStatements(' \n/* no statements */ -- end')).toEqual([]);
    expect(() => prepareBackupSql('NOT A VALID SQL COMMAND;')).toThrow();
  });

  it.each([
    "INSERT INTO example VALUES (E'escape');",
    "INSERT INTO example VALUES (e'escape');",
    "INSERT INTO example VALUES (U&'escape');",
    "INSERT INTO example VALUES (u&'escape');",
    'INSERT INTO example VALUES ($$body$$);',
    'INSERT INTO example VALUES ($tag_1$body$tag_1$);',
  ])('keeps unsupported quoting fail-closed: %s', (sql) => {
    expect(() => scanBackupSqlStatements(sql)).toThrow(/Unsupported/);
  });

  it.each([
    "INSERT INTO example VALUES ('missing);",
    'INSERT INTO example ("missing) VALUES (1);',
    '/* outer /* inner */',
    'INSERT INTO example VALUES (1)',
  ])('keeps incomplete input fail-closed: %s', (sql) => {
    expect(() => scanBackupSqlStatements(sql)).toThrow('Incomplete statement in backup SQL.');
  });
});

describe('canonical UTF-8 scanner byte boundaries', () => {
  it('maps Arabic, supplementary characters, combining marks and CRLF without normalization', () => {
    const sql = '\uFEFF-- العربية 😀\r\nBEGIN;\r\nINSERT INTO example VALUES (\'é e\u0301 🦷\');\r\nCOMMIT;';
    const bytes = Buffer.from(sql, 'utf8');
    const mapper = createBackupSqlByteBoundaryMapper(bytes);
    expect(mapper.sql).toBe(sql);
    expect(mapper.byteOffset(0)).toBe(0);
    expect(mapper.byteOffset(1)).toBe(3); // Preserve the UTF-8 BOM, not a zero-byte prefix.
    expect(mapper.byteOffset(sql.length)).toBe(bytes.length);
    for (const statement of scanBackupSqlStatements(mapper.sql)) {
      const start = mapper.byteOffset(statement.start);
      const end = mapper.byteOffset(statement.end);
      expect(bytes.subarray(start, end)).toEqual(Buffer.from(statement.text, 'utf8'));
      expect(start).toBe(Buffer.byteLength(sql.slice(0, statement.start), 'utf8'));
      expect(end).toBe(Buffer.byteLength(sql.slice(0, statement.end), 'utf8'));
    }
  });

  it('handles empty input and Uint8Array views with nonzero byte offsets', () => {
    expect(createBackupSqlByteBoundaryMapper(new Uint8Array()).byteOffset(0)).toBe(0);
    const bytes = Buffer.from('prefix العربية 🦷 suffix', 'utf8');
    const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 7, bytes.length - 14);
    const mapper = createBackupSqlByteBoundaryMapper(view);
    expect(mapper.sql).toBe('العربية 🦷');
    expect(mapper.byteOffset(mapper.sql.length)).toBe(view.byteLength);
  });

  it('maps all scalar boundaries across checkpoints, including out-of-order lookups', () => {
    const sql = `${'a'.repeat(1023)}😀${'بe\u0301🦷'.repeat(500)}\r\n`;
    const mapper = createBackupSqlByteBoundaryMapper(Buffer.from(sql));
    const boundaries = [0];
    let offset = 0;
    for (const character of sql) {
      offset += character.length;
      boundaries.push(offset);
    }
    for (const boundary of boundaries.reverse()) {
      expect(mapper.byteOffset(boundary)).toBe(Buffer.byteLength(sql.slice(0, boundary)));
    }
  });

  it('rejects every boundary inside a surrogate pair rather than rounding or replacing it', () => {
    const mapper = createBackupSqlByteBoundaryMapper(Buffer.from(`A😀ب🦷${'a'.repeat(1017)}😀`));
    for (let index = 0; index < mapper.sql.length; index += 1) {
      const codeUnit = mapper.sql.charCodeAt(index);
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        expect(() => mapper.byteOffset(index)).toThrow('splits a surrogate pair');
      }
    }
  });

  it.each([-1, 2, 0.5, NaN, Infinity, -Infinity, '0', null, undefined])('rejects an invalid boundary: %s', (boundary) => {
    const mapper = createBackupSqlByteBoundaryMapper(Buffer.from('a'));
    expect(() => mapper.byteOffset(boundary)).toThrow(RangeError);
  });

  it.each([
    [0x80], // Unexpected continuation.
    [0xc0, 0xaf], // Overlong two-byte encoding.
    [0xe0, 0x80, 0xaf], // Overlong three-byte encoding.
    [0xf0, 0x80, 0x80, 0xaf], // Overlong four-byte encoding.
    [0xed, 0xa0, 0x80], // UTF-8 encoding of a high surrogate.
    [0xed, 0xbf, 0xbf], // UTF-8 encoding of a low surrogate.
    [0xf4, 0x90, 0x80, 0x80], // Beyond Unicode's maximum code point.
    [0xe2, 0x82], // Truncated scalar.
    [0xff], // Invalid lead byte.
    [0xef, 0xbb, 0xbf, 0xe2], // BOM does not hide malformed trailing bytes.
  ])('rejects malformed/noncanonical UTF-8 bytes: %j', (...bytes) => {
    expect(() => createBackupSqlByteBoundaryMapper(Uint8Array.from(bytes))).toThrow();
  });

  it('does not confuse a correctly encoded replacement character with malformed UTF-8', () => {
    const mapper = createBackupSqlByteBoundaryMapper(Uint8Array.of(0xef, 0xbf, 0xbd));
    expect(mapper.sql).toBe('\uFFFD');
    expect(mapper.byteOffset(1)).toBe(3);
  });

  it.each(['BEGIN;', new ArrayBuffer(4), [65], null])('requires an explicit byte view: %s', (input) => {
    expect(() => createBackupSqlByteBoundaryMapper(input)).toThrow(TypeError);
  });
});

describe('prepareBackupSql mechanical extraction parity', () => {
  const fixtures = [
    '',
    ' -- header\n/* nothing */',
    'BEGIN; COMMIT;',
    '\uFEFFBEGIN;\r\nCOMMIT;',
    'BEGIN; /* nested /* inner ; */ outer */ COMMIT; -- tail',
    "BEGIN; INSERT INTO schema_migrations VALUES ('9999', 'historical'); COMMIT;",
    "BEGIN; INSERT INTO schema_migrations_extra VALUES (1); COMMIT;",
    "BEGIN; insert into schema_migrations VALUES ('lowercase'); COMMIT;",
    "BEGIN; INSERT INTO example VALUES ('literal\\'); COMMIT;",
    'BEGIN; NOT A VALID SQL COMMAND; COMMIT;',
    "BEGIN; INSERT INTO example VALUES ('missing); COMMIT;",
    'BEGIN; /* missing comment close COMMIT;',
    "BEGIN; INSERT INTO example VALUES ('COMMIT;');",
    "BEGIN; INSERT INTO example VALUES ('text'); COMMIT; SELECT 1;",
    'BEGIN; COMMIT; BEGIN; COMMIT;',
    'BEGIN; SET standard_conforming_strings=off; COMMIT;',
    "BEGIN; INSERT INTO example VALUES (E'escape\\'text'); COMMIT;",
    "BEGIN; INSERT INTO example VALUES (U&'escape'); COMMIT;",
    'BEGIN; INSERT INTO example VALUES ($tag$unsupported$tag$); COMMIT;',
    'BEGIN; INSERT INTO example VALUES (1) COMMIT;',
  ];
  for (const newline of ['\n', '\r\n']) {
    const text = [
      "العربية 🦷 ' \\ $$ /* -- ;",
      "INSERT INTO schema_migrations VALUES ('9999');",
      'COMMIT;',
      "UPDATE invoices SET currency='USD';",
    ].join(newline);
    const row = `INSERT INTO example (id, note) VALUES (1, ${quote(text)});`;
    const metadata = `INSERT INTO schema_migrations VALUES ('0058', ${quote(`historical${newline}${text}`)});`;
    fixtures.push(`-- backup${newline}BEGIN;${newline}${row}${newline}${metadata}${newline}COMMIT;${newline}`);
  }

  it.each(fixtures)('preserves original output or exact failure for %j', (sql) => {
    expect(outcome(prepareBackupSql, sql)).toEqual(outcome(originalPrepareBackupSql, sql));
  });
});
