import { describe, expect, it, vi } from 'vitest';
vi.mock('pg', () => ({ Pool: class { constructor() { throw new Error('Database access forbidden'); } } }));
vi.mock('@electric-sql/pglite', () => ({ PGlite: class { constructor() { throw new Error('Database access forbidden'); } } }));
import { backupSnapshotEvents, backupSnapshotSqlLines, type Queryable } from '../lib/db';
import { backupSnapshotSqlLines as oldSqlLines } from './fixtures/backup-snapshot-v1-reference';
import { renderBackupSnapshotEvent, validateBackupDeferredReferences, type BackupSnapshotEvent } from '../lib/backup-events';

type Fixture = Record<string, Record<string, unknown>[]>;
function source(linked = true, planItemId = 6, visitId = 7) {
  const fixture: Fixture = {
    patient_families: [{ id: 4, guarantor_patient_id: linked ? 1 : null }],
    patients: [{ id: 1, photo_document_id: linked ? 3 : null, family_id: 4 }],
    patient_documents: [{ id: 3, patient_id: 1 }],
    treatment_plans: [{ id: 5, patient_id: 1 }],
    plan_items: [{ id: planItemId, plan_id: 5, visit_id: linked ? visitId : null }],
    visits: [{ id: visitId, patient_id: 1 }],
    synthetic_values: [{ id: 8, label: "quote'; -- text\nnext", details: { value: "'" }, tags: ['one', 'two'], stamp: '2001-02-03T04:05:06.123456+05:45', active: true }],
    empty_table: [],
  };
  const types: Record<string, string> = { label: 'text', details: 'jsonb', tags: 'ARRAY', stamp: 'timestamp with time zone', active: 'boolean' };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM information_schema.tables')) return { rows: Object.keys(fixture).sort().map(table_name => ({ table_name })) };
    if (sql.includes('FROM information_schema.table_constraints')) return { rows: [
      { child: 'patients', parent: 'patient_documents' }, { child: 'patient_documents', parent: 'patients' },
      { child: 'patient_families', parent: 'patients' }, { child: 'patients', parent: 'patient_families' },
      { child: 'plan_items', parent: 'visits' }, { child: 'plan_items', parent: 'treatment_plans' },
      { child: 'treatment_plans', parent: 'patients' }, { child: 'visits', parent: 'plan_items' },
    ] };
    if (sql.includes('FROM information_schema.columns')) {
      const table = String(values?.[0]);
      return { rows: Object.keys(fixture[table][0] ?? { id: 0 }).map(column_name => ({
        column_name, data_type: types[column_name] ?? 'integer',
        column_default: column_name === 'id' ? `nextval('${table}_id_seq'::regclass)` : null,
        is_identity: table === 'synthetic_values' && column_name === 'id' ? 'YES' : 'NO',
      })) };
    }
    const selected = / FROM "([a-z_]+)"$/.exec(sql);
    if (selected && Object.hasOwn(fixture, selected[1])) return { rows: structuredClone(fixture[selected[1]]) };
    throw new Error(`Unexpected fixture query ${sql}`);
  });
  return { query } as Queryable & { query: typeof query };
}
async function collect<T>(stream: AsyncGenerator<T>) { const result: T[] = []; for await (const event of stream) result.push(event); return result; }
async function events() { return collect(backupSnapshotEvents(source())); }
function change(stream: BackupSnapshotEvent[], transform: (stream: BackupSnapshotEvent[]) => void) {
  const result = structuredClone(stream); transform(result); return result;
}
const firstLink = (stream: BackupSnapshotEvent[]) => stream.findIndex(e => e.kind === 'deferred-reference');

describe('canonical backup event foundation', () => {
  it.each([true, false])('preserves byte-identical v1 SQL and query order (linked=%s)', async linked => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
    try {
      const original = source(linked), current = source(linked), typed = source(linked);
      const oldSql = (await collect(oldSqlLines(original))).join('');
      const newSql = (await collect(backupSnapshotSqlLines(current))).join('');
      const stream = await collect(backupSnapshotEvents(typed));
      expect(newSql).toBe(oldSql);
      expect(stream.map(renderBackupSnapshotEvent).join('')).toBe(oldSql);
      expect(current.query.mock.calls).toEqual(original.query.mock.calls);
      expect(typed.query.mock.calls).toEqual(original.query.mock.calls);
      expect(validateBackupDeferredReferences(stream)).toHaveLength(linked ? 3 : 0);
      expect(newSql).toContain('OVERRIDING SYSTEM VALUE');
      expect(newSql).toContain('2001-02-03T04:05:06.123456+05:45');
    } finally { vi.useRealTimers(); }
  });
  it.each([[0, 0], [-6, -7], [0, -7], [-6, 0], [Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2]])(
    'keeps legacy numeric ID rendering separate from strict recovery eligibility (%s, %s)', async (sourceId, targetId) => {
      vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T00:00:00.000Z'));
      try {
        const oldSql = (await collect(oldSqlLines(source(true, sourceId, targetId)))).join('');
        const newSql = (await collect(backupSnapshotSqlLines(source(true, sourceId, targetId)))).join('');
        const stream = await collect(backupSnapshotEvents(source(true, sourceId, targetId)));
        expect(newSql).toBe(oldSql);
        expect(stream.map(renderBackupSnapshotEvent).join('')).toBe(oldSql);
        expect(newSql).toContain(`UPDATE plan_items SET visit_id = ${targetId} WHERE id = ${sourceId};`);
        expect(() => validateBackupDeferredReferences(stream)).toThrow('reference row identity');
      } finally { vi.useRealTimers(); }
    },
  );
  it('binds three deferred references to exact preceding NULL source and target identities', async () => {
    const stream = await events();
    const refs = validateBackupDeferredReferences(stream);
    expect(refs.map(r => [r.reference, r.sourceId, r.targetId])).toEqual([
      ['plan-visit', 6, 7], ['patient-photo', 1, 3], ['family-guarantor', 4, 1],
    ]);
    for (const ref of refs) {
      expect(ref.sourceInsertIndex).toBeLessThan(ref.eventIndex);
      expect(ref.targetInsertIndex).toBeLessThan(ref.eventIndex);
      expect(stream[ref.sourceInsertIndex]).toMatchObject({ kind: 'insert', row: { id: ref.sourceId } });
      expect(stream[ref.targetInsertIndex]).toMatchObject({ kind: 'insert', row: { id: ref.targetId } });
    }
    const sourceInsert = stream.find(e => e.kind === 'insert' && e.table === 'plan_items');
    expect(sourceInsert).toMatchObject({ row: { visit_id: null } });
  });
  it.each(['plan-visit', 'patient-photo', 'family-guarantor'])('rejects duplicate %s links even when equal', async reference => {
    const stream = await events(); const index = stream.findIndex(e => e.kind === 'deferred-reference' && e.reference === reference);
    stream.splice(index, 0, structuredClone(stream[index]));
    expect(() => validateBackupDeferredReferences(stream)).toThrow('duplicate reference');
  });
  it.each(['sourceId', 'targetId'])('rejects missing exact %s', async field => {
    const stream = await events(); Object.assign(stream[firstLink(stream)], { [field]: 999 });
    expect(() => validateBackupDeferredReferences(stream)).toThrow('missing reference identity');
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '7', '7; DROP TABLE visits;'])('rejects invalid link ID %s', async value => {
    const stream = await events(); Object.assign(stream[firstLink(stream)], { targetId: value });
    expect(() => validateBackupDeferredReferences(stream)).toThrow('reference shape');
  });
  it('rejects duplicate source and target row identities', async () => {
    const base = await events();
    for (const table of ['plan_items', 'visits']) {
      const stream = structuredClone(base); const index = stream.findIndex(e => e.kind === 'insert' && e.table === table);
      stream.splice(index, 0, structuredClone(stream[index]));
      expect(() => validateBackupDeferredReferences(stream)).toThrow('duplicate row identity');
    }
  });
  it('rejects non-NULL and missing source link columns', async () => {
    const base = await events();
    for (const value of [7, undefined]) {
      const stream = structuredClone(base);
      const insert = stream.find(e => e.kind === 'insert' && e.table === 'plan_items');
      if (insert?.kind === 'insert') insert.row.visit_id = value;
      expect(() => validateBackupDeferredReferences(stream)).toThrow('expected NULL source');
    }
  });
  it('rejects reference-before-target, INSERT-after-link, reversed link groups, and link-after-reset', async () => {
    const base = await events();
    const mutations = [
      (s: BackupSnapshotEvent[]) => { const [link] = s.splice(firstLink(s), 1); s.splice(s.findIndex(e => e.kind === 'insert'), 0, link); },
      (s: BackupSnapshotEvent[]) => { const index = s.findIndex(e => e.kind === 'insert' && e.table === 'synthetic_values'); const [row] = s.splice(index, 1); s.splice(firstLink(s) + 1, 0, row); },
      (s: BackupSnapshotEvent[]) => { const i = firstLink(s); [s[i], s[i + 1]] = [s[i + 1], s[i]]; },
      (s: BackupSnapshotEvent[]) => { const [link] = s.splice(firstLink(s), 1); s.splice(s.length - 1, 0, link); },
    ];
    for (const mutate of mutations) expect(() => validateBackupDeferredReferences(change(base, mutate))).toThrow('Invalid backup events');
  });
  it('rejects arbitrary kinds, reference names, extra fields, and executable SQL event payloads', async () => {
    const base = await events();
    for (const payload of [
      { kind: 'raw-sql', sql: 'UPDATE patients SET photo_document_id = 3;' },
      { kind: 'deferred-reference', reference: 'arbitrary', sourceId: 6, targetId: 7 },
      { kind: 'deferred-reference', reference: '__proto__', sourceId: 6, targetId: 7 },
      { kind: 'deferred-reference', reference: 'plan-visit', sourceId: 6, targetId: 7, sql: 'SELECT 1' },
    ]) {
      const stream = structuredClone(base); stream[firstLink(stream)] = payload as BackupSnapshotEvent;
      expect(() => validateBackupDeferredReferences(stream)).toThrow('Invalid backup events');
    }
  });
  it('rejects malformed INSERT metadata and frame boundaries', async () => {
    const base = await events();
    const mutations = [
      (s: BackupSnapshotEvent[]) => { s.pop(); },
      (s: BackupSnapshotEvent[]) => { s.push({ kind: 'commit' }); },
      (s: BackupSnapshotEvent[]) => { s.splice(s.findIndex(e => e.kind === 'begin'), 1); },
      (s: BackupSnapshotEvent[]) => { const row = s.find(e => e.kind === 'insert'); if (row?.kind === 'insert') row.columns.push('id'); },
      (s: BackupSnapshotEvent[]) => { const row = s.find(e => e.kind === 'insert'); if (row?.kind === 'insert') row.columnTypes.reverse(); },
      (s: BackupSnapshotEvent[]) => { const row = s.find(e => e.kind === 'insert'); if (row?.kind === 'insert') row.row.unexpected = 'value'; },
      (s: BackupSnapshotEvent[]) => { const comment = s.find(e => e.kind === 'comment'); if (comment?.kind === 'comment') comment.text = 'caption\nSELECT 1;'; },
    ];
    for (const mutate of mutations) expect(() => validateBackupDeferredReferences(change(base, mutate))).toThrow('Invalid backup events');
  });
});
