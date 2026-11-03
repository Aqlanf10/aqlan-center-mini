import { createHash } from "node:crypto";
import { IDENTITY_TABLES, staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { EXPECTED_SUBSTRATE_CATALOGUE } from "./staff-identity-substrate-catalogue.mjs";
const CORE_FUNCTIONS = ["staff_authority_control_guard", "staff_account_authority_epoch_guard", "staff_clinical_authority_epoch_guard"];
const FUNCTIONS = [...CORE_FUNCTIONS, "staff_identity_history_guard", "staff_identity_state_guard", "staff_identity_subject_guard", "staff_identity_event_guard", "staff_identity_current_guard"];
const TABLES = [...IDENTITY_TABLES, "staff_authority_control"];
function normalize(value, schema) {
  if (typeof value === "string") return value.replaceAll(`"${schema}".`, "$SCHEMA.").replaceAll(`${schema}.`, "$SCHEMA.")
    .replaceAll(`pg_catalog, ${schema}`, "pg_catalog, $SCHEMA")
    .replace(/\b(REFERENCES|ON) (staff_identity_\w+|staff_authority_control|users)\b/g, "$1 $SCHEMA.$2");
  if (Array.isArray(value)) return value.map(v => normalize(v, schema));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,normalize(v,schema)]));
  return value;
}
/** Diagnostics only. Never installs, adopts or repairs a candidate schema. */
export async function readStaffIdentitySubstrateCatalogue(source, schema = "public") {
  const s = staffIdentitySchemaName(schema);
  const { rows: relations } = await source.query(`SELECT c.relname,c.relkind,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname`, [s,[...TABLES,"users","parties"]]);
  const { rows: columns } = await source.query(`SELECT c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,a.attidentity,a.attgenerated,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped AND
    (c.relname=ANY($2::text[]) OR (c.relname='users' AND a.attname=ANY(ARRAY['id','authorization_mode','authorization_epoch'])) OR (c.relname='parties' AND a.attname=ANY(ARRAY['id','clinical_authority_epoch'])))
    ORDER BY c.relname,a.attname`, [s,TABLES]);
  // users.id/parties.id SERIAL defaults are accepted by OID provenance, never by text:
  // the default must depend on exactly one object, a sequence in THIS schema, owned by
  // this very column, and render as nextval of that sequence. A same-name foreign
  // sequence, search-path substitution or detached ownership keeps its raw text and
  // therefore fails the exact catalogue comparison.
  const { rows: serials } = await source.query(`SELECT c.relname,a.attname,pg_catalog.pg_get_expr(ad.adbin,ad.adrelid) AS expr,
    (SELECT count(*) FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_attrdef'::regclass AND d.objid=ad.oid AND d.deptype='n')::int AS refs,
    seq.relname AS seq_name, seq.relkind::text AS seq_kind, sn.nspname AS seq_schema,
    EXISTS(SELECT 1 FROM pg_catalog.pg_depend o WHERE o.classid='pg_catalog.pg_class'::regclass AND o.objid=seq.oid
     AND o.refclassid='pg_catalog.pg_class'::regclass AND o.refobjid=c.oid AND o.refobjsubid=a.attnum AND o.deptype='a') AS owned
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname='id' AND NOT a.attisdropped
    JOIN pg_catalog.pg_attrdef ad ON ad.adrelid=c.oid AND ad.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_depend dd ON dd.classid='pg_catalog.pg_attrdef'::regclass AND dd.objid=ad.oid AND dd.deptype='n' AND dd.refclassid='pg_catalog.pg_class'::regclass
    LEFT JOIN pg_catalog.pg_class seq ON seq.oid=dd.refobjid LEFT JOIN pg_catalog.pg_namespace sn ON sn.oid=seq.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY(ARRAY['users','parties'])`, [s]);
  for (const column of columns) {
    if (column.attname !== "id" || !["users","parties"].includes(column.relname) || column.default_value === null) continue;
    const proof = serials.filter(row => row.relname === column.relname);
    const seq = `${column.relname}_id_seq`;
    const rendered = [`nextval('${seq}'::regclass)`, `nextval('${s}.${seq}'::regclass)`, `nextval('"${s}".${seq}'::regclass)`];
    if (proof.length === 1 && proof[0].refs === 1 && proof[0].seq_kind === "S" && proof[0].seq_schema === s && proof[0].seq_name === seq
      && proof[0].owned === true && proof[0].expr === column.default_value && rendered.includes(column.default_value)) column.default_value = "$OWNED_SERIAL";
    else column.default_value = `$UNPROVEN:${column.default_value}`;
  }
  const { rows: constraints } = await source.query(`SELECT c.relname,k.conname,k.contype,k.convalidated,k.condeferrable,k.condeferred,
    pg_catalog.pg_get_constraintdef(k.oid,true) AS definition FROM pg_catalog.pg_constraint k
    JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,k.conname`, [s,TABLES]);
  const { rows: indexes } = await source.query(`SELECT c.relname,ci.relname AS index_name,i.indisvalid,i.indisready,i.indisunique,i.indisprimary,
    pg_catalog.pg_get_indexdef(i.indexrelid,0,true) AS definition FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
    JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname,ci.relname`, [s,TABLES]);
  const { rows: triggers } = await source.query(`SELECT c.relname,t.tgname,t.tgtype,t.tgenabled,t.tgdeferrable,t.tginitdeferred,
    t.tgnargs,encode(t.tgargs,'hex') AS args,t.tgattr::text AS attrs,pg_catalog.pg_get_expr(t.tgqual,t.tgrelid) AS condition,
    p.proname, pn.nspname AS function_schema FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE NOT t.tgisinternal AND n.nspname=$1 AND (c.relname=ANY($2::text[]) OR t.tgname=ANY(ARRAY['staff_account_authority_epoch','staff_clinical_authority_epoch']))
    ORDER BY c.relname,t.tgname`, [s,TABLES]);
  for (const row of triggers) if (row.function_schema===s) row.function_schema="$SCHEMA";
  const { rows: functions } = await source.query(`SELECT p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_catalog.format_type(p.prorettype,NULL) AS returns,l.lanname,p.prokind,p.prosecdef,p.provolatile,p.proisstrict,p.proleakproof,p.proparallel,p.proconfig,p.prosrc
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND p.proname=ANY($2::text[]) ORDER BY p.proname,arguments`,[s,FUNCTIONS]);
  return normalize({relations,columns,constraints,indexes,triggers,functions},s);
}
/** Exact known definition contract, not a table-name or marker-only check. */
export async function inspectStaffIdentitySubstrate(source, schema = "public") {
  const s=staffIdentitySchemaName(schema);
  const {rows:old}=await source.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relname=ANY(ARRAY['staff_authority_identity','staff_execution_epochs'])
    UNION ALL SELECT a.attname FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='users' AND a.attname='staff_subject_id' AND NOT a.attisdropped`,[s]);
  if(old.length) throw new Error("STAFF_IDENTITY_PARALLEL_SCHEMA_REFUSED");
  const actual=await readStaffIdentitySubstrateCatalogue(source,s);
  if (JSON.stringify(actual)!==JSON.stringify(EXPECTED_SUBSTRATE_CATALOGUE)) throw new Error("STAFF_IDENTITY_SCHEMA_DRIFT");
  return Object.freeze({version:1,schema:s,fingerprint:createHash("sha256").update(JSON.stringify(actual)).digest("hex")});
}
