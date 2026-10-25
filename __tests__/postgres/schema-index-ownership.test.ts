import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { projectDetailedSchemaReadOnly } from '../../lib/schema-manifest';
import { validateLocalVerificationTarget } from '../../lib/verification-target-policy.mjs';
const target = validateLocalVerificationTarget(process.env.TEST_DATABASE_URL, process.env, { varName: 'TEST_DATABASE_URL', databaseName: 'aqlan_p1_test', errorPrefix: 'INDEX_CATALOG_UNSAFE' });
const maintenance = new URL(target); maintenance.pathname = '/postgres';
const admin = new Client({ connectionString: maintenance.toString(), ssl: false });
const database = `aqlan_index_catalog_test_${randomUUID().replaceAll('-', '')}`;
let identity: { oid: string; owner: string } | undefined;
let source: Client | undefined, connected = false;
beforeAll(async () => {
  await admin.connect(); connected = true;
  expect(Math.floor(Number((await admin.query("SELECT current_setting('server_version_num') AS version")).rows[0].version) / 10000)).toBe(18);
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
  identity = (await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [database])).rows[0];
  const url = new URL(target); url.pathname = `/${database}`;
  source = new Client({ connectionString: url.toString(), ssl: false }); await source.connect();
});
afterAll(async () => {
  await source?.end();
  if (connected && identity) {
    const current = (await admin.query('SELECT oid::text,datdba::text AS owner FROM pg_database WHERE datname=$1', [database])).rows[0];
    if (!/^aqlan_index_catalog_test_[a-f0-9]{32}$/.test(database) || current?.oid !== identity.oid || current?.owner !== identity.owner) throw new Error('Owned index fixture cleanup refused');
    await admin.query(`DROP DATABASE "${database}"`);
  }
  if (connected) await admin.end();
});
describe('owning index constraint catalog', () => {
  it('associates indexes only with owning PK/unique/exclusion constraints, not referencing FKs', async () => {
    const client = source!;
    await client.query(`CREATE TABLE synthetic_index_parent (id integer PRIMARY KEY, code integer UNIQUE, span int4range, EXCLUDE USING gist (span WITH &&));
      CREATE TABLE synthetic_index_child (id integer PRIMARY KEY, parent_id integer REFERENCES synthetic_index_parent(id), parent_code integer REFERENCES synthetic_index_parent(code));`);
    const catalog = await projectDetailedSchemaReadOnly(client);
    const indexes = catalog.indexes.filter(index => index.table === 'synthetic_index_parent');
    expect(indexes).toHaveLength(3);
    expect(new Set(catalog.indexes.map(index => index.key)).size).toBe(catalog.indexes.length);
    expect(indexes.map(index => JSON.parse(index.value).constraint).sort()).toEqual(['synthetic_index_parent_code_key','synthetic_index_parent_pkey','synthetic_index_parent_span_excl']);
    const foreignKeys = catalog.constraints.filter(constraint => constraint.table === 'synthetic_index_child' && JSON.parse(constraint.value).type === 'f');
    expect(foreignKeys).toHaveLength(2);
  });

});
