import type { DbClient } from './db';
import { checksumOf, type MigrationFile } from './migration-files';
import { PRESCRIPTION_ISSUANCE_SQL } from './prescription-issuance-schema';
export const PRESCRIPTION_ISSUANCE_MIGRATIONS: MigrationFile[] = [{
  version: '0093', name: 'prescription_issuance_commands', filename: '0093_prescription_issuance_commands.sql',
  sql: PRESCRIPTION_ISSUANCE_SQL, checksum: checksumOf(PRESCRIPTION_ISSUANCE_SQL),
}];
const table = 'prescription_issuance_commands';
const normalize = (value: string) => value.replace(/::(?:text|bpchar|integer)/g, '').replace(/[\s()"]/g, '').toLowerCase();
const expectedColumns = [
  ['command_key','uuid','NO',null], ['actor_user_id','int4','NO',null], ['actor_username','text','NO',null],
  ['patient_id','int4','NO',null], ['visit_id','int4','YES',null], ['payload_sha256','bpchar','NO',null],
  ['prescription_id','int4','YES',null], ['warning_fingerprint','text','YES',null], ['created_at','timestamptz','NO','now()'],
];
const checks: Record<string, string> = {
  actor_user_id: 'CHECK (actor_user_id > 0)', actor_username: 'CHECK (length(actor_username) >= 1 AND length(actor_username) <= 200)',
  patient_id: 'CHECK (patient_id > 0)', visit_id: 'CHECK (visit_id > 0)',
  payload_sha256: "CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')", warning_fingerprint: "CHECK (warning_fingerprint ~ '^[0-9a-f]{64}$')",
};
/** Both bootstrap paths reject unregistered residue and drifted registered receipt
 * contracts. Checks are read-only, run under the shared migration advisory lock. */
export async function validatePrescriptionIssuanceMigration(client: DbClient, files: MigrationFile[], applied: {version: string; name: string; checksum: string; adopted: boolean}[]) {
  const file = files.find(item => item.version === '0093');
  if (!file) return;
  const expected = PRESCRIPTION_ISSUANCE_MIGRATIONS[0];
  if (file.name !== expected.name || file.checksum !== expected.checksum || checksumOf(file.sql) !== expected.checksum)
    throw new Error('PRESCRIPTION_ISSUANCE_SOURCE_MISMATCH: 0093');
  const registry = applied.find(item => item.version === '0093');
  if (registry && (registry.name !== expected.name || registry.checksum !== expected.checksum || registry.adopted))
    throw new Error('PRESCRIPTION_ISSUANCE_REGISTRY_MISMATCH: 0093');
  const {rows: columns} = await client.query<{column_name:string;udt_name:string;is_nullable:string;column_default:string|null;character_maximum_length:number|null}>(
    `SELECT column_name,udt_name,is_nullable,column_default,character_maximum_length FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [table]);
  const {rows: functions} = await client.query<{proname:string;prosrc:string;provolatile:string;prosecdef:boolean}>(
    `SELECT p.proname,p.prosrc,p.provolatile,p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('aqlan_prescription_command_immutable','aqlan_prescription_command_complete','aqlan_prescription_command_truncate')`);
  if (!registry) {
    if (columns.length || functions.length) throw new Error('PRESCRIPTION_ISSUANCE_CATALOG_MISMATCH: unregistered residue');
    return;
  }
  const fail = () => { throw new Error('PRESCRIPTION_ISSUANCE_CATALOG_MISMATCH: 0093'); };
  if (JSON.stringify(columns.map(c => [c.column_name,c.udt_name,c.is_nullable,c.column_default])) !== JSON.stringify(expectedColumns)
      || columns.find(c => c.column_name === 'payload_sha256')?.character_maximum_length !== 64) fail();
  const {rows: constraints} = await client.query<{conname:string;contype:string;convalidated:boolean;definition:string}>(
    `SELECT c.conname,c.contype,c.convalidated,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=$1 AND c.contype NOT IN ('n','t')`, [table]);
  if (constraints.length !== 9 || constraints.some(c => !c.convalidated)) fail();
  for (const [field, definition] of Object.entries(checks)) {
    if (!constraints.some(c => c.conname === `${table}_${field}_check` && c.contype === 'c' && normalize(c.definition) === normalize(definition))) fail();
  }
  for (const [name, type, definition] of [
    [`${table}_pkey`, 'p', 'PRIMARY KEY (command_key)'],
    [`${table}_prescription_id_key`, 'u', 'UNIQUE (prescription_id)'],
    [`${table}_prescription_id_fkey`, 'f', 'FOREIGN KEY (prescription_id) REFERENCES prescriptions(id) ON DELETE RESTRICT'],
  ]) if (!constraints.some(c => c.conname === name && c.contype === type && normalize(c.definition) === normalize(definition))) fail();
  const {rows: indexes} = await client.query<{index_name:string;indisunique:boolean;indisvalid:boolean;indisready:boolean}>(
    `SELECT idx.relname AS index_name,i.indisunique,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public' AND t.relname=$1`, [table]);
  for (const name of [`${table}_pkey`, `${table}_prescription_id_key`]) {
    if (!indexes.some(i => i.index_name === name && i.indisunique && i.indisvalid && i.indisready)) fail();
  }
  const {rows: triggers} = await client.query<{tgname:string;tgtype:number;tgenabled:string;tgdeferrable:boolean;tginitdeferred:boolean;proname:string}>(
    `SELECT t.tgname,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred,p.proname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND c.relname=$1 AND NOT t.tgisinternal ORDER BY t.tgname`, [table]);
  if (JSON.stringify(triggers) !== JSON.stringify([
    {tgname:'prescription_command_complete',tgtype:21,tgenabled:'O',tgdeferrable:true,tginitdeferred:true,proname:'aqlan_prescription_command_complete'},
    {tgname:'prescription_command_immutable',tgtype:27,tgenabled:'O',tgdeferrable:false,tginitdeferred:false,proname:'aqlan_prescription_command_immutable'},
    {tgname:'prescription_command_truncate',tgtype:34,tgenabled:'O',tgdeferrable:false,tginitdeferred:false,proname:'aqlan_prescription_command_truncate'},
  ])) fail();
  if (functions.length !== 3) fail();
  for (const fn of functions) {
    const marker = `CREATE FUNCTION ${fn.proname}() RETURNS TRIGGER\nLANGUAGE plpgsql AS $$`;
    const body = PRESCRIPTION_ISSUANCE_SQL.split(marker)[1]?.split('$$;')[0];
    if (!body || body !== fn.prosrc || fn.provolatile !== 'v' || fn.prosecdef) fail();
  }
}
