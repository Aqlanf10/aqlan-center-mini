import type { DbClient } from './db';
import type { MigrationFile } from './migration-files';
import { checksumOf } from './migration-files';
import { PRESCRIBING_DOCTOR_IDENTITY_SQL, PRESCRIBING_DOCTOR_SNAPSHOT_SQL } from './prescribing-doctor-schema';

/** Historical #492 SQL, retained byte-for-byte. No booking application code is enabled. */
export const BOOKING_REQUEST_PREFERENCES_SQL = `-- Additive request metadata only; existing requests retain their original meaning.
ALTER TABLE booking_requests ADD COLUMN request_key TEXT;
ALTER TABLE booking_requests ADD COLUMN request_hash TEXT;
ALTER TABLE booking_requests ADD COLUMN preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE UNIQUE INDEX booking_requests_request_key_idx ON booking_requests (request_key) WHERE request_key IS NOT NULL;
`;
const contracts = [
  ['0090', 'booking_request_preferences', BOOKING_REQUEST_PREFERENCES_SQL, '608eeee37b44a59cb4d26e915bd0b2610cf619103905be1fca0c2abe77c52e25'],
  ['0091', 'prescribing_doctor_identity', PRESCRIBING_DOCTOR_IDENTITY_SQL, 'd075fd6222bf8204c2e7de2ea536b66c8f8db71178eaa70de2294f0dba227044'],
  ['0092', 'prescribing_doctor_snapshot', PRESCRIBING_DOCTOR_SNAPSHOT_SQL, '587529f146e1bf72fc654cff4fbacb0f233729efaadf26e44fdfde8e802af240'],
] as const;
export const PRESCRIPTION_LINEAGE_MIGRATIONS: MigrationFile[] = contracts.map(([version,name,sql,checksum]) => ({version,name,sql,checksum,filename:`${version}_${name}.sql`}));
type RegistryRow = {version:string;name:string;checksum:string;adopted:boolean};
type Column = {table_name:string;column_name:string;udt_name:string;is_nullable:string;column_default:string|null};
const columnContracts: Record<string, Array<[string,string,string,string,string|null]>> = {
  '0090': [['booking_requests','request_key','text','YES',null],['booking_requests','request_hash','text','YES',null],['booking_requests','preferences','jsonb','NO',"'{}'::jsonb"]],
  '0091': [['prescriptions','prescribing_doctor_party_id','int4','YES',null]],
  '0092': [['prescriptions','prescribing_doctor_name','text','YES',null]],
};

/** Shared CLI/runtime preflight under the migration lock. Never adopts residue.
 * Missing historical DDL is as invalid as a wrong registry checksum. Pending
 * IF NOT EXISTS SQL cannot legitimize an unregistered or differently typed column. */
export async function validatePrescriptionMigrationLineage(client: DbClient, files: MigrationFile[], applied: RegistryRow[]): Promise<void> {
  const relevant = files.filter(file => contracts.some(([version]) => version === file.version));
  if (!relevant.length) return;
  for (const file of relevant) {
    const expected = PRESCRIPTION_LINEAGE_MIGRATIONS.find(value=>value.version===file.version)!;
    if (file.name!==expected.name || file.checksum!==expected.checksum || checksumOf(file.sql)!==expected.checksum)
      throw new Error(`PRESCRIPTION_MIGRATION_SOURCE_MISMATCH: ${file.version}`);
    const row = applied.find(value=>value.version===file.version);
    if (row && (row.name!==expected.name || row.checksum!==expected.checksum || row.adopted))
      throw new Error(`PRESCRIPTION_MIGRATION_REGISTRY_MISMATCH: ${file.version}`);
  }
  const {rows:columns} = await client.query<Column>(`SELECT table_name,column_name,udt_name,is_nullable,column_default
    FROM information_schema.columns WHERE table_schema='public' AND
    ((table_name='booking_requests' AND column_name IN ('request_key','request_hash','preferences')) OR
     (table_name='prescriptions' AND column_name IN ('prescribing_doctor_party_id','prescribing_doctor_name')))`);
  for (const file of relevant) {
    const registered = applied.some(row=>row.version===file.version);
    for (const [table,name,type,nullable,defaultValue] of columnContracts[file.version]) {
      const column = columns.find(value=>value.table_name===table && value.column_name===name);
      if ((!registered && column) || (registered && (!column || column.udt_name!==type || column.is_nullable!==nullable || column.column_default!==defaultValue)))
        throw new Error(`PRESCRIPTION_MIGRATION_CATALOG_MISMATCH: ${file.version}:${table}.${name}`);
    }
  }
  if (relevant.some(file=>file.version==='0090')) {
    const {rows:indexes} = await client.query<{table_name:string;is_unique:boolean;is_valid:boolean;is_ready:boolean;nulls_not_distinct:boolean;key_count:number;attribute_count:number;method:string;key:string;predicate:string|null}>(
      `SELECT t.relname AS table_name,i.indisunique AS is_unique,i.indisvalid AS is_valid,i.indisready AS is_ready,
        i.indnullsnotdistinct AS nulls_not_distinct,i.indnkeyatts AS key_count,i.indnatts AS attribute_count,
        am.amname AS method,pg_get_indexdef(i.indexrelid,1,true) AS key,pg_get_expr(i.indpred,i.indrelid) AS predicate
       FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
       JOIN pg_namespace n ON n.oid=idx.relnamespace JOIN pg_am am ON am.oid=idx.relam
       WHERE n.nspname='public' AND idx.relname='booking_requests_request_key_idx'`);
    const index=indexes[0];const registered=applied.some(row=>row.version==='0090');
    if ((!registered && indexes.length) || (registered && (indexes.length!==1 || index.table_name!=='booking_requests' || !index.is_unique || !index.is_valid || !index.is_ready || index.nulls_not_distinct || Number(index.key_count)!==1 || Number(index.attribute_count)!==1 || index.method!=='btree' || index.key!=='request_key' || index.predicate?.replace(/[()\s"]/g,'').toLowerCase()!=='request_keyisnotnull')))
      throw new Error('PRESCRIPTION_MIGRATION_CATALOG_MISMATCH: 0090:booking_requests_request_key_idx');
  }
}
