import { parsePatientNumberSequence, patientNumberSequenceMarker } from "./patient-number-sequence.mjs";

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
  let sequenceSnapshot = null;
  let sequenceAfterStatement = -1;
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
    if (char === '-' && next === '-') {
      // Only top-level SQL comments, never patient strings or block comments.
      if (sql.startsWith("-- aqlan-patient-number-sequence-", i)) {
        if (!sql.startsWith(patientNumberSequenceMarker, i)) {
          throw new Error("Unsupported patient-number sequence snapshot version.");
        }
        const lineStart = Math.max(sql.lastIndexOf("\n", i - 1), sql.lastIndexOf("\r", i - 1)) + 1;
        const end = sql.slice(i).search(/[\r\n]/);
        const comment = end < 0 ? sql.slice(i) : sql.slice(i, i + end);
        const fields = comment.slice(patientNumberSequenceMarker.length).match(/^ ([1-9][0-9]{0,18}) (true|false)$/);
        if (sql.slice(lineStart, i).trim() || start >= 0 || sequenceSnapshot !== null || !fields) {
          throw new Error("Malformed or repeated patient-number sequence snapshot.");
        }
        sequenceSnapshot = parsePatientNumberSequence(fields[1], fields[2] === "true");
        sequenceAfterStatement = statements.length;
      }
      lineComment = true;
      i += 1;
      continue;
    }
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
  if (sequenceSnapshot !== null && sequenceAfterStatement !== statements.length - 1) {
    throw new Error("Patient-number sequence snapshot must precede the closing COMMIT.");
  }
  let skippedMigrationRecordLines = 0;
  let sqlRowsStatementLines = 0;
  let historical0079 = null;
  let historical0079Footprint = false;
  const removed = [];
  for (const statement of statements.slice(1, -1)) {
    if (options.rejectUnsupportedHistoricalSchema) refuseUnsupportedHistoricalSchema(statement.text);

    // The previous governance writer used one fixed executable statement.
    // Parse its value and remove the entire statement; never execute source setval.
    const legacySequence = readLegacyPatientSequenceStatement(statement.text);
    if (legacySequence !== null) {
      if (sequenceSnapshot !== null || statement !== statements.at(-2)) {
        throw new Error("Repeated, mixed, or misplaced patient-number sequence snapshot.");
      }
      sequenceSnapshot = legacySequence;
      removed.push(statement);
      continue;
    }

    if (options.inspectHistorical0079) {
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
        // Other registry rows remain target-owned metadata; their historical
        // names may contain arbitrary multiline quoted text. Identify the first
        // version literal without evaluating any source SQL, then demand the
        // exact five-column writer shape only for the retired 0079 contract.
        const version = /^INSERT INTO schema_migrations\s*(?:\("version"[^)]*\))?\s+VALUES\s*\(\s*'((?:''|[^'])*)'\s*,/i.exec(statement.text);
        if (!version) throw new Error('Unsupported backup migration registry record');
        if (version[1].replace(/''/g, "'") === '0079') {
          const match = /^INSERT INTO schema_migrations \("version", "name", "checksum", "applied_at", "adopted"\) VALUES \('([0-9]{4})', '([a-z0-9_]+)', '([a-f0-9]{64})', '([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9:]+))', (TRUE|FALSE)\);$/.exec(statement.text);
          if (!match || historical0079 || match[2] !== 'ortho_followup_coverage'
              || match[3] !== '5603226d149a9be0635d4e99eeaff606d5cc881ce1552b56bf7fbad203044c99'
              || match[5] !== 'FALSE') throw new Error('Invalid historical 0079 registry record');
          historical0079 = { appliedAt: match[4] };
        }
      }
      removed.push(statement);
      skippedMigrationRecordLines += 1;
    } else if (/^INSERT INTO\s/.test(statement.text)) sqlRowsStatementLines += 1;
  }
  if (options.inspectHistorical0079 && historical0079Footprint && !historical0079)
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
    patientNumberSequence: sequenceSnapshot,
    ...(options.inspectHistorical0079 ? { historical0079, historical0079Footprint } : {}),
  };
}

/** Exact numeric/boolean bytes previously produced by the governance writer. */
function readLegacyPatientSequenceStatement(sql) {
  if (!/^SELECT\s+(?:(?:"pg_catalog"|pg_catalog)\s*\.\s*)?"?setval"?\s*\(/i.test(sql)
      || !/\bpatient_number_seq\b/i.test(sql)) return null;
  const fields = /^SELECT setval\('patient_number_seq', GREATEST\(last_value, ([1-9][0-9]{0,18})::bigint\), \(last_value > \1::bigint OR \(last_value = \1::bigint AND is_called\) OR (true|false)\)\) FROM patient_number_seq;$/.exec(sql);
  if (!fields) throw new Error("Unsupported executable patient-number sequence snapshot.");
  return parsePatientNumberSequence(fields[1], fields[2] === "true");
}

// Exact historical migrations that this target cannot round-trip. These are
// refusal fingerprints, not permission to install the archived schema.
const unsupportedHistory = new Map([
  ['0090', { domain: 'booking', name: 'booking_request_preferences',
    checksum: '608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25' }],
  ['0091', { domain: 'prescription', name: 'prescribing_doctor_identity',
    checksum: 'd075fd6222bf8204c2e7de2ea536b66c8f8db71178eaa70de2294f0dba227044' }],
  ['0092', { domain: 'prescription', name: 'prescribing_doctor_snapshot',
    checksum: '587529f146e1bf72fc654cff4fbacb0f233729efaadf26e44fdfde8e802af240' }],
  ['0093', { domain: 'prescription', name: 'prescription_issuance_commands',
    checksum: '7bf8a45c76d1a52b0efa0fae0b0427fb33a079b2be1aced8fc2560e8cf8336dc' }],
]);

const unsupportedHistoryColumns = {
  booking_requests: new Map([['request_key', '0090'], ['request_hash', '0090'], ['preferences', '0090']]),
  prescriptions: new Map([['prescribing_doctor_party_id', '0091'], ['prescribing_doctor_name', '0092']]),
};

/**
 * Reserve incompatible versions even when their tables contain no rows.
 * For populated tables also check the actual writer INSERT header before
 * metadata is stripped. Never interpret a comment or value as a column.
 */
function refuseUnsupportedHistoricalSchema(sql) {
  const target = /^INSERT\s+INTO\s+(?:ONLY\s+)?(?:(?:"public"|public)\s*\.\s*)?"?(schema_migrations|booking_requests|prescriptions|prescription_issuance_commands)"?(?:\s|\()/i.exec(sql)?.[1]?.toLowerCase();
  if (target === 'schema_migrations') {
    const version = /^INSERT INTO schema_migrations\s*(?:\("version"[^)]*\))?\s+VALUES\s*\(\s*'((?:''|[^'])*)'\s*,/i.exec(sql);
    if (!version) throw new Error('Unsupported backup migration registry record');
    const number = version[1].replace(/''/g, "'");
    const historical = unsupportedHistory.get(number);
    if (!historical) return;
    const exact = /^INSERT INTO schema_migrations \("version", "name", "checksum", "applied_at", "adopted"\) VALUES \('([0-9]{4})', '([a-z0-9_]+)', '([a-f0-9]{64})', '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(?:Z|[+-][0-9:]+)', FALSE\);$/.exec(sql);
    if (!exact || exact[1] !== number || exact[2] !== historical.name || exact[3] !== historical.checksum) {
      throw new Error(`Invalid historical ${historical.domain} ${number} registry record`);
    }
    throw new Error(`Historical ${historical.domain} ${number} requires a compatible restore release`);
  }
  // The whole issuance receipt table is absent on this target. Any writer
  // INSERT indicates unsupported history even when its registry row is absent.
  if (target === 'prescription_issuance_commands') {
    throw new Error('Historical prescription 0093 issuance table requires a compatible restore release');
  }
  if (target === 'booking_requests' || target === 'prescriptions') {
    const header = /^INSERT INTO ([a-z_][a-z0-9_]*) \(("[a-z_][a-z0-9_]*"(?:, "[a-z_][a-z0-9_]*")*)\) (?:OVERRIDING SYSTEM VALUE )?VALUES \(/.exec(sql);
    const domain = target === 'booking_requests' ? 'booking' : 'prescription';
    if (!header || header[1] !== target) throw new Error(`Unsupported historical ${domain}-sensitive INSERT header`);
    const guarded = unsupportedHistoryColumns[target];
    for (const column of header[2].split(', ')) {
      const number = guarded.get(column.slice(1, -1));
      if (number) throw new Error(`Historical ${domain} ${number} columns require a compatible restore release`);
    }
  }
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
