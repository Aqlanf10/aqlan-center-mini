import type { DbClient } from './db';
import { checksumOf, type MigrationFile } from './migration-files';

const CHECKSUM = '0d1d94a2003db6599dee120be75c3ff092ad4a19f4e1c911cbde1aa9fc845355';
const ORIGINAL_COLUMN = 'ADD COLUMN corrects_analysis_id BIGINT REFERENCES ceph_analyses(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,';
const REUSED_COLUMN = 'ADD CONSTRAINT ceph_analyses_corrects_analysis_id_fkey FOREIGN KEY (corrects_analysis_id) REFERENCES ceph_analyses(id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,';

export function validateCephLineageMigration(file: MigrationFile, row?: {name: string; checksum: string; adopted: boolean}): void {
  if (file.version !== '0124') return;
  if (file.name !== 'ceph_correction_lineage' || file.filename !== '0124_ceph_correction_lineage.sql'
    || file.checksum !== CHECKSUM || checksumOf(file.sql) !== CHECKSUM)
    throw new Error('CEPH_LINEAGE_SOURCE_MISMATCH: 0124');
  if (row && (row.name !== file.name || row.checksum !== CHECKSUM || row.adopted))
    throw new Error('CEPH_LINEAGE_REGISTRY_MISMATCH: 0124');
}

/** Explicit compatibility execution for the older, unregistered nullable lineage
 * column. The immutable 0124 source and checksum are not rewritten. Only its
 * ADD COLUMN clause becomes the same FK on a verified, empty existing column.
 * Existing rows/constraints are never changed, and no provenance is invented.
 * Caller holds the shared migrator advisory lock and a per-file transaction.
 */
export async function cephLineageMigrationSql(client: DbClient, file: MigrationFile): Promise<string> {
  if (file.version !== '0124') return file.sql;
  validateCephLineageMigration(file);
  await client.query('LOCK TABLE public.ceph_analyses IN ACCESS EXCLUSIVE MODE');
  const { rows: columns } = await client.query<{name: string; type: string; nullable: boolean; default_expr: string | null; identity: string; generated: string; dimensions: number}>(`
    SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,NOT a.attnotnull AS nullable,
      pg_get_expr(d.adbin,d.adrelid) AS default_expr,a.attidentity AS identity,a.attgenerated AS generated,a.attndims AS dimensions
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.ceph_analyses'::regclass AND NOT a.attisdropped
      AND a.attname IN ('corrects_analysis_id','correction_source','correction_source_canonical','correction_source_sha256')`);
  if (!columns.length) return file.sql;
  const column = columns[0];
  if (columns.length !== 1 || column.name !== 'corrects_analysis_id' || column.type !== 'bigint'
    || !column.nullable || column.default_expr !== null || column.identity !== '' || column.generated !== '' || column.dimensions !== 0)
    throw new Error('CEPH_LINEAGE_LEGACY_SHAPE_MISMATCH');
  const { rows: constraints } = await client.query<{name: string; definition: string; validated: boolean; enforced: boolean; deferrable: boolean; deferred: boolean}>(`
    SELECT c.conname AS name,pg_get_constraintdef(c.oid) AS definition,c.convalidated AS validated,c.conenforced AS enforced,
      c.condeferrable AS deferrable,c.condeferred AS deferred
    FROM pg_constraint c WHERE c.conrelid='public.ceph_analyses'::regclass
      AND (SELECT attnum FROM pg_attribute WHERE attrelid=c.conrelid AND attname='corrects_analysis_id')=ANY(c.conkey)
    ORDER BY c.conname`);
  const expected = [
    ['ceph_analyses_corrects_older_chk','CHECK (((corrects_analysis_id IS NULL) OR (corrects_analysis_id < id)))'],
    ['ceph_analyses_corrects_same_patient_fk','FOREIGN KEY (patient_id, corrects_analysis_id) REFERENCES ceph_analyses(patient_id, id)'],
  ];
  if (constraints.length !== expected.length || constraints.some((constraint,index) =>
    constraint.name !== expected[index][0] || constraint.definition !== expected[index][1]
    || !constraint.validated || !constraint.enforced || constraint.deferrable || constraint.deferred))
    throw new Error('CEPH_LINEAGE_LEGACY_CONSTRAINT_MISMATCH');
  const { rows: [data] } = await client.query<{linked: boolean}>(
    'SELECT EXISTS (SELECT 1 FROM public.ceph_analyses WHERE corrects_analysis_id IS NOT NULL) AS linked');
  if (data.linked) throw new Error('CEPH_LINEAGE_LEGACY_LINKS_REQUIRE_REVIEW');
  return file.sql.replace(ORIGINAL_COLUMN, REUSED_COLUMN);
}
