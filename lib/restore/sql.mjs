/**
 * Locate statements in the SQL emitted by backupSnapshotSqlLines. This is a
 * boundary reader, not an executor or a validator for untrusted arbitrary SQL.
 * The writer uses standard strings (doubled quotes; literal backslashes).
 * Offsets are UTF-16 character boundaries in the supplied JavaScript string.
 * Unsupported quoting fails closed instead of guessing. This does not check
 * transaction framing or validate individual statements.
 */
export function scanBackupSqlStatements(sql) {
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
  return statements;
}

/**
 * Decode canonical UTF-8 without stripping a BOM, then translate scanner
 * character boundaries to byte boundaries in that exact input. Fatal decoding
 * rejects invalid, overlong, surrogate and truncated UTF-8 encodings.
 * Sparse scalar-boundary checkpoints avoid a full per-character index and
 * bound the work for each lookup, including out-of-order lookups.
 */
export function createBackupSqlByteBoundaryMapper(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Backup SQL bytes must be a Uint8Array.');
  const sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const checkpoints = [{ characterOffset: 0, byteOffset: 0 }];
  let characterOffset = 0;
  let byteOffset = 0;
  function utf8Width(codePoint) {
    return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  while (characterOffset < sql.length) {
    const codePoint = sql.codePointAt(characterOffset);
    characterOffset += codePoint > 0xffff ? 2 : 1;
    byteOffset += utf8Width(codePoint);
    if (characterOffset - checkpoints.at(-1).characterOffset >= 1024) {
      checkpoints.push({ characterOffset, byteOffset });
    }
  }
  return {
    sql,
    byteOffset(boundary) {
      if (!Number.isInteger(boundary) || boundary < 0 || boundary > sql.length) {
        throw new RangeError('Invalid backup SQL character boundary.');
      }
      const codeUnit = sql.charCodeAt(boundary);
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        throw new RangeError('Backup SQL character boundary splits a surrogate pair.');
      }
      let low = 0;
      let high = checkpoints.length;
      while (low + 1 < high) {
        const middle = Math.floor((low + high) / 2);
        if (checkpoints[middle].characterOffset <= boundary) low = middle;
        else high = middle;
      }
      let { characterOffset, byteOffset } = checkpoints[low];
      while (characterOffset < boundary) {
        const codePoint = sql.codePointAt(characterOffset);
        characterOffset += codePoint > 0xffff ? 2 : 1;
        byteOffset += utf8Width(codePoint);
      }
      return byteOffset;
    },
  };
}

/** Preserve application bytes and remove only complete registry INSERTs. */
export function prepareBackupSql(sql) {
  const statements = scanBackupSqlStatements(sql);
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
    if (/^INSERT INTO schema_migrations(?:\s|\()/.test(statement.text)) {
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
