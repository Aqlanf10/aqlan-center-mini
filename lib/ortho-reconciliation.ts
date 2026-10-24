import type { Client } from "pg";
import { catalogHash, readOrthoCatalog, readRegistryCatalog, ORTHO_VERSIONS, type OrthoVersion } from "./ortho-reconciliation-catalog";
import reference from "../schema/ortho-reconciliation-reference.pg18.json";
import contracts from "./ortho-assessment-runtime.generated.json";
import { MIGRATION_ADVISORY_LOCK_KEY } from "./migrations";

const NAME = /^aqlan_ortho_legacy_[a-f0-9]{32}_[a-z0-9]+$/;
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const tableFor = (version: OrthoVersion) => version === "0051" ? "ortho_strategy_revisions" : "ortho_assessment_revisions";
export class ReconciliationRefused extends Error {
  constructor(public readonly category: "target" | "catalog" | "registry" | "invariants" | "uncertain_commit") { super(`ORTHO_RECONCILIATION_${category.toUpperCase()}`); }
}

export async function reportOrthoReconciliation(client: Client) {
  const { rows: [server] } = await client.query("SELECT current_setting('server_version_num')::int AS version");
  if (Math.floor(server.version / 10000) !== 18 || catalogHash({ catalogs: reference.catalogs, registryCatalog: reference.registryCatalog, runtimeRegistry: reference.runtimeRegistry }) !== reference.digest) throw new ReconciliationRefused("catalog");
  const registry = (await client.query("SELECT version,name,checksum,adopted FROM public.schema_migrations ORDER BY version")).rows;
  if (catalogHash(await readRegistryCatalog(client)) !== catalogHash(reference.registryCatalog)) throw new ReconciliationRefused("registry");
  const required = reference.runtimeRegistry.filter(row => !["0051", "0052", "0067"].includes(row.version));
  const present = registry.filter(row => !["0051", "0052", "0067"].includes(row.version));
  if (JSON.stringify(required) !== JSON.stringify(present)) throw new ReconciliationRefused("registry");
  const optional = registry.find(row => row.version === "0067");
  if (optional && JSON.stringify(optional) !== JSON.stringify(reference.runtimeRegistry.find(row => row.version === "0067"))) throw new ReconciliationRefused("registry");
  const results = [];
  for (const version of ORTHO_VERSIONS) {
    const contract = contracts.find(file => file.version === version)!;
    if (reference.contracts.find(file => file.version === version)?.checksum !== contract.checksum) throw new ReconciliationRefused("catalog");
    const observed = await readOrthoCatalog(client, version);
    const digest = catalogHash(observed);
    const row = registry.find(row => row.version === version);
    const registryValid = !row || (row.name === contract.name && row.checksum === contract.checksum && row.adopted === false);
    const shape = !observed.length ? "absent" : digest === catalogHash(reference.catalogs[version]) ? "exact" : "unknown_or_partial";
    results.push({ version, shape, digest, registered: !!row, registryValid });
  }
  return { event: "ortho_reconciliation_report", results };
}

/** Evaluate only expressions from the checked-in synthetic reference, not SQL
 * supplied by the target. Counts and booleans only; no clinical rows leave DB.
 */
async function assertDataInvariants(client: Client, version: OrthoVersion) {
  const table = tableFor(version);
  const columns = reference.catalogs[version].filter(row => row.section === "column" && row.identity.startsWith(table + "."));
  const columnNames = new Map(columns.map(row => {
    const props = row.properties as Record<string, unknown>;
    return [Number(props.attnum), String(props.attname)];
  }));
  async function refuseIf(sql: string) {
    if ((await client.query<{ invalid: boolean }>(sql)).rows[0]?.invalid !== false) throw new ReconciliationRefused("invariants");
  }
  for (const column of columns) {
    const props = column.properties as Record<string, unknown>;
    if (props.attnotnull) await refuseIf(`SELECT EXISTS(SELECT 1 FROM public.${quote(table)} WHERE ${quote(String(props.attname))} IS NULL) AS invalid`);
  }
  for (const entry of reference.catalogs[version].filter(row => row.section === "constraint")) {
    const props = entry.properties as Record<string, unknown>;
    const definition = String(props.definition);
    const keys = ((props.conkey ?? []) as number[]).map(key => quote(columnNames.get(key)!));
    if (props.contype === "c") {
      if (!definition.startsWith("CHECK (")) throw new ReconciliationRefused("catalog");
      await refuseIf(`SELECT EXISTS(SELECT 1 FROM public.${quote(table)} WHERE (${definition.slice(6)}) IS FALSE) AS invalid`);
    } else if (props.contype === "p" || props.contype === "u") {
      await refuseIf(`SELECT EXISTS(SELECT 1 FROM public.${quote(table)} WHERE ${keys.map(key => `${key} IS NOT NULL`).join(" AND ")} GROUP BY ${keys.join(",")} HAVING count(*)>1) AS invalid`);
    } else if (props.contype === "f") {
      const match = /REFERENCES (?:public\.)?([a-z_]+)\(([^)]+)\)/.exec(definition);
      if (!match) throw new ReconciliationRefused("catalog");
      const refKeys = match[2].split(",").map(key => quote(key.trim()));
      await refuseIf(`SELECT EXISTS(SELECT 1 FROM public.${quote(table)} r WHERE ${keys.map(key => `r.${key} IS NOT NULL`).join(" AND ")} AND NOT EXISTS(SELECT 1 FROM public.${quote(match[1])} p WHERE ${keys.map((key, i) => `r.${key}=p.${refKeys[i]}`).join(" AND ")})) AS invalid`);
    }
  }
  await refuseIf(`SELECT EXISTS(SELECT 1 FROM public.${quote(table)} r WHERE NOT EXISTS (
    SELECT 1 FROM public.ortho_cases o JOIN public.clinical_cases c ON c.ortho_case_id=o.id
    WHERE o.id=r.ortho_case_id AND c.id=r.clinical_case_id AND o.patient_id=r.patient_id AND c.patient_id=r.patient_id)
    OR (r.supersedes_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.${quote(table)} p
      WHERE p.id=r.supersedes_revision_id AND p.ortho_case_id=r.ortho_case_id AND p.clinical_case_id=r.clinical_case_id
      AND p.version=r.version-1 ${version === "0052" ? "AND p.schema_version<=r.schema_version" : ""}))) AS invalid`);
  if (version === "0052") {
    await refuseIf(`SELECT EXISTS(SELECT 1 FROM public.ortho_assessment_revisions r WHERE schema_version=2 AND (
      content->'schemaVersion' IS DISTINCT FROM '2'::jsonb OR content->>'verifierVersion' IS DISTINCT FROM 'ortho-assessment-payload-2.1.0'
      OR jsonb_typeof(content->'draft') IS DISTINCT FROM 'object' OR content->'draft'->'schemaVersion' IS DISTINCT FROM '2'::jsonb
      OR jsonb_typeof(content->'results') IS DISTINCT FROM 'array' OR jsonb_typeof(content->'draft'->'analyses') IS DISTINCT FROM 'array')) AS invalid`);
    await refuseIf(`SELECT EXISTS(SELECT 1 FROM public.ortho_assessment_revisions r WHERE schema_version=2 AND (
      jsonb_array_length(content->'results')>36 OR jsonb_array_length(content->'results')<>jsonb_array_length(content->'draft'->'analyses')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(content->'results') WITH ORDINALITY e(entry,n)
        CROSS JOIN LATERAL (SELECT content->'draft'->'analyses'->(n::int-1) selection) s WHERE
        jsonb_typeof(entry) IS DISTINCT FROM 'object' OR jsonb_typeof(entry->'result') IS DISTINCT FROM 'object'
        OR jsonb_typeof(selection) IS DISTINCT FROM 'object' OR jsonb_typeof(selection->'id') IS DISTINCT FROM 'string'
        OR COALESCE(selection->>'id','') !~ '^[A-Za-z0-9_-]{1,80}$' OR jsonb_typeof(entry->'analysisId') IS DISTINCT FROM 'string'
        OR entry->>'analysisId' IS DISTINCT FROM selection->>'id' OR selection->>'state' IS DISTINCT FROM 'draft'
        OR COALESCE(entry->>'resultHash','') !~ '^[a-f0-9]{64}$')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(content->'draft'->'analyses') a GROUP BY a->>'id' HAVING count(*)>1))) AS invalid`);
  }
  await refuseIf(`SELECT COALESCE((SELECT max(id) FROM public.${quote(table)}) >=
    (SELECT last_value + CASE WHEN is_called THEN 1 ELSE 0 END FROM public.${quote(table + "_id_seq")}), false) AS invalid`);
}

/** Synthetic-only prototype. Exact operator identity and fixture capability are
 * mandatory even for an empty database. Never called by startup or migrations.
 */
export async function applySyntheticOrthoReconciliation(client: Client, expected: { database: string; oid: string; capability: string }) {
  if (!NAME.test(expected.database) || !/^\d+$/.test(expected.oid) || !/^[a-f0-9]{64}$/.test(expected.capability)) throw new ReconciliationRefused("target");
  let committing = false;
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL search_path = pg_catalog, public");
    await client.query("SET LOCAL lock_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
    const { rows: [identity] } = await client.query("SELECT current_database() AS name,d.oid::text,pg_get_userbyid(d.datdba)=current_user AS owned,r.rolsuper FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()");
    if (identity?.name !== expected.database || identity?.oid !== expected.oid || !identity?.owned || !identity?.rolsuper) throw new ReconciliationRefused("target");
    const { rows: [marker] } = await client.query("SELECT capability FROM public.ortho_synthetic_reconciliation_target");
    if (marker?.capability !== expected.capability) throw new ReconciliationRefused("target");
    // Dedicated synthetic server only: catalog locks close CREATE OR REPLACE
    // FUNCTION / ACL / ownership drift windows which relation locks cannot close.
    await client.query(`LOCK TABLE pg_catalog.pg_class,pg_catalog.pg_attribute,pg_catalog.pg_attrdef,
      pg_catalog.pg_constraint,pg_catalog.pg_index,pg_catalog.pg_trigger,pg_catalog.pg_proc,
      pg_catalog.pg_type,pg_catalog.pg_depend,pg_catalog.pg_shdepend,pg_catalog.pg_sequence,
      pg_catalog.pg_collation,pg_catalog.pg_namespace,pg_catalog.pg_authid,pg_catalog.pg_database,
      pg_catalog.pg_rewrite,pg_catalog.pg_policy,pg_catalog.pg_event_trigger,pg_catalog.pg_seclabel IN SHARE MODE`);
    await client.query("LOCK TABLE public.schema_migrations, public.ortho_synthetic_reconciliation_target IN ACCESS EXCLUSIVE MODE");
    const { rows: [lockedIdentity] } = await client.query("SELECT current_database() AS name,d.oid::text,pg_get_userbyid(d.datdba)=current_user AS owned FROM pg_database d WHERE d.datname=current_database()");
    if (lockedIdentity?.name !== expected.database || lockedIdentity?.oid !== expected.oid || !lockedIdentity?.owned) throw new ReconciliationRefused("target");
    const markers = (await client.query("SELECT capability FROM public.ortho_synthetic_reconciliation_target")).rows;
    if (markers.length !== 1 || markers[0].capability !== expected.capability) throw new ReconciliationRefused("target");
    if ((await client.query("SELECT EXISTS(SELECT 1 FROM pg_event_trigger) AS present")).rows[0].present) throw new ReconciliationRefused("catalog");
    const report = await reportOrthoReconciliation(client);
    if (report.results.some(row => !row.registryValid)) throw new ReconciliationRefused("registry");
    if (report.results.some(row => row.shape === "unknown_or_partial" || (row.registered && row.shape !== "exact"))) throw new ReconciliationRefused("catalog");
    const pending = report.results.filter(row => !row.registered && row.shape === "exact");
    if (!pending.length) throw new ReconciliationRefused("registry");
    // Refuse pre-existing audit objects; this prototype writes a single pair of
    // records once. Re-run is report-only, never retry an uncertain commit.
    if ((await client.query("SELECT to_regclass('public.ortho_reconciliation_records') IS NOT NULL AS present")).rows[0].present) throw new ReconciliationRefused("registry");
    for (const row of pending) await client.query(`LOCK TABLE public.${quote(tableFor(row.version))},public.patients,public.users,public.ortho_cases,public.clinical_cases IN SHARE ROW EXCLUSIVE MODE`);
    // PostgreSQL does not support LOCK TABLE on sequences. Reassert the already
    // verified OWNED BY dependency to obtain ALTER SEQUENCE's transaction lock;
    // do not RESTART, setval, change parameters or consume a sequence value.
    // This blocks independent nextval/setval calls as well as table inserts.
    for (const row of pending) {
      const table = tableFor(row.version);
      await client.query(`ALTER SEQUENCE public.${quote(table + "_id_seq")} OWNED BY public.${quote(table)}.id`);
    }
    for (const row of pending) await assertDataInvariants(client, row.version);
    await client.query(`CREATE TABLE public.ortho_reconciliation_records (
      version text PRIMARY KEY CHECK (version IN ('0051','0052')), checksum text NOT NULL,
      catalog_digest text NOT NULL, source_commit text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
      evidence_kind text NOT NULL CHECK(evidence_kind='catalog_equivalence'),
      historical_execution_verified boolean NOT NULL CHECK(historical_execution_verified=false),
      operator_name name NOT NULL DEFAULT current_user,
      reason text NOT NULL CHECK(reason='explicit_synthetic_reconciliation'))`);
    const revalidated = await reportOrthoReconciliation(client);
    if (JSON.stringify(revalidated) !== JSON.stringify(report)) throw new ReconciliationRefused("catalog");
    for (const row of pending) {
      const contract = contracts.find(file => file.version === row.version)!;
      await client.query(`INSERT INTO public.ortho_reconciliation_records(version,checksum,catalog_digest,source_commit,evidence_kind,historical_execution_verified,reason)
        VALUES($1,$2,$3,$4,'catalog_equivalence',false,'explicit_synthetic_reconciliation')`, [row.version, contract.checksum, row.digest, reference.source]);
      await client.query("INSERT INTO public.schema_migrations(version,name,checksum,adopted) VALUES($1,$2,$3,false)", [row.version, contract.name, contract.checksum]);
    }
    committing = true;
    await client.query("COMMIT");
    return { event: "ortho_synthetic_reconciliation_recorded", versions: pending.map(row => row.version), historicalExecutionVerified: false };
  } catch (error) {
    if (committing) throw new ReconciliationRefused("uncertain_commit");
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}
