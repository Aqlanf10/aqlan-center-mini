import { scanBackupSqlStatements, createBackupSqlByteBoundaryMapper } from '../lib/restore/sql.mjs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'pg';
import { tarBytes } from './helpers/backup-tar';
vi.mock('pg', () => ({ Pool: class { constructor() { throw new Error('No database permitted'); } } }));
vi.mock('@electric-sql/pglite', () => ({ PGlite: class { constructor() { throw new Error('No database permitted'); } } }));
import { fullBackupBlocks } from '../lib/fullBackup';
import { parseTarBytes } from '../lib/restore/archive';
import { validateBackupArchive, parseManifest } from '../lib/restore/validate';
import { prepareSyntheticCapture, syntheticOwnershipManifest, syntheticRecoveryTrust, recoverySha256, SYNTHETIC_U0_ENTRY,
  SYNTHETIC_LIMITS, type SyntheticRecoveryEnvelope, type SyntheticRecoveryTrust } from '../lib/restore/u0-synthetic-capture';
import { validateSyntheticRepresentation } from '../lib/restore/u0-synthetic-validation';
import type { Queryable } from '../lib/db';

const sourceIdentity = { database: `aqlan_u0_restore_test_${'a'.repeat(32)}`, oid: '123', owner: '10' };
const schemaRows = [{ kind: 'trigger', name: 'fixture_guard', definition: 'fixture', enabled: 'O', owner: 'ci', acl: null }];
const ownershipRows = [
  { kind: 'schema', name: 'public', definition: { owner: 'ci', acl: null } },
  { kind: 'table', name: 'patients', definition: { owner: 'ci', acl: null,
    columns: [{ name: 'id', collation: null, acl: null }, { name: 'note', collation: 'pg_catalog.default', acl: null }] } },
  { kind: 'policy', name: 'patients.fixture_policy', definition: { table: 'patients', command: '*', permissive: true, roles: ['PUBLIC'], using: '(id > 0)', check: null } },
];
const detailedCatalog = {
  format: 'aqlan-schema-ownership-catalog', formatVersion: 1, postgresMajor: 18, postgresVersion: '18.6',
  ownership: { databaseOwner: '$owner', schemaOwner: '$owner', schemaAcl: '' },
  tables: [{ key: 'patients', value: JSON.stringify({ rowLevelSecurity: false }) }],
  columns: [{ key: 'patients.id', value: JSON.stringify({ default: "nextval('patients_id_seq'::regclass)" }) }],
  indexes: [{ key: 'patients_name_idx', value: JSON.stringify({ definition: 'CREATE INDEX patients_name_idx ON patients (note)' }) }],
  sequences: [{ key: 'invoice_number_seq', value: JSON.stringify({ ownedTable: null }) }, { key: 'patients_id_seq', value: JSON.stringify({ ownedTable: 'patients', ownedColumn: 'id' }) }],
  constraints: [], triggers: [], internalTriggers: [], functions: [], extensions: [], extensionMembers: [], mutableSequenceState: [], registry: { present: false, rows: [] },
};
vi.mock('../lib/schema-manifest', () => ({ projectDetailedSchemaReadOnly: async (client: Client, schema: string, options: { includeMutableSequenceState?: boolean }) => {
  expect(schema).toBe('public'); expect(options).toEqual({ includeMutableSequenceState: false });
  return (await client.query('FIXTURE detailed catalog')).rows[0]; } }));
const documentBytes = Buffer.from('synthetic document only');
function fixture() {
  let transaction = 'I', changedSequence = false, others = 0;
  const metadata = { rows: structuredClone(ownershipRows) as unknown[], unsupported: [] as unknown[], catalog: structuredClone(detailedCatalog) };
  const rows: Record<string, Record<string, unknown>[]> = {
    patient_families: [{ id: 4, guarantor_patient_id: 1, guarantor_name: null, guarantor_phone: null }],
    patients: [{ id: 1, family_id: 4, photo_document_id: 3, note: 'عربي 😀\nUPDATE patients SET photo_document_id = 3 WHERE id = 1;\nquoted text' }],
    patient_documents: [{ id: 3, patient_id: 1, storage_key: 'fixture.txt', sha256: recoverySha256(documentBytes), size_bytes: documentBytes.length }],
    treatment_plans: [{ id: 5, patient_id: 1 }],
    plan_items: [{ id: 6, plan_id: 5, visit_id: 7 }],
    visits: [{ id: 7, patient_id: 1 }],
  };
  const definition = { type: 'bigint', start: '1', min: '1', max: '9223372036854775807', increment: '1', cache: '1', cycle: false, owner: 'ci', acl: null };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === 'FIXTURE detailed catalog') return { rows: [metadata.catalog] };
    if (sql.startsWith('BEGIN')) { transaction = 'T'; return { rows: [] }; }
    if (sql === 'COMMIT' || sql === 'ROLLBACK') { transaction = 'I'; return { rows: [] }; }
    if (sql.startsWith('SELECT pg_catalog.current_database()')) return { rows: [{ ...sourceIdentity, owned: true, local: true, others, replication: 'origin' }] };
    if (sql.startsWith("SELECT 'trigger'")) return { rows: schemaRows };
    if (sql.startsWith("SELECT 'schema'")) return { rows: metadata.rows };
    if (sql.startsWith("SELECT 'unsupported-relation'")) return { rows: metadata.unsupported };
    if (sql.includes('FROM pg_catalog.pg_sequence')) return { rows: [{ name: 'invoice_number_seq', definition }, { name: 'patients_id_seq', definition }] };
    if (sql.startsWith('SELECT last_value::text')) return { rows: [{ last_value: changedSequence ? '901' : '900', is_called: true }] };
    if (sql.includes('FROM information_schema.tables')) return { rows: Object.keys(rows).sort().map(table_name => ({ table_name })) };
    if (sql.includes('FROM information_schema.table_constraints')) return { rows: [
      { child: 'patients', parent: 'patient_documents' }, { child: 'patient_documents', parent: 'patients' },
      { child: 'patient_families', parent: 'patients' }, { child: 'patients', parent: 'patient_families' },
      { child: 'plan_items', parent: 'visits' }, { child: 'visits', parent: 'plan_items' },
      { child: 'plan_items', parent: 'treatment_plans' }, { child: 'treatment_plans', parent: 'patients' },
    ] };
    if (sql.includes('FROM information_schema.columns')) return { rows: Object.keys(rows[String(values?.[0])][0]).map(column_name => ({ column_name,
      data_type: column_name === 'id' || column_name.endsWith('_id') || column_name === 'size_bytes' ? 'integer' : 'text',
      column_default: column_name === 'id' ? "nextval('fixture_id_seq'::regclass)" : null, is_identity: 'NO' })) };
    const select = /^SELECT \* FROM "([a-z_]+)"$/.exec(sql);
    if (select) return { rows: structuredClone(rows[select[1]]) };
    if (sql.includes("to_regclass('public.expense_attachments')")) return { rows: [{ present: false }] };
    if (sql === 'SELECT id, storage_key, sha256, size_bytes FROM patient_documents ORDER BY id') return { rows: rows.patient_documents };
    throw new Error(`Unexpected synthetic query: ${sql}`);
  });
  const client = { query, getTransactionStatus: () => transaction } as unknown as Client;
  return { client, query, rows, metadata, mutateSequence: () => { changedSequence = true; }, addSession: () => { others = 1; } };
}
async function prepare(f = fixture()) {
  const controller = await prepareSyntheticCapture(f.client, sourceIdentity,
    { schemaSha256: recoverySha256(JSON.stringify(schemaRows)), ownershipSha256: recoverySha256(await syntheticOwnershipManifest(f.client)) });
  return { ...f, controller };
}
async function capture() {
  const f = await prepare(); const blocks: Buffer[] = [];
  for await (const block of fullBackupBlocks({ source: f.client as unknown as Queryable, syntheticRecovery: f.controller, readDocument: async () => documentBytes })) blocks.push(Buffer.from(block));
  const bytes = Buffer.concat(blocks), archive = parseTarBytes(bytes), trust = syntheticRecoveryTrust(f.controller);
  const sql = archive.entries.get('database.sql')!.data;
  const envelope = JSON.parse(Buffer.from(archive.entries.get(SYNTHETIC_U0_ENTRY)!.data).toString('utf8')) as SyntheticRecoveryEnvelope;
  return { ...f, bytes, archive, trust, sql, envelope };
}
function validate(c: Awaited<ReturnType<typeof capture>>) { return validateBackupArchive(c.archive, { documentsDir: '/synthetic-documents', syntheticRecoveryTrust: c.trust }); }
beforeEach(() => { vi.stubEnv('NODE_ENV', 'test'); vi.stubEnv('DATABASE_ENVIRONMENT', 'test'); });
afterEach(() => vi.unstubAllEnvs());

describe('actual canonical capture to trusted synthetic validation', () => {
  it('captures all three cycles, physical documents, full sequence evidence and false readiness', async () => {
    const c = await capture(); const result = validate(c);
    expect(result).toMatchObject({ ok: true, syntheticRecovery: { kind: 'synthetic-u0-representation', readyForCutover: false } });
    if (!result.ok) throw new Error(result.errors.join(';'));
    expect(result.documents[0].bytes).toEqual(documentBytes);
    expect(result.syntheticRecovery?.model.rows).toHaveLength(6);
    expect(c.envelope.links.map(l => l.reference)).toEqual(['plan-visit', 'patient-photo', 'family-guarantor']);
    expect(c.envelope.sequences.map(s => s.name)).toEqual(['invoice_number_seq', 'patients_id_seq']);
    expect(c.envelope.sequences[0]).toMatchObject({ lastValue: '900', isCalled: true });
    expect(result.syntheticRecovery?.insertSql).toContain('عربي 😀\nUPDATE patients SET photo_document_id = 3 WHERE id = 1;\nquoted text');
    expect(c.query.mock.calls.filter(([sql]) => sql.startsWith('BEGIN'))).toHaveLength(1);
  });
  it('preserves ordinary v1 defaults and refuses implicit v2 parsing', async () => {
    const f = fixture(), blocks: Buffer[] = [];
    for await (const block of fullBackupBlocks({ source: f.client as unknown as Queryable, readDocument: async () => documentBytes })) blocks.push(Buffer.from(block));
    const archive = parseTarBytes(Buffer.concat(blocks));
    expect(validateBackupArchive(archive, { documentsDir: '/synthetic-documents' })).toMatchObject({ ok: true, manifest: { version: 1 } });
    expect(archive.entries.has(SYNTHETIC_U0_ENTRY)).toBe(false);
    const c = await capture();
    expect(validateBackupArchive(c.archive).ok).toBe(false);
    expect(parseManifest(JSON.parse(Buffer.from(c.archive.entries.get('manifest.json')!.data).toString('utf8')))).toHaveProperty('errors');
  });
  it('requires controller-held out-of-band trust, not a shape-compatible object', async () => {
    const c = await capture();
    expect(validateBackupArchive(c.archive, { documentsDir: '/synthetic-documents', syntheticRecoveryTrust: { profile: 'u0-synthetic-v1' } as SyntheticRecoveryTrust }).ok).toBe(false);
    const altered = Buffer.from(c.bytes); altered[600] ^= 1;
    expect(validateBackupArchive(parseTarBytes(altered), { documentsDir: '/synthetic-documents', syntheticRecoveryTrust: c.trust }).ok).toBe(false);
  });
  it('consumes verified captured bytes, not a caller-replaced entries map', async () => {
    const c = await capture(); c.archive.entries.get('database.sql')!.data = Buffer.from('BEGIN; COMMIT;');
    const result = validate(c); expect(result.ok).toBe(true);
    if (result.ok) expect(result.syntheticRecovery?.model.rows).toHaveLength(6);
  });
  it.each(['sequence-omission', 'recomputed-inner-hash', 'downgrade', 'duplicate-entry'])('refuses authenticated archive tamper %s', async mode => {
    const c = await capture();
    const entries = c.archive.order.map(name => ({ name, data: Buffer.from(c.archive.entries.get(name)!.data) }));
    const envelope = structuredClone(c.envelope);
    const manifest = JSON.parse(entries.at(-1)!.data.toString('utf8'));
    if (mode === 'sequence-omission') envelope.sequences.shift();
    if (mode === 'recomputed-inner-hash') envelope.captureId = 'b'.repeat(36);
    if (mode === 'downgrade') { manifest.version = 1; delete manifest.recoveryProfile; }
    const recovery = entries.find(entry => entry.name === SYNTHETIC_U0_ENTRY)!;
    recovery.data = Buffer.from(JSON.stringify(envelope));
    manifest.recoverySha256 = recoverySha256(recovery.data); manifest.recoveryBytes = recovery.data.length;
    entries.at(-1)!.data = Buffer.from(JSON.stringify(manifest));
    if (mode === 'duplicate-entry') entries.splice(1, 0, { ...entries[0] });
    const changed = parseTarBytes(tarBytes(entries));
    expect(validateBackupArchive(changed, { documentsDir: '/synthetic-documents', syntheticRecoveryTrust: c.trust }).ok).toBe(false);
    expect(validateBackupArchive(changed).ok).toBe(false);
  });
  it('detects in-place mutation of parser byte views', async () => {
    const c = await capture(); c.archive.entries.get('database.sql')!.data[0] ^= 1;
    expect(validate(c).ok).toBe(false);
  });
  it('does not issue trust for incomplete or failed capture', async () => {
    const f = await prepare(); expect(() => syntheticRecoveryTrust(f.controller)).toThrow('Incomplete');
    f.mutateSequence();
    const run = async () => { for await (const block of fullBackupBlocks({ source: f.client as unknown as Queryable, syntheticRecovery: f.controller })) void block; };
    await expect(run()).rejects.toThrow('source changed');
    expect(() => syntheticRecoveryTrust(f.controller)).toThrow('Incomplete');
    expect(f.query.mock.calls.some(([sql]) => sql === 'ROLLBACK')).toBe(true);
  });
  it('rejects source profile, lifecycle, other sessions and non-test runtime', async () => {
    const f = fixture();
    await expect(prepareSyntheticCapture(f.client, sourceIdentity, { schemaSha256: '0'.repeat(64), ownershipSha256: '0'.repeat(64) })).rejects.toThrow('profile mismatch');
    f.addSession(); await expect(prepare(f)).rejects.toThrow('source identity');
    vi.stubEnv('DATABASE_ENVIRONMENT', 'production'); await expect(prepare()).rejects.toThrow('test environment');
  });
});

describe('connected schema evidence', () => {
  it('captures defaults, collation, indexes, policies, RLS flags and sequence ownership deterministically', async () => {
    const f = fixture(), first = await syntheticOwnershipManifest(f.client);
    f.metadata.rows.reverse();
    expect(await syntheticOwnershipManifest(f.client)).toBe(first);
    expect(first).toContain("nextval"); expect(first).toContain('pg_catalog.default');
    expect(first).toContain('patients_name_idx'); expect(first).toContain('rowLevelSecurity');
    expect(first).toContain('fixture_policy'); expect(first).toContain('ownedColumn');
  });
  it.each(['default', 'collation', 'index', 'policy', 'rls', 'ownership'])('rejects %s drift between prepared source and capture', async field => {
    const f = await prepare();
    // Query fixtures represent catalog values, not archive assertions.
    const rows = JSON.parse(JSON.stringify(f.metadata.rows)) as { kind: string; definition: Record<string, unknown> }[];
    const table = rows.find(row => row.kind === 'table')!.definition;
    if (field === 'rls') f.metadata.catalog.tables[0].value = JSON.stringify({ rowLevelSecurity: true });
    else if (field === 'default') f.metadata.catalog.columns[0].value = JSON.stringify({ default: 'changed' });
    else if (field === 'collation') (table.columns as Record<string, unknown>[])[0].collation = 'changed';
    else if (field === 'index') f.metadata.catalog.indexes[0].value = JSON.stringify({ definition: 'changed' });
    else if (field === 'policy') rows.find(row => row.kind === 'policy')!.definition.using = 'false';
    else f.metadata.catalog.sequences[1].value = JSON.stringify({ ownedTable: null });
    f.metadata.rows = rows;
    await expect(async () => { for await (const block of fullBackupBlocks({ source: f.client as unknown as Queryable, syntheticRecovery: f.controller })) void block; }).rejects.toThrow('source changed');
  });
  it('fails closed for unsupported and missing or malformed catalog metadata', async () => {
    const f = fixture(); f.metadata.unsupported = [{ kind: 'extension', name: 'unmodeled' }];
    await expect(syntheticOwnershipManifest(f.client)).rejects.toThrow('Unsupported');
    f.metadata.unsupported = []; f.metadata.rows = [];
    await expect(syntheticOwnershipManifest(f.client)).rejects.toThrow('missing');
    f.metadata.rows = structuredClone(ownershipRows);
    const table = f.metadata.rows.find(row => (row as { kind: string }).kind === 'table') as { definition: Record<string, unknown> };
    delete table.definition.columns;
    await expect(syntheticOwnershipManifest(f.client)).rejects.toThrow('missing');
  });
});

describe('strict representation checks are separate from provenance', () => {
  it('refuses an UPDATE-looking substring inside a multiline quoted value', async () => {
    const c = await capture(), changed = structuredClone(c.envelope);
    const text = 'UPDATE patients SET photo_document_id = 3 WHERE id = 1;';
    const start = Buffer.from(c.sql).indexOf(Buffer.from(text));
    expect(start).toBeLessThan(changed.links[1].startByte);
    changed.links = [{ ...changed.links[1], startByte: start, endByte: start + Buffer.byteLength(text) }];
    expect(() => validateSyntheticRepresentation(c.sql, changed)).toThrow('top-level statement boundary');
  });
  it.each(['missing', 'duplicate', 'reverse', 'offset', 'inside-surrogate', 'unknown', 'extra'])('rejects malformed typed link case %s', async mode => {
    const c = await capture(), changed = structuredClone(c.envelope);
    if (mode === 'missing') changed.links.pop();
    if (mode === 'duplicate') changed.links.splice(1, 0, { ...changed.links[0] });
    if (mode === 'reverse') changed.links.reverse();
    if (mode === 'offset') changed.links[0].startByte += 1;
    if (mode === 'inside-surrogate') changed.links[0].startByte = Buffer.from(c.sql).indexOf(Buffer.from('😀')) + 1;
    if (mode === 'unknown') Object.assign(changed.links[0], { reference: 'arbitrary-update' });
    if (mode === 'extra') Object.assign(changed.links[0], { sql: 'SELECT 1;' });
    expect(() => validateSyntheticRepresentation(c.sql, changed)).toThrow();
  });
  it.each(['after-commit', 'before-begin', 'duplicate-begin', 'duplicate-commit', 'insert-after-reset', 'link-after-reset', 'ordinal'])('rejects original frame/phase mutation %s', async mode => {
    const c = await capture(), envelope = structuredClone(c.envelope);
    const mapper = createBackupSqlByteBoundaryMapper(c.sql);
    const original = scanBackupSqlStatements(mapper.sql);
    const items = original.map(statement => ({ text: statement.text,
      link: envelope.links.find(link => link.startByte === mapper.byteOffset(statement.start)) }));
    if (mode === 'after-commit' || mode === 'before-begin') {
      const index = mode === 'after-commit' ? items.findLastIndex(item => item.link) : items.findIndex(item => item.link);
      const [item] = items.splice(index, 1);
      if (mode === 'after-commit') items.push(item); else items.unshift(item);
    }
    if (mode === 'duplicate-begin') items.splice(1, 0, { text: 'BEGIN;', link: undefined });
    if (mode === 'duplicate-commit') items.splice(items.length - 1, 0, { text: 'COMMIT;', link: undefined });
    if (mode === 'insert-after-reset' || mode === 'link-after-reset') {
      const index = mode === 'insert-after-reset' ? items.findIndex(item => item.text.startsWith('INSERT INTO ')) : items.findLastIndex(item => item.link);
      const [item] = items.splice(index, 1); items.splice(items.length - 1, 0, item);
    }
    let offset = 0;
    envelope.links = [];
    items.forEach((item, ordinal) => {
      if (item.link) envelope.links.push({ ...item.link, ordinal, startByte: offset, endByte: offset + Buffer.byteLength(item.text) });
      offset += Buffer.byteLength(item.text + '\n');
    });
    if (mode === 'ordinal') envelope.links[0].ordinal += 100;
    const sql = Buffer.from(items.map(item => item.text + '\n').join(''));
    envelope.databaseBytes = sql.length; envelope.databaseSha256 = recoverySha256(sql);
    expect(() => validateSyntheticRepresentation(sql, envelope)).toThrow();
  });
  it('bounds synthetic SQL bytes and evidence counts before decoding', async () => {
    expect(() => validateSyntheticRepresentation(Buffer.alloc(SYNTHETIC_LIMITS.sqlBytes + 1), null)).toThrow('SQL size limit');
    const c = await capture(), envelope = structuredClone(c.envelope);
    envelope.sequences = Array.from({ length: SYNTHETIC_LIMITS.sequences + 1 }, () => envelope.sequences[0]);
    expect(() => validateSyntheticRepresentation(c.sql, envelope)).toThrow('evidence count/size limit');
  });
  it('rejects empty sequence evidence and malformed definition/state', async () => {
    const c = await capture();
    for (const mutate of [
      (e: SyntheticRecoveryEnvelope) => { e.sequences = []; },
      (e: SyntheticRecoveryEnvelope) => { e.sequences.push(structuredClone(e.sequences[0])); },
      (e: SyntheticRecoveryEnvelope) => { e.sequences[0].definition.cycle = true; },
      (e: SyntheticRecoveryEnvelope) => { e.sequences[0].lastValue = 'not-numeric'; },
    ]) { const e = structuredClone(c.envelope); mutate(e); expect(() => validateSyntheticRepresentation(c.sql, e)).toThrow(); }
  });
  it('fails closed for noncanonical UTF-8 and mismatching SQL bytes', async () => {
    const c = await capture(); const bytes = Buffer.from(c.sql); bytes[0] = 255;
    const e = structuredClone(c.envelope); e.databaseSha256 = recoverySha256(bytes);
    expect(() => validateSyntheticRepresentation(bytes, e)).toThrow();
    expect(() => validateSyntheticRepresentation(Buffer.concat([Buffer.from(c.sql), Buffer.from(' ')]), c.envelope)).toThrow('SQL identity');
  });
});
