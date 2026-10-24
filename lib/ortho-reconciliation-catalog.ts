import { createHash } from "node:crypto";
import type { Client } from "pg";
import contracts from "./ortho-assessment-runtime.generated.json";

export const ORTHO_REFERENCE_SOURCE = "c998b435306f8295a217e49f20080293c479c359";
export const ORTHO_VERSIONS = ["0051", "0052"] as const;
export type OrthoVersion = typeof ORTHO_VERSIONS[number];
export const catalogHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Catalog observations, not a data-invariant or historical-execution witness.
 * No target DDL, scratch schemas, target function calls or target row contents.
 * Raw function text is preserved: whitespace inside SQL literals is significant.
 */
export async function readOrthoCatalog(client: Client, version: OrthoVersion) {
  const stem = version === "0051" ? "strategy" : "assessment";
  const table = `ortho_${stem}_revisions`;
  const names = [table, `${table}_id_seq`, `${table}_pkey`, `_${table}`,
    `ortho_${stem}_patient_case_version_idx`, `reject_ortho_${stem}_revision_mutation`,
    `check_ortho_${stem}_revision_final_state`,
    // Keep the complete guard scope: these names can be occupied by standalone
    // relations, types or routines even when the revision table is absent.
    ...[...contracts.find(file => file.version === version)!.sql.matchAll(/\bCONSTRAINT\s+([a-z_][a-z0-9_]*)/g)].map(match => match[1])];
  return readCatalog(client, table, names);
}

export async function readRegistryCatalog(client: Client) {
  return readCatalog(client, "schema_migrations", ["schema_migrations", "schema_migrations_pkey", "_schema_migrations"]);
}

export async function readReconciliationAuditCatalog(client: Client) {
  return readCatalog(client, "audit_log", ["audit_log", "_audit_log", "audit_log_id_seq", "audit_log_is_append_only"]);
}

async function readCatalog(client: Client, table: string, names: string[]) {
  const { rows } = await client.query<{ section: string; identity: string; properties: unknown }>(`
    WITH rels AS (
      SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND (c.relname=ANY($1::text[]) OR c.oid IN (
        SELECT indexrelid FROM pg_catalog.pg_index WHERE indrelid=to_regclass('public.' || $2)))
    ), funcs AS (
      SELECT p.* FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname=ANY($1::text[])
    ), types AS (
      SELECT t.* FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='public' AND (t.typname=ANY($1::text[]) OR t.typrelid IN (SELECT oid FROM rels))
    ), cons AS (
      SELECT c.* FROM pg_catalog.pg_constraint c WHERE c.conrelid IN (SELECT oid FROM rels)
        OR c.confrelid IN (SELECT oid FROM rels)
    ), trigs AS (
      SELECT t.* FROM pg_catalog.pg_trigger t WHERE t.tgrelid IN (SELECT oid FROM rels)
        OR t.tgconstraint IN (SELECT oid FROM cons)
    ), nodes AS (
      SELECT 'pg_class'::regclass::oid classid, oid objid FROM rels
      UNION SELECT 'pg_proc'::regclass::oid, oid FROM funcs
      UNION SELECT 'pg_type'::regclass::oid, oid FROM types
      UNION SELECT 'pg_constraint'::regclass::oid, oid FROM cons
      UNION SELECT 'pg_trigger'::regclass::oid, oid FROM trigs
      UNION SELECT 'pg_attrdef'::regclass::oid, oid FROM pg_catalog.pg_attrdef WHERE adrelid IN (SELECT oid FROM rels)
      UNION SELECT 'pg_rewrite'::regclass::oid, oid FROM pg_catalog.pg_rewrite WHERE ev_class IN (SELECT oid FROM rels)
      UNION SELECT 'pg_policy'::regclass::oid, oid FROM pg_catalog.pg_policy WHERE polrelid IN (SELECT oid FROM rels)
    ), observations AS (
      SELECT 'relation' section, c.relname::text identity,
        (to_jsonb(c)-ARRAY['oid','relnamespace','relowner','reltype','reloftype','relfilenode','reltablespace','relpages','reltuples','relallvisible','relallfrozen','reltoastrelid','relfrozenxid','relminmxid','relrewrite','relam']) ||
        jsonb_build_object('owner',pg_get_userbyid(c.relowner),'am',(SELECT amname FROM pg_catalog.pg_am WHERE oid=c.relam),
          'tablespace',(SELECT spcname FROM pg_catalog.pg_tablespace WHERE oid=c.reltablespace),
          'toast_options',(SELECT reloptions FROM pg_catalog.pg_class WHERE oid=c.reltoastrelid)) properties FROM rels c
      UNION ALL SELECT 'column', c.relname || '.' || a.attnum,
        (to_jsonb(a)-ARRAY['attrelid','atttypid','attcollation']) || jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),
          'collation',(SELECT (to_jsonb(co)-'oid') || jsonb_build_object('schema',ns.nspname) FROM pg_catalog.pg_collation co JOIN pg_catalog.pg_namespace ns ON ns.oid=co.collnamespace WHERE co.oid=a.attcollation))
        FROM pg_catalog.pg_attribute a JOIN rels c ON c.oid=a.attrelid WHERE a.attnum>0
      UNION ALL SELECT 'default', c.relname || '.' || a.adnum, to_jsonb(pg_get_expr(a.adbin,a.adrelid,false))
        FROM pg_catalog.pg_attrdef a JOIN rels c ON c.oid=a.adrelid
      UNION ALL SELECT 'constraint', (pg_identify_object('pg_constraint'::regclass,c.oid,0)).identity,
        (to_jsonb(c)-ARRAY['oid','connamespace','conrelid','confrelid','conindid','conparentid','conbin']) || jsonb_build_object('definition',pg_get_constraintdef(c.oid,false)) FROM cons c
      UNION ALL SELECT 'index', (pg_identify_object('pg_class'::regclass,i.indexrelid,0)).identity,
        (to_jsonb(i)-ARRAY['indexrelid','indrelid','indexprs','indpred']) || jsonb_build_object('definition',pg_get_indexdef(i.indexrelid))
        FROM pg_catalog.pg_index i WHERE i.indexrelid IN (SELECT oid FROM rels)
      UNION ALL SELECT 'trigger', regexp_replace((pg_identify_object('pg_trigger'::regclass,t.oid,0)).identity,'RI_ConstraintTrigger_([ac])_[0-9]+','RI_ConstraintTrigger_\\1_ID','g'),
        (to_jsonb(t)-ARRAY['oid','tgname','tgrelid','tgparentid','tgfoid','tgconstraint','tgconstrrelid','tgconstrindid','tgqual']) ||
        jsonb_build_object('definition',regexp_replace(pg_get_triggerdef(t.oid,false),'RI_ConstraintTrigger_([ac])_[0-9]+','RI_ConstraintTrigger_\\1_ID','g')) FROM trigs t
      UNION ALL SELECT 'function', (pg_identify_object('pg_proc'::regclass,p.oid,0)).identity,
        (to_jsonb(p)-ARRAY['oid','pronamespace','proowner']) || jsonb_build_object('owner',pg_get_userbyid(p.proowner),'definition',pg_get_functiondef(p.oid)) FROM funcs p
      UNION ALL SELECT 'type', t.typname,
        (to_jsonb(t)-ARRAY['oid','typnamespace','typowner','typrelid','typelem','typarray']) || jsonb_build_object('owner',pg_get_userbyid(t.typowner),
        'relation',(SELECT relname FROM rels WHERE oid=t.typrelid),'element',format_type(t.typelem,NULL),'array',format_type(t.typarray,NULL)) FROM types t
      UNION ALL SELECT 'sequence', c.relname, to_jsonb(s)-'seqrelid' FROM pg_catalog.pg_sequence s JOIN rels c ON c.oid=s.seqrelid
      UNION ALL SELECT 'dependency', regexp_replace((pg_identify_object(d.classid,d.objid,d.objsubid)).identity,'RI_ConstraintTrigger_([ac])_[0-9]+','RI_ConstraintTrigger_\\1_ID','g'),
        jsonb_build_object('kind',d.deptype,'type',(pg_identify_object(d.classid,d.objid,d.objsubid)).type,
          'reference',regexp_replace((pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid)).identity,'RI_ConstraintTrigger_([ac])_[0-9]+','RI_ConstraintTrigger_\\1_ID','g'),
          'reference_type',(pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid)).type)
        FROM pg_catalog.pg_depend d WHERE EXISTS (SELECT 1 FROM nodes n WHERE (n.classid=d.classid AND n.objid=d.objid) OR (n.classid=d.refclassid AND n.objid=d.refobjid))
      UNION ALL SELECT 'shared_dependency', (pg_identify_object(d.classid,d.objid,0)).identity,
        jsonb_build_object('kind',d.deptype,'reference',(pg_identify_object(d.refclassid,d.refobjid,0)).identity)
        FROM pg_catalog.pg_shdepend d WHERE d.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
          AND EXISTS(SELECT 1 FROM nodes n WHERE n.classid=d.classid AND n.objid=d.objid)
      UNION ALL SELECT 'policy', (pg_identify_object('pg_policy'::regclass,p.oid,0)).identity, to_jsonb(p)-ARRAY['oid','polrelid'] FROM pg_catalog.pg_policy p WHERE p.polrelid IN (SELECT oid FROM rels)
      UNION ALL SELECT 'rule', (pg_identify_object('pg_rewrite'::regclass,r.oid,0)).identity, jsonb_build_object('definition',pg_get_ruledef(r.oid,false)) FROM pg_catalog.pg_rewrite r WHERE r.ev_class IN (SELECT oid FROM rels)
      UNION ALL SELECT 'security_label', (pg_identify_object(s.classoid,s.objoid,s.objsubid)).identity,
        jsonb_build_object('provider',s.provider,'label',s.label) FROM pg_catalog.pg_seclabel s
        WHERE EXISTS(SELECT 1 FROM nodes n WHERE n.classid=s.classoid AND n.objid=s.objoid)
      UNION ALL SELECT 'database_locale','database',jsonb_build_object('encoding',d.encoding,'provider',d.datlocprovider,
        'collation',d.datcollate,'ctype',d.datctype,'locale',d.datlocale,'rules',d.daticurules,'version',d.datcollversion)
        FROM pg_catalog.pg_database d WHERE d.datname=current_database() AND EXISTS(SELECT 1 FROM nodes)
      UNION ALL SELECT 'schema_security','public',jsonb_build_object('owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl)
        FROM pg_catalog.pg_namespace n WHERE n.nspname='public' AND EXISTS(SELECT 1 FROM nodes)
    ) SELECT * FROM observations ORDER BY section COLLATE "C", identity COLLATE "C", properties::text COLLATE "C"
  `, [names, table]);
  return rows.map(row => {
    const properties = row.properties as Record<string, unknown>;
    return row.section === "dependency" && properties.type === "toast table"
      ? { ...row, identity: `toast:${properties.reference}` } : row;
  }).sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
