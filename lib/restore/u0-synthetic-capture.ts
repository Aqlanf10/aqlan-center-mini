/** Connected, in-process synthetic fixture capability. Not operational provenance.
 * No route/CLI/default backup path creates these capabilities. The fixture owner
 * must control source lifecycle and close all writers before creating one; the
 * catalog observations detect drift but do not prove global quiescence alone.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { projectDetailedSchemaReadOnly, type DetailedSchemaCatalog } from '../schema-manifest';
import { RAILWAY_ENV_NAMES } from '../verification-target-policy.mjs';
import { captureOfflineSequences, offlineSchemaManifest, type OfflineSequence } from './u0-offline-primitives';
import type { BackupDeferredReferenceEvent } from '../backup-events';

export const SYNTHETIC_U0_PROFILE = 'u0-synthetic-v1' as const;
export const SYNTHETIC_U0_ENTRY = 'u0-recovery.json' as const;
export const SYNTHETIC_LIMITS = Object.freeze({ sqlBytes: 1024 * 1024, tarBytes: 8 * 1024 * 1024, events: 10000, sequences: 1024, evidenceBytes: 4 * 1024 * 1024 });
export interface SyntheticSourceIdentity { database: string; oid: string; owner: string }
export interface SyntheticDeferredLink extends BackupDeferredReferenceEvent { startByte: number; endByte: number; ordinal: number }
export interface SyntheticRecoveryEnvelope {
  profile: typeof SYNTHETIC_U0_PROFILE; version: 1; captureId: string;
  source: SyntheticSourceIdentity; schemaManifest: string; ownershipManifest: string;
  sequences: OfflineSequence[]; links: SyntheticDeferredLink[];
  databaseSha256: string; databaseBytes: number;
  observations: { before: string; after: string };
}
export interface SyntheticCaptureController { readonly profile: typeof SYNTHETIC_U0_PROFILE }
export interface SyntheticRecoveryTrust { readonly profile: typeof SYNTHETIC_U0_PROFILE }
interface CaptureState {
  client: Client; identity: SyntheticSourceIdentity; schema: string; ownership: string;
  sequences: OfflineSequence[]; before: string; captureId: string;
  phase: 'prepared' | 'capturing' | 'captured' | 'sealed' | 'failed';
  envelopeSha256?: string; tarSha256?: string;
}
const captures = new WeakMap<SyntheticCaptureController, CaptureState>();
const trusts = new WeakMap<SyntheticRecoveryTrust, CaptureState>();
export const recoverySha256 = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function testOnly() {
  if (process.env.NODE_ENV !== 'test' || process.env.DATABASE_ENVIRONMENT !== 'test') throw new Error('Synthetic recovery requires test environment');
  for (const key of RAILWAY_ENV_NAMES) {
    if (process.env[key]?.trim()) throw new Error('Synthetic recovery refuses Railway runtime');
  }
}
function captureState(controller: SyntheticCaptureController) {
  testOnly(); const state = captures.get(controller);
  if (!state) throw new Error('Unknown synthetic capture capability');
  return state;
}
/** Versioned, deliberately bounded fixture schema support. Names, never source
 * OIDs, identify cross-catalog relationships. pg_catalog builtins/default
 * collations and the standard plpgsql extension are not application objects. */
export async function syntheticOwnershipManifest(client: Client): Promise<string> {
  const { rows: unsupported } = await client.query<{ kind: string; name: string }>(`SELECT 'unsupported-relation' AS kind,n.nspname||'.'||c.relname AS name
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND (c.relkind NOT IN ('r','i','S') OR c.relispartition)
    UNION ALL SELECT 'inheritance',n.nspname||'.'||c.relname FROM pg_catalog.pg_inherits h JOIN pg_catalog.pg_class c ON c.oid=h.inhrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'rewrite-rule',c.relname||'.'||r.rulename FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'custom-type',n.nspname||'.'||t.typname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_catalog.pg_class c ON c.oid=t.typrelid
      WHERE n.nspname='public' AND t.typelem=0 AND NOT (t.typtype='c' AND c.relkind='r')
    UNION ALL SELECT 'custom-collation',n.nspname||'.'||c.collname FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='public'
    UNION ALL SELECT 'application-schema',nspname FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname !~ '^pg_'
    UNION ALL SELECT 'unsupported-routine',n.nspname||'.'||p.proname||'('||pg_catalog.pg_get_function_identity_arguments(p.oid)||')' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind<>'f'
    UNION ALL SELECT 'default-privileges',r.rolname||'.'||COALESCE(n.nspname,'global') FROM pg_catalog.pg_default_acl a JOIN pg_catalog.pg_roles r ON r.oid=a.defaclrole LEFT JOIN pg_catalog.pg_namespace n ON n.oid=a.defaclnamespace WHERE a.defaclnamespace=0 OR n.nspname='public'
    UNION ALL SELECT 'extension',extname FROM pg_catalog.pg_extension WHERE extname<>'plpgsql'
    ORDER BY kind,name`);
  if (!Array.isArray(unsupported) || unsupported.length) throw new Error('Unsupported synthetic schema feature');
  const catalog = await projectDetailedSchemaReadOnly(client, 'public', { includeMutableSequenceState: false });
  validateDetailedCatalog(catalog);
  const { rows } = await client.query<{ kind: string; name: string; definition: unknown }>(`SELECT 'schema' AS kind,n.nspname AS name,
    pg_catalog.jsonb_build_object('owner',r.rolname,'acl',n.nspacl::text) AS definition
    FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner WHERE n.nspname='public'
    UNION ALL SELECT 'table',c.relname,pg_catalog.jsonb_build_object('owner',r.rolname,'acl',c.relacl::text,
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END,'acl',a.attacl::text) ORDER BY a.attnum)
       FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped))
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE n.nspname='public' AND c.relkind='r'
    UNION ALL SELECT 'policy',c.relname||'.'||p.polname,pg_catalog.jsonb_build_object('table',c.relname,'command',p.polcmd,'permissive',p.polpermissive,'roles',(SELECT pg_catalog.jsonb_agg(role_name ORDER BY role_name COLLATE "C") FROM (SELECT CASE WHEN role_id=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_id) END AS role_name FROM unnest(p.polroles) AS role_id) roles),'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
    ORDER BY kind,name`);
  validateSchemaRows(rows);
  if (JSON.stringify(rows.filter(row => row.kind === 'table').map(row => row.name).sort()) !== JSON.stringify(catalog.tables.map(table => table.key).sort())) throw new Error('Missing exact table ownership metadata');
  return canonicalSchemaJson({ version: 2, catalog, rows: [...rows].sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0) });
}
function validateDetailedCatalog(catalog: DetailedSchemaCatalog) {
  if (catalog.format !== 'aqlan-schema-ownership-catalog' || catalog.formatVersion !== 1 || catalog.postgresMajor !== 18 || !catalog.postgresVersion || !catalog.tables.length || !catalog.sequences.length) throw new Error('Missing supported detailed schema catalog');
  for (const section of ['tables','columns','constraints','indexes','triggers','internalTriggers','functions','sequences','extensionMembers'] as const) {
    if (!Array.isArray(catalog[section])) throw new Error('Missing detailed schema section');
    const seen = new Set<string>();
    for (const entry of catalog[section]) {
      if (!entry.key || typeof entry.value !== 'string' || seen.has(entry.key)) throw new Error(`Malformed detailed schema entry: ${section}:${entry.key}`);
      seen.add(entry.key);
      const value: unknown = JSON.parse(entry.value);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed detailed schema definition');
    }
  }
}

function canonicalSchemaJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSchemaJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalSchemaJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function validateSchemaRows(rows: { kind: string; name: string; definition: unknown }[]) {
  const bad = () => { throw new Error('Malformed or missing synthetic schema metadata'); };
  const object = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) return bad();
    return value as Record<string, unknown>;
  };
  const text = (value: unknown) => typeof value === 'string' && value.length > 0;
  const nullable = (value: unknown) => value === null || typeof value === 'string';
  const seen = new Set<string>(); let schemas = 0;
  if (!Array.isArray(rows)) bad();
  for (const row of rows) {
    object(row, ['kind','name','definition']);
    if (!text(row.name) || seen.has(`${row.kind}:${row.name}`)) bad(); seen.add(`${row.kind}:${row.name}`);
    if (row.kind === 'schema') { const d = object(row.definition, ['owner','acl']); if (row.name !== 'public' || !text(d.owner) || !nullable(d.acl)) bad(); schemas++; }
    else if (row.kind === 'table') {
      const d = object(row.definition, ['owner','acl','columns']);
      if (!text(d.owner) || !nullable(d.acl) || !Array.isArray(d.columns) || !d.columns.length) bad();
      const names = new Set<string>();
      for (const raw of d.columns as unknown[]) { const c = object(raw, ['name','collation','acl']);
        if (!text(c.name) || names.has(String(c.name)) || !nullable(c.collation) || !nullable(c.acl)) bad(); names.add(String(c.name)); }
    } else if (row.kind === 'policy') { const d = object(row.definition, ['table','command','permissive','roles','using','check']);
      if (!text(d.table) || !['*','r','a','w','d'].includes(String(d.command)) || typeof d.permissive !== 'boolean' || !Array.isArray(d.roles) || !d.roles.length || !d.roles.every(text) || !nullable(d.using) || !nullable(d.check)) bad();
    } else bad();
  }
  if (schemas !== 1 || !rows.some(row => row.kind === 'table')) bad();
  const tables = new Map(rows.filter(row => row.kind === 'table').map(row => [row.name, row.definition as { columns: { name: string }[] }]));
  for (const row of rows) {
    if (row.kind === 'policy') {
      const d = row.definition as { table: string }; if (!tables.has(d.table)) bad();

    }
  }
}
function validateSequenceOwnershipInventory(manifest: string, sequences: OfflineSequence[]) {
  const parsed = JSON.parse(manifest) as { catalog: DetailedSchemaCatalog };
  const owned = parsed.catalog.sequences.map(row => row.key).sort();
  if (JSON.stringify(owned) !== JSON.stringify(sequences.map(sequence => sequence.name).sort())) throw new Error('Missing sequence ownership inventory');
}
async function observe(client: Client, expected: SyntheticSourceIdentity): Promise<string> {
  const { rows: [row] } = await client.query(`SELECT pg_catalog.current_database() AS database,d.oid::text AS oid,d.datdba::text AS owner,
    d.datdba=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,
    (pg_catalog.inet_server_addr() IS NULL OR pg_catalog.inet_server_addr()<<'127.0.0.0/8'::inet OR pg_catalog.inet_server_addr()='::1'::inet) AS local,
    (SELECT count(*)::int FROM pg_catalog.pg_stat_activity WHERE datid=d.oid AND pid<>pg_catalog.pg_backend_pid()) AS others,
    pg_catalog.current_setting('session_replication_role') AS replication
    FROM pg_catalog.pg_database d WHERE d.datname=pg_catalog.current_database()`);
  if (!row || !/^aqlan_u0_restore_test_[a-f0-9]{32}$/.test(row.database) || row.database !== expected.database
    || row.oid !== expected.oid || row.owner !== expected.owner || !row.owned || !row.local || row.others !== 0 || row.replication !== 'origin') {
    throw new Error('Dedicated owned synthetic source identity required');
  }
  return JSON.stringify(row);
}
/** Called only by an owning disposable-fixture controller after its writer phase.
 * Expected schema/ownership digests are retained from fixture schema preparation,
 * not obtained from an imported archive. No boolean can substitute for them.
 */
export async function prepareSyntheticCapture(client: Client, expected: SyntheticSourceIdentity,
  profile: { schemaSha256: string; ownershipSha256: string }): Promise<SyntheticCaptureController> {
  testOnly();
  if (typeof client.getTransactionStatus !== 'function' || client.getTransactionStatus() !== 'I') throw new Error('Idle synthetic source required');
  const identity = { ...expected };
  const before = await observe(client, identity);
  const schema = await offlineSchemaManifest(client), ownership = await syntheticOwnershipManifest(client);
  if (recoverySha256(schema) !== profile.schemaSha256 || recoverySha256(ownership) !== profile.ownershipSha256) throw new Error('Synthetic source profile mismatch');
  const sequences = await captureOfflineSequences(client);
  validateSequenceOwnershipInventory(ownership, sequences);
  if (!sequences.length || sequences.length > SYNTHETIC_LIMITS.sequences) throw new Error('Complete bounded sequence evidence required');
  const evidenceBytes = Buffer.byteLength(schema) + Buffer.byteLength(ownership);
  if (evidenceBytes > SYNTHETIC_LIMITS.evidenceBytes) throw new Error(`Synthetic evidence limit: ${evidenceBytes} bytes`);
  const controller = Object.freeze({ profile: SYNTHETIC_U0_PROFILE });
  captures.set(controller, { client, identity, schema, ownership, sequences, before, captureId: randomUUID(), phase: 'prepared' });
  return controller;
}
export function beginSyntheticCapture(controller: SyntheticCaptureController, source: unknown) {
  const state = captureState(controller);
  if (state.phase !== 'prepared' || state.client !== source || state.client.getTransactionStatus() !== 'I') throw new Error('Synthetic capture lifecycle mismatch');
  state.phase = 'capturing';
}
export async function finishSyntheticCapture(controller: SyntheticCaptureController, sql: { sha256: string; bytes: number }, links: SyntheticDeferredLink[]): Promise<Buffer> {
  const state = captureState(controller);
  if (state.phase !== 'capturing') throw new Error('Synthetic capture lifecycle mismatch');
  const after = await observe(state.client, state.identity);
  const schema = await offlineSchemaManifest(state.client), ownership = await syntheticOwnershipManifest(state.client);
  const sequences = await captureOfflineSequences(state.client);
  validateSequenceOwnershipInventory(ownership, sequences);
  if (state.before !== after || state.schema !== schema || state.ownership !== ownership || JSON.stringify(state.sequences) !== JSON.stringify(sequences)) throw new Error('Synthetic source changed during capture');
  const envelope: SyntheticRecoveryEnvelope = { profile: SYNTHETIC_U0_PROFILE, version: 1, captureId: state.captureId,
    source: state.identity, schemaManifest: schema, ownershipManifest: ownership, sequences, links,
    databaseSha256: sql.sha256, databaseBytes: sql.bytes, observations: { before: state.before, after } };
  const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
  state.envelopeSha256 = recoverySha256(bytes); state.phase = 'captured';
  return bytes;
}
export function sealSyntheticCapture(controller: SyntheticCaptureController, tarSha256: string) {
  const state = captureState(controller);
  if (state.phase !== 'captured' || !/^[a-f0-9]{64}$/.test(tarSha256)) throw new Error('Incomplete synthetic archive');
  state.tarSha256 = tarSha256; state.phase = 'sealed';
}
export function failSyntheticCapture(controller: SyntheticCaptureController) { const state = captures.get(controller); if (state) state.phase = 'failed'; }
/** Out-of-band in-process receipt, available only after the actual writer ends. */
export function syntheticRecoveryTrust(controller: SyntheticCaptureController): SyntheticRecoveryTrust {
  const state = captureState(controller);
  if (state.phase !== 'sealed') throw new Error('Incomplete synthetic archive');
  const trust = Object.freeze({ profile: SYNTHETIC_U0_PROFILE }); trusts.set(trust, state); return trust;
}
export function verifySyntheticTrust(bytes: Uint8Array, trust: SyntheticRecoveryTrust) {
  testOnly();
  if (bytes.byteLength > SYNTHETIC_LIMITS.tarBytes) throw new Error('Synthetic archive size limit');
  const state = trusts.get(trust);
  if (!state || state.phase !== 'sealed' || recoverySha256(bytes) !== state.tarSha256) throw new Error('Synthetic out-of-band archive trust mismatch');
  return { envelopeSha256: state.envelopeSha256!, source: { ...state.identity }, schema: state.schema, ownership: state.ownership,
    sequences: structuredClone(state.sequences), captureId: state.captureId };
}
