import { createHash } from 'node:crypto';
import type { DbClient } from './db';
import { IdentityPreviewError } from './hr-identity-preview';
import expectedSchema from './hr-person-identity-expected-schema.json';

export type IdentityQuery = Pick<DbClient, 'query'>;
const TABLES = ['hr_identity_import_runs', 'hr_identity_events', 'hr_staff_account_links', 'hr_staff_party_links'];
const FUNCTIONS = ['aqlan_hr_identity_append_only', 'aqlan_hr_identity_link_history', 'aqlan_hr_identity_legacy_guard',
  'aqlan_hr_identity_party_kind', 'aqlan_hr_identity_link_source', 'aqlan_hr_request_identity_immutable'];
type SchemaEntry = (string | boolean | null)[];
export interface PersonIdentitySchemaTable {
  relname: string; relkind: string; relpersistence: string; relrowsecurity: boolean;
  columns: SchemaEntry[]; constraints: SchemaEntry[]; indexes: SchemaEntry[]; triggers: SchemaEntry[];
}
const BASE_OBJECTS: Record<string, Record<'columns' | 'constraints' | 'indexes' | 'triggers', readonly string[]>> = {
  hr_staff: {
    columns: ['identity_revision', 'work_status', 'contract_kind', 'user_id', 'user_linked_at', 'hire_date', 'end_date',
      'salary_amount_minor', 'salary_currency', 'salary_period', 'salary_effective_on'],
    constraints: ['hr_staff_identity_revision_check', 'hr_staff_work_status_check', 'hr_staff_contract_kind_check',
      'hr_staff_pay_terms_complete', 'hr_staff_user_id_key', 'hr_staff_user_id_fkey'],
    indexes: ['hr_staff_user_id_key'], triggers: ['hr_identity_legacy_guard'],
  },
  hr_leave_requests: {
    columns: ['requester_user_id', 'identity_evidence'],
    constraints: ['hr_leave_requests_requester_user_id_fkey', 'hr_leave_requests_identity_evidence_check'],
    indexes: [], triggers: ['hr_leave_identity_immutable'],
  },
  hr_attendance_corrections: {
    columns: ['requester_user_id', 'identity_evidence'],
    constraints: ['hr_attendance_corrections_requester_user_id_fkey', 'hr_attendance_corrections_identity_evidence_check'],
    indexes: [], triggers: ['hr_correction_identity_immutable'],
  },
};

/** New identity tables are compared in full. Existing domain tables retain their
 * unrelated objects; every object added/changed/relied on here is pinned below. */
export function personIdentityContractProjection(rows: PersonIdentitySchemaTable[]) {
  return rows.map(row => {
    const base = BASE_OBJECTS[row.relname];
    if (!base) return row;
    return { ...row, ...Object.fromEntries(Object.entries(base).map(([kind, names]) =>
      [kind, row[kind as keyof typeof base].filter(entry => names.includes(String(entry[0])))])) };
  });
}

/** Catalog inspection only. The fixed expected contract is captured from the
 * proposal in an owned PostgreSQL fixture, never accepted from the live schema. */
export async function readPersonIdentityCatalog(client: IdentityQuery): Promise<PersonIdentitySchemaTable[]> {
  const { rows } = await client.query<PersonIdentitySchemaTable>(`SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated) ORDER BY a.attname)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),'[]'::jsonb) AS columns,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname)
      FROM pg_constraint k WHERE k.conrelid=c.oid),'[]'::jsonb) AS constraints,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(ic.relname,i.indisunique,i.indisvalid,i.indisready,i.indislive,pg_get_indexdef(i.indexrelid)) ORDER BY ic.relname)
      FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),'[]'::jsonb) AS indexes,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid),pg_get_functiondef(t.tgfoid)) ORDER BY t.tgname)
      FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),'[]'::jsonb) AS triggers
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [[...TABLES, ...Object.keys(BASE_OBJECTS)]]);
  return rows;
}

/** No bootstrap, writes or cache. A fingerprint is returned only after exact
 * definition validation, including FK/CHECK, index predicate, trigger/function
 * body, enabled/validated state, column type/nullability/default and uniqueness. */
export async function readPersonIdentitySchema(client: IdentityQuery): Promise<string | null> {
  const { rows: [state] } = await client.query<{ tables: string[]; columns: string[]; functions: string[] }>(`SELECT
    ARRAY(SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]) ORDER BY c.relname) AS tables,
    ARRAY(SELECT c.relname||'.'||a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
      AND ((c.relname='hr_staff' AND a.attname='identity_revision') OR
      (c.relname IN ('hr_leave_requests','hr_attendance_corrections') AND a.attname IN ('requester_user_id','identity_evidence')))
      ORDER BY c.relname,a.attname) AS columns,
    ARRAY(SELECT p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($2::text[]) ORDER BY p.proname) AS functions`, [TABLES, FUNCTIONS]);
  if (state.tables.length === 0 && state.columns.length === 0 && state.functions.length === 0) return null;
  if (state.tables.length !== TABLES.length || state.columns.length !== 5 || state.functions.length !== FUNCTIONS.length) {
    throw new IdentityPreviewError(503, 'مخطط هوية الطاقم غير مكتمل؛ يلزم إتمام المراجعة دون إصلاح تلقائي.');
  }
  const rows = await readPersonIdentityCatalog(client);
  if (JSON.stringify(personIdentityContractProjection(rows)) !== JSON.stringify(expectedSchema)) {
    throw new IdentityPreviewError(503, 'تعريفات مخطط الهوية لا تطابق العقد المراجع؛ لا يُقبل مخطط مختلف كبصمة جديدة.');
  }
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** Identity writes take the exclusive form before any domain/source lock. */
export async function lockPersonIdentityForOperation(client: IdentityQuery): Promise<boolean> {
  const installed = await readPersonIdentitySchema(client);
  if (installed) await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('hr-person-identity-v1',0))");
  return installed !== null;
}
