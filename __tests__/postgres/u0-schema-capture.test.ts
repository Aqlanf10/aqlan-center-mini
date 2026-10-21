import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import { validateLocalVerificationTarget } from '../../lib/verification-target-policy.mjs';
import { migrate, loadMigrationFiles } from '../../lib/migrations';
import type { DbPool } from '../../lib/db';
import { INVOICE_UNPAID_CURRENCY_SQL } from '../../lib/invoice-unpaid-currency-schema.proposed';
import { syntheticOwnershipManifest, prepareSyntheticCapture, syntheticRecoveryTrust, recoverySha256 } from '../../lib/restore/u0-synthetic-capture';
import { fullBackupBlocks } from '../../lib/fullBackup';
import { parseTarBytes } from '../../lib/restore/archive';
import { validateBackupArchive } from '../../lib/restore/validate';
import { offlineSchemaManifest, captureOfflineSequences } from '../../lib/restore/u0-offline-primitives';
const target = validateLocalVerificationTarget(process.env.TEST_DATABASE_URL, process.env, { varName: 'TEST_DATABASE_URL', databaseName: 'aqlan_p1_test', errorPrefix: 'SYNTHETIC_CATALOG_UNSAFE' });
const maintenance = new URL(target); maintenance.pathname = '/postgres';
const admin = new Client({ connectionString: maintenance.toString(), ssl: false });
const database = `aqlan_u0_restore_test_${randomUUID().replaceAll('-', '')}`;
let identity: { database: string; oid: string; owner: string } | undefined;
let source: Client | undefined, pool: Pool | undefined, connected = false;
beforeAll(async () => {
  await admin.connect(); connected = true;
  expect((await admin.query("SELECT current_setting('server_version_num')::int AS version")).rows[0].version).toBe(180006);
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  const row = (await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [database])).rows[0];
  identity = { database, ...row };
  const url = new URL(target); url.pathname = `/${database}`;
  pool = new Pool({ connectionString: url.toString(), ssl: false });
  const files = await loadMigrationFiles(fileURLToPath(new URL('../../migrations', import.meta.url)));
  await migrate(pool as unknown as DbPool, { apply: true, files });
  await pool.end(); pool = undefined;
  source = new Client({ connectionString: url.toString(), ssl: false }); await source.connect();
  await source.query(INVOICE_UNPAID_CURRENCY_SQL);
}, 180000);
afterAll(async () => {
  await pool?.end(); await source?.end();
  if (connected && identity) {
    const current = (await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [database])).rows[0];
    if (!/^aqlan_u0_restore_test_[a-f0-9]{32}$/.test(database) || current?.oid !== identity.oid || current?.owner !== identity.owner) throw new Error('Owned synthetic cleanup refused');
    await admin.query(`DROP DATABASE "${database}"`);
  }
  if (connected) await admin.end();
});
describe('real PG18.6 canonical migrated schema capture', () => {
  it('captures supported real catalog and all sequence ownership without executing replay', async () => {
    const client = source!;
    const manifest = await syntheticOwnershipManifest(client), parsed = JSON.parse(manifest);
    expect(parsed.version).toBe(2);
    expect(parsed.catalog.tables.some((table: { key: string }) => table.key === 'invoice_unpaid_currency_claims')).toBe(true);
    expect(parsed.catalog.indexes.length).toBeGreaterThan(0);
    expect(parsed.catalog.columns.some((column: { value: string }) => JSON.parse(column.value).default)).toBe(true);
    const sequences = await captureOfflineSequences(client);
    expect(parsed.catalog.sequences.map((sequence: { key: string }) => sequence.key).sort()).toEqual(sequences.map(sequence => sequence.name).sort());
    expect(await syntheticOwnershipManifest(client)).toBe(manifest);
    await expect(prepareSyntheticCapture(client, identity!, { schemaSha256: recoverySha256(await offlineSchemaManifest(client)), ownershipSha256: recoverySha256(manifest) })).resolves.toEqual({ profile: 'u0-synthetic-v1' });
  });
  it('keeps schema attestation stable across nextval and captures exact advanced sequence state', async () => {
    const client = source!, ownership = await syntheticOwnershipManifest(client), schema = await offlineSchemaManifest(client);
    const sequences = await captureOfflineSequences(client);
    const name = sequences[0].name, quoted = `"${name.replaceAll('"', '""')}"`;
    await client.query(`SELECT nextval('public.${quoted}'::regclass)`);
    expect(await syntheticOwnershipManifest(client)).toBe(ownership);
    const current = (await captureOfflineSequences(client)).find(sequence => sequence.name === name)!;
    const controller = await prepareSyntheticCapture(client, identity!, { schemaSha256: recoverySha256(schema), ownershipSha256: recoverySha256(ownership) });
    const blocks: Buffer[] = [];
    for await (const block of fullBackupBlocks({ source: client, syntheticRecovery: controller })) blocks.push(Buffer.from(block));
    const result = validateBackupArchive(parseTarBytes(Buffer.concat(blocks)), { documentsDir: '/synthetic-documents', syntheticRecoveryTrust: syntheticRecoveryTrust(controller) });
    if (!result.ok) throw new Error(result.errors.join(';'));
    expect(result.syntheticRecovery?.envelope.sequences.find(sequence => sequence.name === name)).toEqual(current);
    expect(result.syntheticRecovery?.readyForCutover).toBe(false);
  });
  it('captures populated patient/photo, family/guarantor and plan/visit links through the actual archive validator', async () => {
    const client = source!, document = Buffer.from('synthetic linked capture document');
    const patient = (await client.query("INSERT INTO patients(patient_number,full_name,note) VALUES('CAPTURE-LINKS','Synthetic only',$1) RETURNING id", ['عربي 😀\nUPDATE patients SET photo_document_id = 1 WHERE id = 1;\nnot SQL'])).rows[0].id as number;
    const family = (await client.query("INSERT INTO patient_families(name,guarantor_patient_id,created_by) VALUES('Synthetic family',$1,'fixture') RETURNING id", [patient])).rows[0].id as number;
    await client.query('UPDATE patients SET family_id=$1 WHERE id=$2', [family, patient]);
    const photo = (await client.query("INSERT INTO patient_documents(patient_id,kind,title,mime_type,size_bytes,sha256,storage_key,uploaded_by) VALUES($1,'other','Synthetic document','application/octet-stream',$2,$3,'synthetic-linked.bin','fixture') RETURNING id", [patient, document.length, recoverySha256(document)])).rows[0].id as number;
    await client.query('UPDATE patients SET photo_document_id=$1 WHERE id=$2', [photo, patient]);
    const plan = (await client.query("INSERT INTO treatment_plans(patient_id,title,total_minor) VALUES($1,'Synthetic plan',0) RETURNING id", [patient])).rows[0].id as number;
    const visit = (await client.query("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic only') RETURNING id", [patient])).rows[0].id as number;
    const item = (await client.query("INSERT INTO plan_items(plan_id,service_name,visit_id) VALUES($1,'Synthetic service',$2) RETURNING id", [plan, visit])).rows[0].id as number;
    const snapshot = async () => {
      const result = [];
      for (const table of ['patients','patient_families','patient_documents','treatment_plans','visits','plan_items']) result.push((await client.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)).rows);
      return result;
    };
    const before = await snapshot();
    const controller = await prepareSyntheticCapture(client, identity!, { schemaSha256: recoverySha256(await offlineSchemaManifest(client)), ownershipSha256: recoverySha256(await syntheticOwnershipManifest(client)) });
    const blocks: Buffer[] = [];
    for await (const block of fullBackupBlocks({ source: client, syntheticRecovery: controller, readDocument: async key => {
      expect(key).toBe('synthetic-linked.bin'); return document;
    } })) blocks.push(Buffer.from(block));
    const archive = parseTarBytes(Buffer.concat(blocks));
    expect(validateBackupArchive(archive).ok).toBe(false);
    const result = validateBackupArchive(archive, { documentsDir: '/synthetic-documents', syntheticRecoveryTrust: syntheticRecoveryTrust(controller) });
    if (!result.ok) throw new Error(result.errors.join(';'));
    expect(result.syntheticRecovery?.envelope.links.map(link => [link.reference,link.sourceId,link.targetId])).toEqual([
      ['plan-visit',item,visit], ['patient-photo',patient,photo], ['family-guarantor',family,patient],
    ]);
    expect(result.documents[0].bytes).toEqual(document);
    expect(result.syntheticRecovery?.model.rows.find(row => row.table === 'patients')?.values).toContain('عربي 😀\nUPDATE patients SET photo_document_id = 1 WHERE id = 1;\nnot SQL');
    expect(result.syntheticRecovery?.readyForCutover).toBe(false);
    expect(await snapshot()).toEqual(before);
  });
  it('captures exact supplement collation/ACL and policy changes on disposable fixture only', async () => {
    const client = source!;
    await client.query('CREATE TABLE synthetic_metadata_probe (id integer PRIMARY KEY, note text COLLATE "C" DEFAULT \'fixture\')');
    const before = await syntheticOwnershipManifest(client);
    await client.query('ALTER TABLE synthetic_metadata_probe ENABLE ROW LEVEL SECURITY');
    await client.query('CREATE POLICY synthetic_metadata_policy ON synthetic_metadata_probe TO PUBLIC USING (id > 0) WITH CHECK (id > 0)');
    const after = await syntheticOwnershipManifest(client), parsed = JSON.parse(after);
    expect(after).not.toBe(before);
    const table = parsed.rows.find((row: { kind: string; name: string }) => row.kind === 'table' && row.name === 'synthetic_metadata_probe');
    expect(table.definition.columns.find((column: { name: string }) => column.name === 'note').collation).toBe('pg_catalog.C');
    expect(parsed.rows.some((row: { kind: string; name: string }) => row.kind === 'policy' && row.name === 'synthetic_metadata_probe.synthetic_metadata_policy')).toBe(true);
  });
  it('rejects unsupported procedures instead of omitting exact routine authority', async () => {
    const client = source!;
    await client.query("CREATE PROCEDURE synthetic_unsupported_procedure() LANGUAGE SQL AS 'SELECT 1'");
    try { await expect(syntheticOwnershipManifest(client)).rejects.toThrow('Unsupported synthetic schema feature'); }
    finally { await client.query('DROP PROCEDURE synthetic_unsupported_procedure()'); }
  });

});
