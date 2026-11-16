import type {DbClient} from "./db";

/** Read-only readiness. The numbered migration is owned by ensureSchema; readiness never installs/adopts DDL.
 * Names alone are insufficient: check column types, keys, restrictive FKs and the
 * enabled trigger's timing/events/function identity before admitting any command. */
export async function invoiceAddServiceSchemaReady(client: Pick<DbClient,"query">): Promise<boolean> {
  const {rows:[row]}=await client.query<{ready:boolean}>(`WITH expected_columns(rel,col,typ) AS (VALUES
    ('invoice_service_additions','id','bigint'),('invoice_service_additions','original_invoice_id','integer'),
    ('invoice_service_additions','additional_invoice_id','integer'),('invoice_service_additions','patient_id','integer'),
    ('invoice_service_additions','currency','text'),('invoice_service_additions','source_hash','text'),
    ('invoice_service_additions','idempotency_key','text'),('invoice_service_additions','request_hash','text'),
    ('invoice_service_additions','actor_id','integer'),('invoice_service_additions','created_by','text'),
    ('invoice_service_additions','reason','text'),('invoice_service_additions','receipt','jsonb'),
    ('invoice_service_additions','occurred_at','timestamp with time zone'),
    ('invoice_service_addition_rejections','idempotency_key','text'),('invoice_service_addition_rejections','original_invoice_id','integer'),
    ('invoice_service_addition_rejections','actor_id','integer'),('invoice_service_addition_rejections','request_hash','text'),
    ('invoice_service_addition_rejections','expected_source_hash','text'),('invoice_service_addition_rejections','observed_source_hash','text'),
    ('invoice_service_addition_rejections','rejected_at','timestamp with time zone')),
  expected_keys(rel,definition) AS (VALUES
    ('invoice_service_additions','PRIMARY KEY (id)'),
    ('invoice_service_additions','UNIQUE (additional_invoice_id)'),('invoice_service_additions','UNIQUE (idempotency_key)'),
    ('invoice_service_addition_rejections','PRIMARY KEY (idempotency_key)')),
  expected_fks(rel,col,target) AS (VALUES
    ('invoice_service_additions','original_invoice_id','invoices'),('invoice_service_additions','additional_invoice_id','invoices'),
    ('invoice_service_additions','patient_id','patients'),('invoice_service_additions','actor_id','users'),
    ('invoice_service_addition_rejections','original_invoice_id','invoices'),('invoice_service_addition_rejections','actor_id','users')),
  expected_triggers(rel,name,events,proc) AS (VALUES
    ('invoice_service_additions','invoice_service_additions_immutable',27,'aqlan_invoice_service_addition_immutable'),
    ('invoice_service_additions','invoice_service_additions_no_truncate',34,'aqlan_invoice_service_addition_immutable'),
    ('invoice_service_additions','invoice_service_additions_validate',7,'aqlan_invoice_service_addition_validate'),
    ('invoice_service_addition_rejections','invoice_service_addition_rejections_immutable',27,'aqlan_invoice_service_addition_immutable'),
    ('invoice_service_addition_rejections','invoice_service_addition_rejections_no_truncate',34,'aqlan_invoice_service_addition_immutable'))
  SELECT
    NOT EXISTS(SELECT 1 FROM expected_columns e WHERE NOT EXISTS(
      SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.'||e.rel) AND a.attname=e.col
      AND NOT a.attisdropped AND a.attnotnull AND format_type(a.atttypid,a.atttypmod)=e.typ))
    AND NOT EXISTS(SELECT 1 FROM expected_keys e WHERE NOT EXISTS(
      SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||e.rel) AND c.contype IN ('p','u')
      AND c.convalidated AND pg_get_constraintdef(c.oid)=e.definition))
    AND NOT EXISTS(SELECT 1 FROM expected_fks e WHERE NOT EXISTS(
      SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname=e.col
      JOIN pg_attribute target ON target.attrelid=c.confrelid AND target.attname='id'
      WHERE c.conrelid=to_regclass('public.'||e.rel) AND c.contype='f' AND c.convalidated AND c.confdeltype='r'
      AND c.confrelid=to_regclass('public.'||e.target) AND c.conkey=ARRAY[a.attnum] AND c.confkey=ARRAY[target.attnum]))
    AND NOT EXISTS(SELECT 1 FROM expected_triggers e WHERE NOT EXISTS(
      SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE t.tgrelid=to_regclass('public.'||e.rel) AND t.tgname=e.name AND NOT t.tgisinternal
      AND t.tgenabled='O' AND t.tgtype=e.events AND p.proname=e.proc AND n.nspname='public')) AS ready`);
  return row?.ready===true;
}
