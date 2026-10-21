/** Representation validation is NOT source authentication. Only the connected
 * validateBackupArchive path additionally verifies controller-held trust. */
import { renderBackupSnapshotEvent, validateBackupDeferredReferences, type BackupSnapshotEvent } from '../backup-events';
import { scanBackupSqlStatements, createBackupSqlByteBoundaryMapper } from './sql.mjs';
import { decodeU0Archive, type OfflineRow } from './u0-offline-primitives';
import { SYNTHETIC_U0_PROFILE, SYNTHETIC_LIMITS, recoverySha256, type SyntheticRecoveryEnvelope, type SyntheticDeferredLink } from './u0-synthetic-capture';
const kinds = ['plan-visit', 'patient-photo', 'family-guarantor'] as const;
const identityTables = new Set(['plan_items', 'visits', 'patients', 'patient_documents', 'patient_families']);
function reject(message: string): never { throw new Error(`Invalid synthetic recovery: ${message}`); }
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('object');
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(k => typeof k !== 'string' || !keys.includes(k))) reject('fields');
}
function id(value: unknown): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) reject('integer identity');
  return number;
}
function value(row: OfflineRow, column: string) { return row.values[row.columns.indexOf(column)]; }
function find(rows: OfflineRow[], table: string, identity: number): OfflineRow {
  const matches = rows.filter(row => row.table === table && id(value(row, 'id')) === identity);
  if (matches.length !== 1) reject('relationship identity');
  return matches[0];
}
function relationships(rows: OfflineRow[], links: SyntheticDeferredLink[]) {
  for (const link of links) {
    if (link.reference === 'patient-photo') {
      const document = find(rows, 'patient_documents', link.targetId);
      if (id(value(document, 'patient_id')) !== link.sourceId) reject('photo patient mismatch');
    } else if (link.reference === 'plan-visit') {
      const item = find(rows, 'plan_items', link.sourceId), visit = find(rows, 'visits', link.targetId);
      const plan = find(rows, 'treatment_plans', id(value(item, 'plan_id')));
      if (id(value(plan, 'patient_id')) !== id(value(visit, 'patient_id'))) reject('plan visit patient mismatch');
    } else {
      const family = find(rows, 'patient_families', link.sourceId);
      if (value(family, 'guarantor_name') !== null || value(family, 'guarantor_phone') !== null) reject('conflicting family guarantor');
    }
  }
}
export interface SyntheticRepresentation {
  kind: 'synthetic-u0-representation'; readyForCutover: false;
  insertSql: string; model: ReturnType<typeof decodeU0Archive>; envelope: SyntheticRecoveryEnvelope;
}
export function validateSyntheticRepresentation(sqlBytes: Uint8Array, raw: unknown): SyntheticRepresentation {
  if (sqlBytes.byteLength > SYNTHETIC_LIMITS.sqlBytes) reject('SQL size limit');
  exact(raw, ['profile', 'version', 'captureId', 'source', 'schemaManifest', 'ownershipManifest', 'sequences', 'links', 'databaseSha256', 'databaseBytes', 'observations']);
  if (raw.profile !== SYNTHETIC_U0_PROFILE || raw.version !== 1 || typeof raw.captureId !== 'string' || !/^[a-f0-9-]{36}$/.test(raw.captureId)
    || typeof raw.schemaManifest !== 'string' || !raw.schemaManifest.length || typeof raw.ownershipManifest !== 'string' || !raw.ownershipManifest.length
    || raw.databaseSha256 !== recoverySha256(sqlBytes) || raw.databaseBytes !== sqlBytes.byteLength) reject('profile or SQL identity');
  exact(raw.source, ['database', 'oid', 'owner']);
  if (typeof raw.source.database !== 'string' || !/^aqlan_u0_restore_test_[a-f0-9]{32}$/.test(raw.source.database)
    || typeof raw.source.oid !== 'string' || !/^[0-9]+$/.test(raw.source.oid) || typeof raw.source.owner !== 'string' || !/^[0-9]+$/.test(raw.source.owner)) reject('source identity');
  exact(raw.observations, ['before', 'after']);
  if (typeof raw.observations.before !== 'string' || raw.observations.before !== raw.observations.after) reject('capture observations');
  if (!Array.isArray(raw.sequences) || raw.sequences.length === 0 || !Array.isArray(raw.links)) reject('sequence/link evidence');
  if (raw.sequences.length > SYNTHETIC_LIMITS.sequences || raw.links.length > SYNTHETIC_LIMITS.events
    || Buffer.byteLength(raw.schemaManifest) + Buffer.byteLength(raw.ownershipManifest) > SYNTHETIC_LIMITS.evidenceBytes) reject('evidence count/size limit');
  let previousSequence = '';
  for (const sequence of raw.sequences) {
    exact(sequence, ['name', 'lastValue', 'isCalled', 'definition']);
    if (typeof sequence.name !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(sequence.name) || sequence.name <= previousSequence
      || typeof sequence.lastValue !== 'string' || !/^[0-9]+$/.test(sequence.lastValue) || typeof sequence.isCalled !== 'boolean') reject('sequence state');
    previousSequence = sequence.name;
    exact(sequence.definition, ['type', 'start', 'min', 'max', 'increment', 'cache', 'cycle', 'owner', 'acl']);
    const definition = sequence.definition;
    for (const field of ['start', 'min', 'max', 'increment', 'cache']) if (typeof definition[field] !== 'string' || !/^-?[0-9]+$/.test(definition[field] as string)) reject('sequence definition');
    if (!['smallint', 'integer', 'bigint'].includes(String(definition.type)) || definition.cycle !== false || typeof definition.owner !== 'string'
      || !(definition.acl === null || typeof definition.acl === 'string') || BigInt(definition.increment as string) <= 0n || BigInt(definition.cache as string) <= 0n) reject('unsupported sequence');
    const next = BigInt(sequence.lastValue) + (sequence.isCalled ? BigInt(definition.increment as string) : 0n);
    if (next < BigInt(definition.min as string) || next > BigInt(definition.max as string)) reject('sequence bounds');
  }
  const mapper = createBackupSqlByteBoundaryMapper(sqlBytes);
  const statements = scanBackupSqlStatements(mapper.sql);
  if (statements.length > SYNTHETIC_LIMITS.events) reject('statement count limit');
  const boundaries = new Map(statements.map(statement => [mapper.byteOffset(statement.start), mapper.byteOffset(statement.end)]));
  const links: SyntheticDeferredLink[] = [];
  let end = -1, ordinal = -1, rank = -1;
  for (const candidate of raw.links) {
    exact(candidate, ['kind', 'reference', 'sourceId', 'targetId', 'startByte', 'endByte', 'ordinal']);
    if (candidate.kind !== 'deferred-reference' || !kinds.includes(candidate.reference as typeof kinds[number])) reject('link kind');
    for (const field of ['startByte', 'endByte', 'ordinal']) if (typeof candidate[field] !== 'number' || !Number.isSafeInteger(candidate[field]) || (candidate[field] as number) < 0) reject('link boundary');
    const link = candidate as unknown as SyntheticDeferredLink;
    id(link.sourceId); id(link.targetId);
    if (link.startByte < end || link.ordinal <= ordinal || link.endByte <= link.startByte || boundaries.get(link.startByte) !== link.endByte) reject('top-level statement boundary');
    const nextRank = kinds.indexOf(link.reference);
    if (nextRank < rank) reject('link group order');
    const expected = Buffer.from(renderBackupSnapshotEvent(link).slice(0, -1), 'utf8');
    if (!Buffer.from(sqlBytes.subarray(link.startByte, link.endByte)).equals(expected)) reject('declared statement bytes');
    end = link.endByte; ordinal = link.ordinal; rank = nextRank; links.push(link);
  }
  const declared = new Map(links.map(link => [link.startByte, link]));
  if (statements.length < 2 || statements[0].text !== 'BEGIN;' || statements.at(-1)?.text !== 'COMMIT;') reject('original transaction frame');
  let phase: 'insert' | 'link' | 'reset' = 'insert';
  for (let index = 1; index < statements.length - 1; index++) {
    const statement = statements[index];
    const link = declared.get(mapper.byteOffset(statement.start));
    if (link) {
      if (phase === 'reset' || link.ordinal !== index) reject('link phase or ordinal');
      phase = 'link';
    } else if (/^INSERT INTO /.test(statement.text)) {
      if (phase !== 'insert') reject('INSERT after link or reset');
    } else if (/^SELECT setval\(/.test(statement.text)) phase = 'reset';
    else reject('original transaction statement');
  }
  const pieces: Buffer[] = []; let cursor = 0;
  for (const link of links) { pieces.push(Buffer.from(sqlBytes.subarray(cursor, link.startByte))); cursor = link.endByte; }
  pieces.push(Buffer.from(sqlBytes.subarray(cursor)));
  const insertSql = Buffer.concat(pieces).toString('utf8');
  const model = decodeU0Archive(insertSql); // Unchanged INSERT-only grammar. Any undeclared UPDATE still rejects.
  const events: BackupSnapshotEvent[] = [{ kind: 'begin' }];
  for (const row of model.rows) {
    const data: Record<string, unknown> = Object.fromEntries(row.columns.map((column, i) => [column, row.values[i]]));
    if (identityTables.has(row.table)) data.id = id(data.id);
    events.push({ kind: 'insert', table: row.table, columns: row.columns, row: data,
      columnTypes: row.columns.map(column => [column, 'identity-projection-only']), identityInsert: row.identity });
  }
  for (const link of links) events.push({ kind: link.kind, reference: link.reference, sourceId: link.sourceId, targetId: link.targetId });
  events.push({ kind: 'commit' }); validateBackupDeferredReferences(events);
  relationships(model.rows, links);
  return { kind: 'synthetic-u0-representation', readyForCutover: false, insertSql, model, envelope: raw as unknown as SyntheticRecoveryEnvelope };
}
