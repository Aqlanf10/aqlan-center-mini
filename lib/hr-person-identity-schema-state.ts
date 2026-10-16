import { createHash } from 'node:crypto';
import type { DbClient } from './db';
import { IdentityPreviewError } from './hr-identity-preview';

export type IdentityQuery = Pick<DbClient, 'query'>;
const TABLES = ['hr_identity_import_runs', 'hr_identity_events', 'hr_staff_account_links', 'hr_staff_party_links'];
const REQUIRED_COLUMNS: Record<string,string[]> = {
  hr_identity_import_runs:['id','actor_user_id','operation','request_id','plan_digest','intent_digest','response','recorded_at'],
  hr_identity_events:['id','run_id','staff_id','revision','actor_user_id','action','reason','source_ref','details','recorded_at'],
  hr_staff_account_links:['id','staff_id','user_id','opened_event_id','opened_at','closed_event_id','closed_at'],
  hr_staff_party_links:['id','staff_id','party_id','opened_event_id','opened_at','closed_event_id','closed_at'],
};
const TRIGGERS = ['hr_identity_runs_append_only','hr_identity_events_append_only','hr_account_link_history','hr_party_link_history',
  'hr_identity_legacy_guard','hr_identity_party_kind','hr_identity_account_source','hr_identity_party_source','hr_leave_identity_immutable','hr_correction_identity_immutable'];
/** No bootstrap, writes or cache: partial deployments must never become legacy fallback. */
export async function readPersonIdentitySchema(client: IdentityQuery): Promise<string | null> {
  const { rows: [state] } = await client.query<{ tables: string[]; columns: string[] }>(`SELECT
    ARRAY(SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]) ORDER BY c.relname) AS tables,
    ARRAY(SELECT c.relname||'.'||a.attname FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attnum>0 AND NOT a.attisdropped
      AND ((c.relname='hr_staff' AND a.attname='identity_revision') OR
      (c.relname IN ('hr_leave_requests','hr_attendance_corrections') AND a.attname IN ('requester_user_id','identity_evidence')))
      ORDER BY c.relname,a.attname) AS columns`, [TABLES]);
  if (state.tables.length === 0 && state.columns.length === 0) return null;
  if (state.tables.length !== TABLES.length || state.columns.length !== 5) {
    throw new IdentityPreviewError(503, 'مخطط هوية الطاقم غير مكتمل؛ يلزم إتمام المراجعة دون إصلاح تلقائي.');
  }
  const { rows } = await client.query(`SELECT c.relname,
    (SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid))
      ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns,
    (SELECT jsonb_agg(pg_get_constraintdef(k.oid) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints,
    (SELECT jsonb_agg(pg_get_indexdef(i.indexrelid) ORDER BY i.indexrelid::regclass::text) FROM pg_index i WHERE i.indrelid=c.oid) AS indexes,
    (SELECT jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid),pg_get_functiondef(t.tgfoid)) ORDER BY t.tgname)
      FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal) AS triggers
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`,
  [[...TABLES, 'hr_staff', 'hr_leave_requests', 'hr_attendance_corrections']]);
  const triggers = rows.flatMap(r => r.triggers ?? []).filter(t => t[1] === 'O').map(t => t[0]);
  const indexes = rows.flatMap(r => r.indexes ?? []) as string[];
  const receiptConstraints = rows.find(r => r.relname === 'hr_identity_import_runs')?.constraints ?? [];
  if (Object.entries(REQUIRED_COLUMNS).some(([table,columns]) => columns.some(name => !rows.find(r => r.relname === table)?.columns.some((c:unknown[]) => c[0] === name)))
    || TRIGGERS.some(t => !triggers.includes(t))
    || ['PRIMARY KEY (id)','UNIQUE (plan_digest)','UNIQUE (actor_user_id, operation, request_id)'].some(c => !receiptConstraints.includes(c))
    || ['hr_staff_account_links_current_user','hr_staff_party_links_current_staff','hr_staff_party_links_current_party']
      .some(name => !indexes.some(def => def.startsWith(`CREATE UNIQUE INDEX ${name} `)))) {
    throw new IdentityPreviewError(503,'قيود نموذج الهوية غير مكتملة؛ التطبيق والمعاينة يحتاجان مراجعة المخطط.');
  }
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** Identity writes take the exclusive form before any domain/source lock. */
export async function lockPersonIdentityForOperation(client: IdentityQuery): Promise<boolean> {
  const installed = await readPersonIdentitySchema(client);
  if (installed) await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('hr-person-identity-v1',0))");
  return installed !== null;
}
