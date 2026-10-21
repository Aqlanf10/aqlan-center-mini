import { insertStatement, sequenceResets } from './backup';

/** Internal canonical capture events, not an authenticated archive/wire format.
 * Keep the legacy SQL renderer and future recovery capture on the same stream.
 * No consumer may treat these events alone as authorization for target writes.
 */
const BACKUP_DEFERRED_REFERENCES = {
  'plan-visit': { sourceTable: 'plan_items', column: 'visit_id', targetTable: 'visits' },
  'patient-photo': { sourceTable: 'patients', column: 'photo_document_id', targetTable: 'patient_documents' },
  'family-guarantor': { sourceTable: 'patient_families', column: 'guarantor_patient_id', targetTable: 'patients' },
} as const;
export type BackupDeferredReferenceKind = keyof typeof BACKUP_DEFERRED_REFERENCES;
export type BackupInsertEvent = {
  kind: 'insert'; table: string; columns: string[]; row: Record<string, unknown>;
  columnTypes: [string, string][]; identityInsert: boolean;
};
export type BackupDeferredReferenceEvent = {
  kind: 'deferred-reference'; reference: BackupDeferredReferenceKind; sourceId: number; targetId: number;
};
export type BackupSnapshotEvent =
  | { kind: 'begin' | 'commit' | 'separator' }
  | { kind: 'comment'; text: string; leadingSeparator: boolean }
  | BackupInsertEvent
  | BackupDeferredReferenceEvent
  | { kind: 'sequence-reset'; table: string };

export function renderBackupSnapshotEvent(event: BackupSnapshotEvent): string {
  switch (event.kind) {
    case 'begin': return 'BEGIN;\n';
    case 'commit': return 'COMMIT;\n';
    case 'separator': return '\n';
    case 'comment': return `${event.leadingSeparator ? '\n' : ''}-- ${event.text}\n`;
    case 'insert': return `${insertStatement(event.table, event.columns, event.row, new Map(event.columnTypes), event.identityInsert)}\n`;
    case 'sequence-reset': return `${sequenceResets([event.table])[0]}\n`;
    case 'deferred-reference': {
      // Legacy capture historically renders numeric IDs verbatim, including
      // zero/negative IDs. Strict recovery eligibility is checked separately.
      if (!Object.hasOwn(BACKUP_DEFERRED_REFERENCES, event.reference)) fail('reference shape');
      const reference = BACKUP_DEFERRED_REFERENCES[event.reference];
      return `UPDATE ${reference.sourceTable} SET ${reference.column} = ${event.targetId} WHERE id = ${event.sourceId};\n`;
    }
    default: return fail('unknown event kind');
  }
}

export interface ValidatedBackupDeferredReference {
  eventIndex: number;
  sourceInsertIndex: number;
  targetInsertIndex: number;
  reference: BackupDeferredReferenceKind;
  sourceId: number;
  targetId: number;
}
const identifier = /^[a-z_][a-z0-9_]*$/;
const referenceKinds = Object.keys(BACKUP_DEFERRED_REFERENCES) as BackupDeferredReferenceKind[];
const referenceTables = new Set<string>(Object.values(BACKUP_DEFERRED_REFERENCES).flatMap(r => [r.sourceTable, r.targetTable]));
function fail(reason: string): never { throw new Error(`Invalid backup events: ${reason}`); }
function exactKeys(value: object, expected: string[]) {
  const actual = Reflect.ownKeys(value);
  if (actual.length !== expected.length || actual.some(key => typeof key !== 'string' || !expected.includes(key))) fail('event fields');
}
function positiveId(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function named(value: unknown): value is string { return typeof value === 'string' && identifier.test(value); }

/** Pure structural/reference validation of the internal capture stream.
 * Does not execute SQL, prove source authenticity, validate whole-clinic domain
 * semantics, or replace the strict INSERT decoder / database integrity guards.
 * Returned indexes bind links to exact unique source and referenced INSERTs.
 */
export function validateBackupDeferredReferences(events: readonly BackupSnapshotEvent[]): ValidatedBackupDeferredReference[] {
  if (!Array.isArray(events)) fail('event list');
  let phase: 'header' | 'inserts' | 'links' | 'resets' | 'closed' = 'header';
  let lastReferenceKind = -1;
  const rows = new Map<string, { event: BackupInsertEvent; index: number }>();
  const seenLinks = new Set<string>();
  const seenResets = new Set<string>();
  const result: ValidatedBackupDeferredReference[] = [];
  for (const [index, event] of events.entries()) {
    if (!event || typeof event !== 'object' || phase === 'closed') fail('frame');
    switch (event.kind) {
      case 'comment':
        exactKeys(event, ['kind', 'text', 'leadingSeparator']);
        if (typeof event.text !== 'string' || /[\r\n]/.test(event.text) || typeof event.leadingSeparator !== 'boolean') fail('comment');
        break;
      case 'separator': exactKeys(event, ['kind']); break;
      case 'begin':
        exactKeys(event, ['kind']);
        if (phase !== 'header') fail('duplicate BEGIN');
        phase = 'inserts'; break;
      case 'commit':
        exactKeys(event, ['kind']);
        if (phase === 'header') fail('missing BEGIN');
        phase = 'closed'; break;
      case 'insert': {
        exactKeys(event, ['kind', 'table', 'columns', 'row', 'columnTypes', 'identityInsert']);
        if (phase !== 'inserts') fail('INSERT order');
        if (!named(event.table) || !Array.isArray(event.columns) || !event.columns.length
          || event.columns.some(c => !named(c)) || new Set(event.columns).size !== event.columns.length
          || typeof event.identityInsert !== 'boolean' || !event.row || typeof event.row !== 'object' || Array.isArray(event.row)) fail('INSERT shape');
        exactKeys(event.row, event.columns);
        if (!Array.isArray(event.columnTypes) || event.columnTypes.length !== event.columns.length
          || event.columnTypes.some((pair, i) => !Array.isArray(pair) || pair.length !== 2 || pair[0] !== event.columns[i] || typeof pair[1] !== 'string')) fail('column types');
        if (referenceTables.has(event.table)) {
          if (!positiveId(event.row.id)) fail('reference row identity');
          const key = `${event.table}:${event.row.id}`;
          if (rows.has(key)) fail('duplicate row identity');
          rows.set(key, { event, index });
        }
        break;
      }
      case 'deferred-reference': {
        exactKeys(event, ['kind', 'reference', 'sourceId', 'targetId']);
        if (phase !== 'inserts' && phase !== 'links') fail('reference order');
        if (!Object.hasOwn(BACKUP_DEFERRED_REFERENCES, event.reference) || !positiveId(event.sourceId) || !positiveId(event.targetId)) fail('reference shape');
        const rank = referenceKinds.indexOf(event.reference);
        if (rank < lastReferenceKind) fail('reference group order');
        lastReferenceKind = rank; phase = 'links';
        const reference = BACKUP_DEFERRED_REFERENCES[event.reference];
        const sourceKey = `${reference.sourceTable}:${event.sourceId}`;
        if (seenLinks.has(sourceKey)) fail('duplicate reference');
        seenLinks.add(sourceKey);
        const source = rows.get(sourceKey);
        const target = rows.get(`${reference.targetTable}:${event.targetId}`);
        if (!source || !target) fail('missing reference identity');
        if (!Object.hasOwn(source.event.row, reference.column) || source.event.row[reference.column] !== null) fail('expected NULL source');
        result.push({ eventIndex: index, sourceInsertIndex: source.index, targetInsertIndex: target.index,
          reference: event.reference, sourceId: event.sourceId, targetId: event.targetId });
        break;
      }
      case 'sequence-reset':
        exactKeys(event, ['kind', 'table']);
        if (phase === 'header' || !named(event.table) || seenResets.has(event.table)) fail('sequence reset');
        phase = 'resets'; seenResets.add(event.table); break;
      default: fail('unknown event kind');
    }
  }
  if (phase !== 'closed') fail('missing COMMIT');
  return result;
}
