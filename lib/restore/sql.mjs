/**
 * Locate statements in the SQL emitted by backupSnapshotSqlLines. This is a
 * boundary reader, not an executor or a validator for untrusted arbitrary SQL.
 * The writer uses standard strings (doubled quotes; literal backslashes).
 * Preserve application bytes, including newlines, and remove only complete
 * registry INSERTs. Unsupported quoting fails closed instead of guessing.
 */
export function prepareBackupSql(sql, options = {}) {
  const statements = [];
  let start = -1;
  let quote = '';
  let blockDepth = 0;
  let lineComment = false;
  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i], next = sql[i + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false;
      continue;
    }
    if (blockDepth) {
      if (char === '/' && next === '*') { blockDepth += 1; i += 1; }
      else if (char === '*' && next === '/') { blockDepth -= 1; i += 1; }
      continue;
    }
    if (quote) {
      if (char === quote) {
        if (next === quote) i += 1;
        else quote = '';
      }
      continue;
    }
    if (char === '-' && next === '-') { lineComment = true; i += 1; continue; }
    if (char === '/' && next === '*') { blockDepth = 1; i += 1; continue; }
    if (/\s/.test(char)) continue;
    if (start < 0) start = i;
    if (char === "'" || char === '"') {
      if (char === "'" && /(?:^|[^\w$])[eE]$|[uU]&$/.test(sql.slice(Math.max(start, i - 3), i))) {
        throw new Error('Unsupported escape string in backup SQL.');
      }
      quote = char;
    } else if (char === '$' && /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.test(sql.slice(i))) {
      throw new Error('Unsupported dollar quote in backup SQL.');
    } else if (char === ';') {
      statements.push({ start, end: i + 1, text: sql.slice(start, i + 1) });
      start = -1;
    }
  }
  if (quote || blockDepth || start >= 0) throw new Error('Incomplete statement in backup SQL.');
  const opening = statements[0], closing = statements.at(-1);
  if (statements.length < 2 || !/^BEGIN\s*;$/i.test(opening.text) || !/^COMMIT\s*;$/i.test(closing.text)) {
    throw new Error('ملف SQL لا يحوي إطار معاملة الاستعادة المتوقع.');
  }
  let skippedMigrationRecordLines = 0;
  let sqlRowsStatementLines = 0;
  let historical0079 = null;
  const removed = [];
  for (const statement of statements.slice(1, -1)) {
    // No interior transaction control or string-mode changes in a writer backup.
    // A COMMIT line inside a literal is part of its INSERT, never a statement here.
    if (/^(?:BEGIN|COMMIT|END|ROLLBACK|START|SAVEPOINT|RELEASE|PREPARE|SET|RESET)\b/i.test(statement.text)) {
      throw new Error('Unsupported transaction/session command in backup SQL.');
    }
    if (/^INSERT INTO lab_work_intent_schema(?:\s|\()/i.test(statement.text)) {
      // Accept only the exact historical writer shape and supported marker value.
      // Target migrations own this row; never import an arbitrary source capability.
      if (!/^INSERT INTO lab_work_intent_schema\s*\(\s*"singleton"\s*,\s*"version"\s*\)\s+VALUES\s*\(\s*TRUE\s*,\s*1\s*\)\s*;$/i.test(statement.text)) {
        throw new Error('Unsupported lab schema capability in backup SQL.');
      }
      removed.push(statement);
      skippedMigrationRecordLines += 1;
    } else if (/^INSERT INTO schema_migrations(?:\s|\()/i.test(statement.text)) {
      if (options.inspectHistorical0079) {
        // Only accept the exact backup writer's five-column registry shape.
        // Do not execute archive-supplied registry SQL to discover its history.
        const match = /^INSERT INTO schema_migrations \("version", "name", "checksum", "applied_at", "adopted"\) VALUES \('([0-9]{4})', '([a-z0-9_]+)', '([a-f0-9]{64})', '([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9:]+))', (TRUE|FALSE)\);$/.exec(statement.text);
        if (!match) throw new Error('Unsupported backup migration registry record');
        if (match[1] === '0079') {
          if (historical0079 || match[2] !== 'ortho_followup_coverage'
              || match[3] !== '5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99'
              || match[5] !== 'FALSE') throw new Error('Invalid historical 0079 registry record');
          historical0079 = { appliedAt: match[4] };
        }
      }
      removed.push(statement);
      skippedMigrationRecordLines += 1;
    } else if (/^INSERT INTO\s/.test(statement.text)) sqlRowsStatementLines += 1;
  }
  function preservingSlice(from, to) {
    const parts = [];
    let cursor = from;
    for (const statement of removed) {
      parts.push(sql.slice(cursor, statement.start));
      cursor = statement.end;
    }
    parts.push(sql.slice(cursor, to));
    return parts.join('');
  }
  return {
    sql: preservingSlice(0, sql.length),
    dataSql: preservingSlice(opening.end, closing.start),
    // Retain the public result field names; counts now mean real INSERTs.
    skippedMigrationRecordLines,
    sqlRowsStatementLines,
    ...(options.inspectHistorical0079 ? { historical0079 } : {}),
  };
}

/**
 * Restore protocol B1: a canonical source's SQL names each excluded authority relation in
 * this exact comment. Such a backup is restored only by the staged restore, which
 * installs the target-owned hold first (R1); the raw SQL CLI refuses it.
 */
export const CANONICAL_SOURCE_SQL_MARKER = ": target-owned authority, never backed up as data (restore protocol B1)";
export function isCanonicalSourceSql(sql) {
  return typeof sql === "string" && sql.includes(CANONICAL_SOURCE_SQL_MARKER);
}
