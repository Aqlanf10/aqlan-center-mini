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
    if (!Array.isArray(options.migrationFiles)) throw new Error('Invalid restore migration provenance.');
    for (const file of options.migrationFiles) {
      if (!file || typeof file.version !== 'string' || typeof file.name !== 'string' || typeof file.checksum !== 'string'
          || !/^\d{4}$/.test(file.version) || !/^[a-z0-9_]+$/.test(file.name) || !/^[a-f0-9]{64}$/.test(file.checksum) || expected.has(file.version))
        throw new Error('Invalid restore migration provenance.');
      expected.set(file.version, { name:file.name, checksum:file.checksum });
    }
    if (!expected.size) throw new Error('Restore migration provenance unavailable.');
  }
  const archivedVersions = new Set();
  const inspectHistorical0079 = options.inspectHistorical0079 === true || expected !== null;
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
  let historical0079Footprint = false;
  const removed = [];
  for (const statement of statements.slice(1, -1)) {
    if (inspectHistorical0079) {
      // Inspect writer-generated INSERT headers only: words in literal data or
      // comments are not schema evidence. A source can contain no coverage rows
      // while still emitting the 0079 columns on ordinary visits/adjustments.
      const header = /^INSERT INTO ([a-z_][a-z0-9_]*) \(("[a-z_][a-z0-9_]*"(?:, "[a-z_][a-z0-9_]*")*)\) (?:OVERRIDING SYSTEM VALUE )?VALUES \(/.exec(statement.text);
      const historicalTarget = /^INSERT\s+INTO\s+(?:public\.)?"?(visits|ortho_adjustments|ortho_followup_coverage_revisions|ortho_followup_coverage_rejections)"?(?:\s|\()/i.exec(statement.text);
      if (historicalTarget && !header) throw new Error('Unsupported historical 0079-sensitive INSERT header');
      if (header) {
        const columns = header[2].split(', ').map(value => value.slice(1, -1));
        if (['ortho_followup_coverage_revisions', 'ortho_followup_coverage_rejections'].includes(header[1])
          || header[1] === 'visits' && columns.includes('ortho_followup_coverage_proof')
          || header[1] === 'ortho_adjustments' && columns.includes('followup_coverage_revision_id')) historical0079Footprint = true;
      }
    }
    // No interior transaction control or string-mode changes in a writer backup.
    // A COMMIT line inside a literal is part of its INSERT, never a statement here.
    if (/^(?:BEGIN|COMMIT|END|ROLLBACK|START|SAVEPOINT|RELEASE|PREPARE|SET|RESET)\b/i.test(statement.text)) {
      throw new Error('Unsupported transaction/session command in backup SQL.');
    }
    // This guard accepts the application's writer protocol, not arbitrary SQL.
    // Values are literals only; SELECT and UPDATE are the exact writer forms.
    if (expected && !isWriterStatement(statement.text)) throw new Error('Unsupported restore writer statement.');
    if (/^INSERT INTO lab_work_intent_schema(?:\s|\()/i.test(statement.text)) {
      // Accept only the exact historical writer shape and supported marker value.
      // Target migrations own this row; never import an arbitrary source capability.
      if (!/^INSERT INTO lab_work_intent_schema\s*\(\s*"singleton"\s*,\s*"version"\s*\)\s+VALUES\s*\(\s*TRUE\s*,\s*1\s*\)\s*;$/i.test(statement.text)) {
        throw new Error('Unsupported lab schema capability in backup SQL.');
      }
      removed.push(statement);
      skippedMigrationRecordLines += 1;
    } else if (/^INSERT INTO schema_migrations(?:\s|\()/i.test(statement.text)) {
      let archived = null;
      if (expected) {
        archived = archivedMigrationIdentity(statement.text);
        const { version, checksum, name, appliedAt, adopted } = archived;
        if (archivedVersions.has(version)) throw new Error(`Duplicate archived migration version: ${version}`);
        archivedVersions.add(version);
        if (!expected.has(version)) throw new Error(`Unknown archived migration version: ${version}; compatible schema recovery required.`);
        if (expected.get(version).checksum !== checksum) throw new Error(`Archived migration checksum mismatch: ${version}; compatible schema recovery required.`);
        // Names and metadata from earlier databases are not replayed. A mismatch
        // is nevertheless refused conservatively rather than silently discarded.
        if (version !== '0079' && (expected.get(version).name !== name || (adopted && version !== '0001')
            || !(isHistoricalTimestamp(appliedAt) || appliedAt === 'infinity' || appliedAt === '-infinity')))
          throw new Error('Invalid archived migration metadata.');
      }
      if (inspectHistorical0079) {
        // Other registry rows remain target-owned metadata; their historical
        // names may contain arbitrary multiline quoted text. Identify the first
        // version literal without evaluating any source SQL, then demand the
        // exact five-column writer shape only for the retired 0079 contract.
        const version = archived?.version ?? /^INSERT INTO schema_migrations\s*(?:\("version"[^)]*\))?\s+VALUES\s*\(\s*'((?:''|[^'])*)'\s*,/i.exec(statement.text)?.[1]?.replace(/''/g, "'");
        if (!version) throw new Error('Unsupported backup migration registry record');
        if (version === '0079') {
          const match = /^INSERT INTO schema_migrations \("version", "name", "checksum", "applied_at", "adopted"\) VALUES \('([0-9]{4})', '([a-z0-9_]+)', '([a-f0-9]{64})', '([^']+)', (TRUE|FALSE)\);$/.exec(statement.text);
          if (!match || historical0079 || match[2] !== 'ortho_followup_coverage'
              || match[3] !== '5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99'
              || !isHistoricalTimestamp(match[4]) || match[5] !== 'FALSE') throw new Error('Invalid historical 0079 registry record');
          historical0079 = { appliedAt: match[4] };
        }
      }
      removed.push(statement);
      skippedMigrationRecordLines += 1;
    } else if (/^INSERT INTO\s/.test(statement.text)) sqlRowsStatementLines += 1;
  }
  if (inspectHistorical0079 && historical0079Footprint && !historical0079)
    throw new Error('Historical 0079 data without its exact migration registry record');
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
    ...(inspectHistorical0079 ? { historical0079, historical0079Footprint } : {}),
  };
}

// Validate the writer's finite timestamp spelling before any target is reset.
// Do not use Date.parse: it normalizes impossible dates and loses microseconds.
function isHistoricalTimestamp(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-](?:\d{2}|\d{4}|\d{2}:\d{2}(?::\d{2})?))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]) return false;
  if (match[8] === 'Z') return true;
  const offset = match[8].slice(1);
  const parts = offset.includes(':') ? offset.split(':') : offset.length === 4 ? [offset.slice(0, 2), offset.slice(2)] : [offset];
  const [zoneHour, zoneMinute = 0, zoneSecond = 0] = parts.map(Number);
  return zoneHour <= 15 && zoneMinute <= 59 && zoneSecond <= 59;
}

function isWriterStatement(statement) {
  const insert = /^INSERT INTO ([a-z_][a-z_0-9]*)\s*(?:\(([^()]*)\)\s*)?(?:OVERRIDING SYSTEM VALUE\s+)?VALUES\s*\(([\s\S]*)\)\s*;$/.exec(statement);
  if (insert) {
    let columnCount = null;
    if (insert[2] !== undefined) {
      const columns = insert[2].split(',').map(column => column.trim());
      if (!columns.length || columns.some(column => !/^(?:[a-z_][a-z_0-9]*|"[a-z_][a-z_0-9]*")$/.test(column))) return false;
      columnCount = columns.length;
    }
    const values = [];
    let start = 0, quoted = false;
    for (let i = 0; i < insert[3].length; i++) {
      const ch = insert[3][i];
      if (ch === "'") {
        if (quoted && insert[3][i + 1] === "'") { i++; continue; }
        quoted = !quoted;
      } else if (ch === ',' && !quoted) { values.push(insert[3].slice(start, i).trim()); start = i + 1; }
    }
    values.push(insert[3].slice(start).trim());
    return !quoted && (columnCount === null || columnCount === values.length)
      && values.every(value => /^(?:NULL|TRUE|FALSE|[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|'(?:[^']|'')*')$/.test(value));
  }
  if (/^UPDATE (?:plan_items SET visit_id|patients SET photo_document_id|patient_families SET guarantor_patient_id) = -?\d+ WHERE id = -?\d+;$/.test(statement)) return true;
  if (/^SELECT setval\(pg_get_serial_sequence\('([a-z_][a-z_0-9]*)', 'id'\), COALESCE\(\(SELECT MAX\(id\) FROM \1\), 1\), \(SELECT MAX\(id\) IS NOT NULL FROM \1\)\) WHERE pg_get_serial_sequence\('\1', 'id'\) IS NOT NULL;$/.test(statement)) return true;
  const patient = /^SELECT setval\('patient_number_seq', GREATEST\(last_value, ([1-9][0-9]{0,18})::bigint\), \(last_value > \1::bigint OR \(last_value = \1::bigint AND is_called\) OR (?:true|false)\)\) FROM patient_number_seq;$/.exec(statement);
  return Boolean(patient && BigInt(patient[1]) <= 9223372036854775807n);
}

/** Read version and checksum from writer-produced registry rows, including
 * columnless historical rows, without evaluating or replaying source metadata. */
function archivedMigrationIdentity(statement) {
  const match = /^INSERT INTO schema_migrations\s*(?:\(([^()]*)\)\s*)?VALUES\s*\(([\s\S]*)\)\s*;$/i.exec(statement);
  if (!match) throw new Error('Unsupported archived migration record.');
  const columns = match[1] === undefined ? ['version', 'name', 'checksum', 'applied_at', 'adopted']
    : match[1].split(',').map(column => column.trim().replace(/^"([a-z_]+)"$/, '$1'));
  if (columns.some(column => !/^[a-z_]+$/.test(column)) || new Set(columns).size !== columns.length
      || columns.length !== 5 || !['version','name','checksum','applied_at','adopted'].every(column => columns.includes(column)))
    throw new Error('Unsupported archived migration columns.');
  const values = [];
  let start = 0, quote = false, depth = 0;
  for (let i = 0; i < match[2].length; i += 1) {
    const char = match[2][i];
    if (char === "'") {
      if (quote && match[2][i + 1] === "'") { i += 1; continue; }
      quote = !quote;
    } else if (!quote) {
      if (char === '(') depth += 1;
      if (char === ')' && --depth < 0) throw new Error('Unsupported archived migration values.');
      if (char === ',' && depth === 0) { values.push(match[2].slice(start, i).trim()); start = i + 1; }
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
  const version = literal('version'), name = literal('name'), checksum = literal('checksum'), appliedAt = literal('applied_at');
  const adoptedValue = values[columns.indexOf('adopted')];
  if (adoptedValue !== 'TRUE' && adoptedValue !== 'FALSE') throw new Error('Invalid archived migration metadata.');
  if (!/^\d{4}$/.test(version) || !/^[a-f0-9]{64}$/.test(checksum)) throw new Error('Invalid archived migration identity.');
  return { version, name, checksum, appliedAt, adopted:adoptedValue === 'TRUE' };
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
