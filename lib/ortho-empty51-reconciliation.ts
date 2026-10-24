import type { Client } from "pg";
import { languageSourceStructure } from "./ortho-language-contract";
import { catalogHash, readOrthoCatalog, readRegistryCatalog, readReconciliationAuditCatalog, ORTHO_REFERENCE_SOURCE } from "./ortho-reconciliation-catalog";
import pinned from "../schema/ortho-empty51-reference.pg18.json";
import runtime from "../schema/ortho-reconciliation-reference.pg18.json";
import contracts from "./ortho-assessment-runtime.generated.json";
import { MIGRATION_ADVISORY_LOCK_KEY } from "./migrations";
import { configureOperatorTimeouts } from "./ortho-reconciliation-limits";
import { ReconciliationRefused } from "./ortho-reconciliation";
import { OperatorCleanupFailure } from "./ortho-reconciliation-session";

type Catalog = Awaited<ReturnType<typeof readOrthoCatalog>>;
export type Empty51Reference = { source: string; catalog: Catalog; registryCatalog: Catalog; auditCatalog: Catalog };
export type Empty51Approval = {
  environment: "staging";
  endpoint: { host: string; port: number; database: string; user: string };
  identity: { database: string; oid: string; owner: string; role: string; serverAddress: string; serverPort: number; version: string };
  reviewedReferenceDigest: string;
  approvalId: string;
  actionId: string;
  window?: { from: string; until: string; noApplicationOrDDLOrSequenceCallers: boolean; preserveAuditAndRegistry: boolean };
};
export const EMPTY51_EVENT = "schema.ortho_0051_catalog_reconciled";
const contract = contracts.find(row => row.version === "0051")!;
const predecessors = runtime.runtimeRegistry.filter(row => !["0051", "0052", "0067"].includes(row.version));
const digest = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9_-]{8,100}$/;

/** This projection checks source structure only. It is NEVER an equivalence
 * check: every security/locale value below is subsequently compared verbatim
 * against the separately approved, isolated reference, including ACLs/owners.
 */
function structure(catalog: Catalog) {
  return catalog.filter(row => !["database_locale", "schema_security", "shared_dependency"].includes(row.section)).map(row => {
    if (!row.properties || typeof row.properties !== "object") return row;
    const properties = { ...row.properties as Record<string, unknown> };
    if (["relation", "function", "type"].includes(row.section)) {
      delete properties.owner;
      for (const key of ["relacl", "proacl", "typacl"]) delete properties[key];
    }
    if (row.section === "function" && properties.prolang && typeof properties.prolang === "object") {
      properties.prolang = languageSourceStructure(properties.prolang as Record<string, unknown>);
    }
    // Collation is not normalized: incompatible isolated references fail closed.
    return { ...row, properties };
  });
}
export function validateEmpty51Approval(approval: Empty51Approval, reference: Empty51Reference, apply = false) {
  if (approval.environment !== "staging" || !identifier.test(approval.approvalId) || !identifier.test(approval.actionId)
      || !digest.test(approval.reviewedReferenceDigest) || catalogHash(reference) !== approval.reviewedReferenceDigest
      || reference.source !== ORTHO_REFERENCE_SOURCE || reference.source !== pinned.source) throw new ReconciliationRefused("target");
  const endpoint = approval.endpoint, identity = approval.identity;
  if (!endpoint.host || /[\s/*]/.test(endpoint.host) || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535
      || !endpoint.database || !endpoint.user || identity.database !== endpoint.database || identity.role !== endpoint.user
      || !/^\d+$/.test(identity.oid) || !identity.owner || !identity.serverAddress || !Number.isInteger(identity.serverPort)
      || !/^18\d{4}$/.test(identity.version)) throw new ReconciliationRefused("target");
  for (const key of ["catalog", "registryCatalog", "auditCatalog"] as const) {
    if (catalogHash(structure(reference[key])) !== catalogHash(structure(pinned[key]))) throw new ReconciliationRefused("catalog");
  }
  // Observation is not approval: read-only reporting does not require a
  // maintenance assertion, even when writers are active. Apply always does.
  if (!apply) return;
  if (!approval.window) throw new ReconciliationRefused("target");
  const from = Date.parse(approval.window.from), until = Date.parse(approval.window.until), now = Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(until) || now < from || now >= until || until - from > 30 * 60_000
      || approval.window.noApplicationOrDDLOrSequenceCallers !== true || approval.window.preserveAuditAndRegistry !== true) throw new ReconciliationRefused("target");
}

/** Read-only metadata query; root collects and reviews this separately. No
 * cluster-control function / elevated catalog access is required. Endpoint TLS
 * identity is additionally bound by the CLI and reviewed configuration.
 */
export const EMPTY51_IDENTITY_SQL = `SELECT current_database() AS database,d.oid::text,
 pg_get_userbyid(d.datdba) AS owner,current_user AS role,inet_server_addr()::text AS "serverAddress",
 inet_server_port() AS "serverPort",current_setting('server_version_num') AS version
 FROM pg_catalog.pg_database d WHERE d.datname=current_database()`;

async function inspect(client: Client, approval: Empty51Approval, reference: Empty51Reference, apply: boolean, recorded = false) {
  validateEmpty51Approval(approval, reference, apply);
  const identity = (await client.query(EMPTY51_IDENTITY_SQL)).rows;
  if (identity.length !== 1 || Object.entries(approval.identity).some(([key, value]) => identity[0][key] !== value)) throw new ReconciliationRefused("target");
  if ((await client.query("SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger) AS present")).rows[0]?.present !== false) throw new ReconciliationRefused("catalog");
  const registry = (await client.query("SELECT version,name,checksum,adopted FROM public.schema_migrations ORDER BY version")).rows;
  const expectedRegistry = recorded ? [{ version: "0051", name: contract.name, checksum: contract.checksum, adopted: false }, ...predecessors] : predecessors;
  if (catalogHash(registry) !== catalogHash(expectedRegistry)) throw new ReconciliationRefused("registry");
  if ((await client.query("SELECT to_regclass('public.appointments_patient_history_idx') IS NOT NULL AS present")).rows[0]?.present !== false) throw new ReconciliationRefused("catalog");
  if ((await readOrthoCatalog(client, "0052")).length !== 0) throw new ReconciliationRefused("catalog");
  for (const [actual, expected] of [
    [await readOrthoCatalog(client, "0051"), reference.catalog],
    [await readRegistryCatalog(client), reference.registryCatalog],
    [await readReconciliationAuditCatalog(client), reference.auditCatalog],
  ]) if (catalogHash(actual) !== catalogHash(expected)) throw new ReconciliationRefused("catalog");
  // RLS is forbidden even if the approved reference contains it: empty must mean
  // globally empty, not empty for a restricted operator's visibility.
  const visibility = (await client.query(`SELECT bool_and(NOT relrowsecurity AND NOT relforcerowsecurity) AS safe
    FROM pg_catalog.pg_class WHERE oid IN ('public.ortho_strategy_revisions'::regclass,'public.schema_migrations'::regclass,'public.audit_log'::regclass)`)).rows[0];
  if (visibility?.safe !== true) throw new ReconciliationRefused("catalog");
  const empty = (await client.query("SELECT NOT EXISTS(SELECT 1 FROM public.ortho_strategy_revisions) AS empty")).rows[0]?.empty;
  if (empty !== true) throw new ReconciliationRefused("invariants");
  const sequence = (await client.query(`SELECT s.last_value::text,s.is_called,
    (s.last_value >= p.seqmin AND s.last_value <= p.seqmax AND (NOT s.is_called OR s.last_value::numeric + p.seqincrement <= p.seqmax)) AS valid
    FROM public.ortho_strategy_revisions_id_seq s CROSS JOIN pg_catalog.pg_sequence p
    WHERE p.seqrelid='public.ortho_strategy_revisions_id_seq'::regclass`)).rows[0];
  if (sequence?.valid !== true) throw new ReconciliationRefused("invariants");
  if ((await client.query("SELECT EXISTS(SELECT 1 FROM public.audit_log WHERE action=$1 AND details->>'action_id'=$2) AS present", [EMPTY51_EVENT, approval.actionId])).rows[0]?.present !== recorded) throw new ReconciliationRefused("registry");
  return { event: "ortho_empty51_report", scope: "point_in_time_nonapproval", applyApproved: false,
    sequenceObservation: "nontransactional_unlocked", version: "0051", referenceDigest: approval.reviewedReferenceDigest,
    sequence: { last_value: sequence.last_value as string, is_called: sequence.is_called as boolean } };
}

export async function reconcileEmpty51(client: Client, approval: Empty51Approval, reference: Empty51Reference, apply = false) {
  validateEmpty51Approval(approval, reference, apply);
  await configureOperatorTimeouts(client);
  await client.query(apply ? "BEGIN ISOLATION LEVEL READ COMMITTED" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  let committing = false;
  try {
    await client.query("SET LOCAL search_path = pg_catalog, public");
    if (apply) {
      // First check before waiting; again after ordinary locks, and just before
      // inserting. Maintenance is a required external witness, NOT inferred
      // from these locks (functions/ACLs/sequence calls are not protected).
      await inspect(client, approval, reference, apply);
      await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_ADVISORY_LOCK_KEY]);
      await client.query("LOCK TABLE public.schema_migrations, public.audit_log IN SHARE ROW EXCLUSIVE MODE");
      await client.query("LOCK TABLE public.ortho_strategy_revisions IN SHARE MODE");
    }
    const report = await inspect(client, approval, reference, apply);
    if (!apply) { await client.query("ROLLBACK"); return report; }
    const evidence = { format: 1, evidence_kind: "catalog_equivalence", historical_execution_verified: false,
      version: "0051", name: contract.name, checksum: contract.checksum, source_commit: ORTHO_REFERENCE_SOURCE,
      reference_digest: approval.reviewedReferenceDigest, empty_row_count: 0, original_sequence: report.sequence,
      source_target: approval.identity, action_id: approval.actionId, approval_id: approval.approvalId,
      maintenance_window: approval.window, operator: approval.identity.role };
    const final = await inspect(client, approval, reference, apply);
    if (catalogHash(final) !== catalogHash(report)) throw new ReconciliationRefused("invariants");
    await client.query(`INSERT INTO public.audit_log(action,entity,entity_id,summary,details,actor,actor_role)
      VALUES($1,'schema_migrations','0051','Explicit empty 0051 catalog equivalence; historical execution unknown',$2,current_user,'database_operator')`, [EMPTY51_EVENT, JSON.stringify(evidence)]);
    await client.query("INSERT INTO public.schema_migrations(version,name,checksum,adopted) VALUES($1,$2,$3,false)", ["0051", contract.name, contract.checksum]);
    // Revalidate the full catalog/empty/sequence/target contract after both
    // writes as well; registry and audit now must describe this atomic action.
    const after = await inspect(client, approval, reference, apply, true);
    if (catalogHash(after) !== catalogHash(report)) throw new ReconciliationRefused("invariants");
    committing = true;
    await client.query("COMMIT");
    return { event: "ortho_empty51_recorded", version: "0051", actionId: approval.actionId, historicalExecutionVerified: false };
  } catch (error) {
    if (committing) throw new ReconciliationRefused("uncertain_commit");
    try { await client.query("ROLLBACK"); } catch { throw new OperatorCleanupFailure("unknown"); }
    throw error;
  }
}

/** Own the connection so output follows confirmed transaction and cleanup. */
export async function runEmpty51Session(client: Client, approval: Empty51Approval, reference: Empty51Reference, apply = false) {
  let result: Awaited<ReturnType<typeof reconcileEmpty51>> | undefined;
  let failure: unknown, failed = false, connectionError = false;
  client.on("error", () => { connectionError = true; });
  try { await client.connect(); result = await reconcileEmpty51(client, approval, reference, apply); }
  catch (error) { failure = error; failed = true; }
  try { await client.end(); if (connectionError) throw new Error("CLEANUP_FAILED"); }
  catch { throw new OperatorCleanupFailure(apply ? result ? "committed" : "unknown" : "read_only"); }
  if (failed) throw failure;
  return result!;
}
