import type { DbClient } from './db';
import type { MigrationFile } from './migration-files';
import { checksumOf } from './migration-files';
import { APPOINTMENT_PURPOSE_PROVENANCE_SHA256, APPOINTMENT_PURPOSE_PROVENANCE_SQL } from './appointment-purpose-schema';

const VERSION = '0095';
const NAME = 'appointment_purpose_provenance';
export const APPOINTMENT_PURPOSE_MIGRATION: MigrationFile = {
  version: VERSION, name: NAME, filename: `${VERSION}_${NAME}.sql`,
  sql: APPOINTMENT_PURPOSE_PROVENANCE_SQL, checksum: APPOINTMENT_PURPOSE_PROVENANCE_SHA256,
};
type Applied = {version:string; name:string; checksum:string; adopted:boolean};
const catalogError = (detail: string): never => { throw new Error(`APPOINTMENT_PURPOSE_MIGRATION_CATALOG_MISMATCH: ${detail}`); };
// Never lowercase or remove quotes: CHECK literals and quoted identifiers are
// policy, not formatting. All expected strings are PostgreSQL's canonical case.
const normal = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Preflight under the shared migration advisory lock, before *any* 0095 DDL.
 * This rejects unregistered residue, changed source/registry, and tampered
 * immutable-history table, FKs, guard function or triggers. It does not adopt. */
export async function validateAppointmentPurposeMigration(
  client: DbClient, files: MigrationFile[], applied: Applied[],
): Promise<void> {
  const file = files.find(item => item.version === VERSION);
  if (!file) return;
  if (file.name !== NAME || file.filename !== APPOINTMENT_PURPOSE_MIGRATION.filename ||
      file.checksum !== APPOINTMENT_PURPOSE_PROVENANCE_SHA256 ||
      checksumOf(file.sql) !== APPOINTMENT_PURPOSE_PROVENANCE_SHA256 ||
      checksumOf(APPOINTMENT_PURPOSE_PROVENANCE_SQL) !== APPOINTMENT_PURPOSE_PROVENANCE_SHA256)
    throw new Error('APPOINTMENT_PURPOSE_MIGRATION_SOURCE_MISMATCH: 0095');
  const row = applied.find(item => item.version === VERSION);
  if (row && (row.name !== NAME || row.checksum !== file.checksum || row.adopted))
    throw new Error('APPOINTMENT_PURPOSE_MIGRATION_REGISTRY_MISMATCH: 0095');
  const registered = !!row;
  const {rows:[table]} = await client.query<{oid:string;relkind:string}>(
    `SELECT c.oid::text AS oid,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relname='appointment_purpose_provenance'`);
  const {rows:objects} = await client.query<{kind:string;name:string;definition:string;enabled:string|null;validated:boolean|null;target:string}>(
    `SELECT 'constraint' AS kind, con.conname AS name, pg_get_constraintdef(con.oid) AS definition,
            NULL::text AS enabled,con.convalidated AS validated,con.conrelid::regclass::text AS target
       FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace
       WHERE n.nspname='public' AND con.conname IN
       ('appointments_purpose_identity_uniq','treatment_plans_purpose_identity_uniq',
        'planned_visits_purpose_identity_uniq','appointment_purpose_source_shape',
        'appointment_purpose_patient_fk','appointment_purpose_appointment_owner_fk',
        'appointment_purpose_plan_owner_fk','appointment_purpose_visit_owner_plan_fk',
        'appointment_purpose_provenance_pkey','appointment_purpose_command_uniq',
        'appointment_purpose_command_shape','appointment_purpose_actor_fk',
        'appointment_purpose_provenance_purpose_check',
        'appointment_purpose_provenance_recorded_by_check')
     UNION ALL
     SELECT 'trigger',t.tgname,pg_get_triggerdef(t.oid),t.tgenabled::text,NULL::boolean,c.oid::regclass::text
       FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname IN
       ('appointment_purpose_immutable','appointment_purpose_no_nonempty_truncate')
     UNION ALL
     SELECT 'function',p.proname,p.prosrc,NULL::text,NULL::boolean,n.nspname
       FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE n.nspname='public' AND p.proname='aqlan_appointment_purpose_immutable'`);
  const {rows:indexResidue} = await client.query<{name:string}>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN
      ('appointments_purpose_identity_uniq','treatment_plans_purpose_identity_uniq',
       'planned_visits_purpose_identity_uniq','appointment_purpose_provenance_pkey',
       'appointment_purpose_command_uniq',
       'appointment_purpose_patient_time_idx','appointment_purpose_plan_time_idx')`);
  if (!registered) {
    if (table || objects.length || indexResidue.length) catalogError('unregistered residue');
    return;
  }
  if (!table || table.relkind !== 'r') catalogError('table missing or wrong kind');
  const expectedConstraints: Record<string,[string,string]> = {
    appointments_purpose_identity_uniq: ['appointments','UNIQUE (id, patient_id)'],
    treatment_plans_purpose_identity_uniq: ['treatment_plans','UNIQUE (id, patient_id)'],
    planned_visits_purpose_identity_uniq: ['planned_visits','UNIQUE (id, patient_id, plan_id)'],
    appointment_purpose_provenance_pkey: ['appointment_purpose_provenance','PRIMARY KEY (appointment_id)'],
    appointment_purpose_patient_fk: ['appointment_purpose_provenance','FOREIGN KEY (patient_id) REFERENCES patients(id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    appointment_purpose_appointment_owner_fk: ['appointment_purpose_provenance','FOREIGN KEY (appointment_id, patient_id) REFERENCES appointments(id, patient_id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    appointment_purpose_plan_owner_fk: ['appointment_purpose_provenance','FOREIGN KEY (source_plan_id, patient_id) REFERENCES treatment_plans(id, patient_id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    appointment_purpose_visit_owner_plan_fk: ['appointment_purpose_provenance','FOREIGN KEY (source_planned_visit_id, patient_id, source_plan_id) REFERENCES planned_visits(id, patient_id, plan_id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    appointment_purpose_actor_fk: ['appointment_purpose_provenance','FOREIGN KEY (actor_user_id) REFERENCES users(id) ON UPDATE RESTRICT ON DELETE RESTRICT'],
    appointment_purpose_command_uniq: ['appointment_purpose_provenance','UNIQUE (command_id)'],
    appointment_purpose_command_shape: ['appointment_purpose_provenance',"CHECK ((((purpose = ANY (ARRAY['consultation'::text, 'start_treatment'::text])) AND (command_id IS NOT NULL) AND (command_hash IS NOT NULL) AND (command_hash ~ '^[0-9a-f]{64}$'::text) AND (actor_user_id IS NOT NULL)) OR ((purpose = ANY (ARRAY['continue_session'::text, 'try_in'::text, 'delivery'::text, 'follow_up'::text])) AND (command_id IS NULL) AND (command_hash IS NULL) AND (actor_user_id IS NULL))))"],
    appointment_purpose_provenance_purpose_check: ['appointment_purpose_provenance',"CHECK ((purpose = ANY (ARRAY['consultation'::text, 'start_treatment'::text, 'continue_session'::text, 'try_in'::text, 'delivery'::text, 'follow_up'::text])))"],
    appointment_purpose_provenance_recorded_by_check: ['appointment_purpose_provenance','CHECK (((length(btrim(recorded_by)) >= 1) AND (length(btrim(recorded_by)) <= 200)))'],
    appointment_purpose_source_shape: ['appointment_purpose_provenance',"CHECK ((((purpose = ANY (ARRAY['consultation'::text, 'start_treatment'::text])) AND (source_plan_id IS NULL) AND (source_planned_visit_id IS NULL)) OR ((purpose = ANY (ARRAY['continue_session'::text, 'try_in'::text, 'delivery'::text, 'follow_up'::text])) AND (source_plan_id IS NOT NULL) AND (source_planned_visit_id IS NOT NULL))))"],
  };
  for (const [name,[target,definition]] of Object.entries(expectedConstraints)) {
    const matching = objects.filter(item => item.kind === 'constraint' && item.name === name);
    if (matching.length !== 1 || normal(matching[0].target) !== target || !matching[0].validated ||
        normal(matching[0].definition) !== definition) catalogError(name);
  }
  const {rows:indexes} = await client.query<{name:string;target:string;valid:boolean;ready:boolean;unique:boolean;method:string;keys:string[];options:string;predicate:string|null}>(
    `SELECT irel.relname AS name,t.relname AS target,idx.indisvalid AS valid,idx.indisready AS ready,
      idx.indisunique AS unique,am.amname AS method,
      ARRAY(SELECT pg_get_indexdef(idx.indexrelid,k,true) FROM generate_series(1,idx.indnkeyatts) AS k ORDER BY k) AS keys,
      idx.indoption::text AS options,
      pg_get_expr(idx.indpred,idx.indrelid) AS predicate
     FROM pg_index idx JOIN pg_class irel ON irel.oid=idx.indexrelid
       JOIN pg_class t ON t.oid=idx.indrelid JOIN pg_namespace n ON n.oid=irel.relnamespace
       JOIN pg_am am ON am.oid=irel.relam
     WHERE n.nspname='public' AND irel.relname IN
       ('appointments_purpose_identity_uniq','treatment_plans_purpose_identity_uniq',
        'planned_visits_purpose_identity_uniq','appointment_purpose_provenance_pkey',
        'appointment_purpose_command_uniq',
        'appointment_purpose_patient_time_idx','appointment_purpose_plan_time_idx')`);
  const expectedIndexes:Record<string,[string,boolean,string[],string,string|null]> = {
    appointments_purpose_identity_uniq:['appointments',true,['id','patient_id'],'0 0',null],
    treatment_plans_purpose_identity_uniq:['treatment_plans',true,['id','patient_id'],'0 0',null],
    planned_visits_purpose_identity_uniq:['planned_visits',true,['id','patient_id','plan_id'],'0 0 0',null],
    appointment_purpose_provenance_pkey:['appointment_purpose_provenance',true,['appointment_id'],'0',null],
    appointment_purpose_command_uniq:['appointment_purpose_provenance',true,['command_id'],'0',null],
    appointment_purpose_patient_time_idx:['appointment_purpose_provenance',false,['patient_id','recorded_at','appointment_id'],'0 3 3',null],
    appointment_purpose_plan_time_idx:['appointment_purpose_provenance',false,['source_plan_id','recorded_at'],'0 3','source_plan_id IS NOT NULL'],
  };
  for (const [name,[target,unique,keys,options,predicate]] of Object.entries(expectedIndexes)) {
    const match=indexes.filter(index=>index.name===name);
    if (match.length!==1 || match[0].target!==target || !match[0].valid || !match[0].ready ||
        match[0].unique!==unique || match[0].method!=='btree' || match[0].options!==options ||
        match[0].keys.map(normal).join(',')!==keys.join(',') ||
        normal(match[0].predicate?.replace(/[()]/g,'') ?? '')!==(predicate ?? '')) catalogError(name);
  }
  const functionBody = APPOINTMENT_PURPOSE_PROVENANCE_SQL.split('AS $$')[1]?.split('$$ LANGUAGE')[0]?.trim();
  const fn = objects.filter(item => item.kind === 'function' && item.name === 'aqlan_appointment_purpose_immutable');
  if (fn.length !== 1 || fn[0].target !== 'public' || fn[0].definition.trim() !== functionBody) catalogError('immutable function');
  const {rows:functions} = await client.query<{args:number;result:string;language:string;security_definer:boolean;config:string[]|null;kind:string;volatility:string;parallel:string;strict:boolean;leakproof:boolean}>(
    `SELECT p.pronargs AS args,p.prorettype::regtype::text AS result,l.lanname AS language,
      p.prosecdef AS security_definer,p.proconfig AS config,p.prokind AS kind,
      p.provolatile AS volatility,p.proparallel AS parallel,p.proisstrict AS strict,p.proleakproof AS leakproof
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
     WHERE n.nspname='public' AND p.proname='aqlan_appointment_purpose_immutable'`);
  const f=functions[0];
  if (functions.length!==1 || f.args!==0 || f.result!=='trigger' || f.language!=='plpgsql' ||
      f.security_definer || f.config!==null || f.kind!=='f' || f.volatility!=='v' ||
      f.parallel!=='u' || f.strict || f.leakproof) catalogError('immutable function metadata');
  const {rows:triggers} = await client.query<{name:string;target:string;enabled:string;type:number;qual:string|null;args:number;arg_bytes:string;function_name:string}>(
    `SELECT t.tgname AS name,c.relname AS target,t.tgenabled::text AS enabled,t.tgtype::int AS type,
      pg_get_expr(t.tgqual,t.tgrelid) AS qual,t.tgnargs AS args,encode(t.tgargs,'hex') AS arg_bytes,
      p.proname AS function_name
     FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace
     WHERE n.nspname='public' AND pn.nspname='public' AND NOT t.tgisinternal AND t.tgname IN
      ('appointment_purpose_immutable','appointment_purpose_no_nonempty_truncate')`);
  for (const [name,type] of [['appointment_purpose_immutable',27],
    ['appointment_purpose_no_nonempty_truncate',34]] as const) {
    const hits=triggers.filter(trigger=>trigger.name===name);
    if (hits.length!==1 || hits[0].target!=='appointment_purpose_provenance' || hits[0].enabled!=='O' ||
        hits[0].type!==type || hits[0].qual!==null || hits[0].args!==0 || hits[0].arg_bytes!=='' ||
        hits[0].function_name!=='aqlan_appointment_purpose_immutable') catalogError(name);
  }
  const {rows:cols} = await client.query<{column_name:string;udt_name:string;is_nullable:string;column_default:string|null}>(
    `SELECT column_name,udt_name,is_nullable,column_default FROM information_schema.columns
     WHERE table_schema='public' AND table_name='appointment_purpose_provenance'`);
  const expectedCols:Record<string,[string,string,string|null]> = {appointment_id:['int4','NO',null],patient_id:['int4','NO',null],
    purpose:['text','NO',null],source_plan_id:['int4','YES',null],source_planned_visit_id:['int4','YES',null],
    command_id:['uuid','YES',null],command_hash:['text','YES',null],actor_user_id:['int4','YES',null],
    recorded_at:['timestamptz','NO','clock_timestamp()'],recorded_by:['text','NO',null]};
  if (cols.length !== Object.keys(expectedCols).length || cols.some(col => {
    const expected=expectedCols[col.column_name];return !expected || col.udt_name!==expected[0] ||
      col.is_nullable!==expected[1] || col.column_default!==expected[2];
  })) catalogError('columns');
}
