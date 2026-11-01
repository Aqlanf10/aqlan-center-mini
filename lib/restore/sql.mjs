/**
 * Locate statements in the SQL emitted by backupSnapshotSqlLines. This is a
 * boundary reader, not an executor or a validator for untrusted arbitrary SQL.
 * The writer uses standard strings (doubled quotes; literal backslashes).
 * Preserve application bytes, including newlines, and remove only complete
 * registry INSERTs. Unsupported quoting fails closed instead of guessing.
 */
export function prepareBackupSql(sql, options = {}) {
  const expected = options.migrationFiles === undefined ? null : new Map();
  if (expected) {
    for (const file of options.migrationFiles) {
      if (!/^\d{4}$/.test(file.version) || !/^[a-f0-9]{64}$/.test(file.checksum) || expected.has(file.version)) {
        throw new Error('Invalid restore migration provenance.');
      }
      expected.set(file.version, file.checksum);
    }
    if (!expected.size) throw new Error('Restore migration provenance unavailable.');
  }
  const archivedVersions = new Set();
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
  const removed = [];
  for (const statement of statements.slice(1, -1)) {
    // No interior transaction control or string-mode changes in a writer backup.
    // A COMMIT line inside a literal is part of its INSERT, never a statement here.
    if (/^(?:BEGIN|COMMIT|END|ROLLBACK|START|SAVEPOINT|RELEASE|PREPARE|SET|RESET)\b/i.test(statement.text)) {
      throw new Error('Unsupported transaction/session command in backup SQL.');
    }
    // Guarded entrypoints accept only the writer's INSERT header. A SQL-valid
    // comment/ONLY/quoted/qualified variant must not sneak a registry write past
    // provenance validation. Application literals and comments are untouched.
    if (expected && /^INSERT\b/i.test(statement.text)
        && !/^INSERT INTO [a-z_][a-z_0-9]*\s*(?:\(|VALUES\b)/.test(statement.text)) {
      throw new Error('Unsupported restore INSERT spelling.');
    }
    if (/^INSERT INTO schema_migrations(?:\s|\()/.test(statement.text)) {
      if (expected) {
        const {version, checksum} = archivedMigrationIdentity(statement.text);
        if (archivedVersions.has(version)) throw new Error(`Duplicate archived migration version: ${version}`);
        archivedVersions.add(version);
        if (!expected.has(version)) throw new Error(`Unknown archived migration version: ${version}; compatible schema recovery required.`);
        if (expected.get(version) !== checksum) throw new Error(`Archived migration checksum mismatch: ${version}; compatible schema recovery required.`);
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
  };
}

/** Read only version/checksum from writer registry INSERTs, never execute metadata.
 * Historical columnless order is version,name,checksum,applied_at,adopted.
 * Unknown SQL expressions or malformed metadata fail closed under the guard. */
function archivedMigrationIdentity(statement) {
  const match = /^INSERT INTO schema_migrations\s*(?:\(([^()]*)\)\s*)?VALUES\s*\(([\s\S]*)\)\s*;$/.exec(statement);
  if (!match) throw new Error('Unsupported archived migration record.');
  const columns = match[1] === undefined ? ['version','name','checksum','applied_at','adopted']
    : match[1].split(',').map(column => column.trim().replace(/^"([a-z_]+)"$/, '$1'));
  if (columns.some(column => !/^[a-z_]+$/.test(column)) || new Set(columns).size !== columns.length) {
    throw new Error('Unsupported archived migration columns.');
  }
  const values = [];
  let start = 0, quote = false, depth = 0;
  for (let i = 0; i < match[2].length; i += 1) {
    const char = match[2][i];
    if (char === "'") {
      if (quote && match[2][i+1] === "'") { i += 1; continue; }
      quote = !quote;
    } else if (!quote) {
      if (char === '(') depth += 1;
      if (char === ')' && --depth < 0) throw new Error('Unsupported archived migration values.');
      if (char === ',' && depth === 0) { values.push(match[2].slice(start,i).trim()); start = i+1; }
    }
  }
  values.push(match[2].slice(start).trim());
  if (quote || depth !== 0 || values.length !== columns.length) throw new Error('Unsupported archived migration values.');
  const literal = column => {
    const index = columns.indexOf(column);
    const value = index < 0 ? null : /^'((?:[^']|'')*)'$/.exec(values[index]);
    if (!value) throw new Error('Archived migration identity is unavailable.');
    return value[1].replaceAll("''", "'");
  };
  const version = literal('version'), checksum = literal('checksum');
  if (!/^\d{4}$/.test(version) || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid archived migration identity.');
  return {version,checksum};
}
