import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, realpath, mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { ensureSchema, getPool, resetPoolForTesting } from "./db";
import { validateLocalVerificationTarget } from "./verification-target-policy.mjs";
import { catalogHash, ORTHO_REFERENCE_SOURCE, readOrthoCatalog, readRegistryCatalog, readReconciliationAuditCatalog } from "./ortho-reconciliation-catalog";
import contracts from "./ortho-assessment-runtime.generated.json";
import { OPERATOR_LIMITS } from "./ortho-reconciliation-limits";

export type PrivateReferenceConfig = {
  format: 1;
  disposableCluster: true;
  cluster: { systemIdentifier: string; versionNum: string; version: string; bootstrapRole: string };
  databaseOwner: string;
  initializerRole: string;
  locale: { encoding: "UTF8"; provider: "libc" | "icu" | "builtin"; lcCollate: string; lcCtype: string;
    locale: string | null; rules: string | null; storedVersion: string | null; actualVersion: string | null };
  // Declared provenance is retained separately; SQL cannot authenticate an OCI
  // image or libc package. Root must independently review this witness.
  environmentWitness: { imageDigest: string; platform: string; libc: string; localeData: string; icu: string | null; approvalId: string };
};
export class PrivateReferenceRefused extends Error {
  constructor(public readonly category: "config" | "output" | "source" | "cluster" | "locale" | "cleanup" | "generation") { super(`PRIVATE_REFERENCE_${category.toUpperCase()}`); }
}
const fail = (category: ConstructorParameters<typeof PrivateReferenceRefused>[0]): never => { throw new PrivateReferenceRefused(category); };
const role = /^[a-z_][a-z0-9_]{0,62}$/;
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function keys(value: unknown, expected: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join() !== expected.sort().join()) fail("config");
}
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 500 && Array.from(value).every(character => character.charCodeAt(0) >= 32 && character !== "\\"); }
export function validatePrivateReferenceConfig(input: PrivateReferenceConfig) {
  keys(input, ["format", "disposableCluster", "cluster", "databaseOwner", "initializerRole", "locale", "environmentWitness"]);
  keys(input.cluster, ["systemIdentifier", "versionNum", "version", "bootstrapRole"]);
  keys(input.locale, ["encoding", "provider", "lcCollate", "lcCtype", "locale", "rules", "storedVersion", "actualVersion"]);
  keys(input.environmentWitness, ["imageDigest", "platform", "libc", "localeData", "icu", "approvalId"]);
  if (input.format !== 1 || input.disposableCluster !== true || !/^\d{10,25}$/.test(input.cluster.systemIdentifier)
      || !/^18\d{4}$/.test(input.cluster.versionNum) || !nonempty(input.cluster.version)
      || ![input.cluster.bootstrapRole, input.databaseOwner, input.initializerRole].every(value => typeof value === "string" && role.test(value))) fail("config");
  const loc = input.locale;
  if (loc.encoding !== "UTF8" || !["libc", "icu", "builtin"].includes(loc.provider)
      || !nonempty(loc.lcCollate) || !nonempty(loc.lcCtype)
      || ![loc.locale, loc.rules, loc.storedVersion, loc.actualVersion].every(value => value === null || nonempty(value))
      || loc.storedVersion !== loc.actualVersion) fail("config");
  if (loc.provider === "libc" && (loc.locale !== null || loc.rules !== null)) fail("config");
  if (loc.provider === "icu" && !nonempty(loc.locale)) fail("config");
  if (loc.provider === "builtin" && (!loc.locale || !["C", "C.UTF-8", "PG_UNICODE_FAST"].includes(loc.locale) || loc.rules !== null)) fail("config");
  const witness = input.environmentWitness;
  if (!/^[A-Za-z0-9._/:/-]+@sha256:[a-f0-9]{64}$/.test(witness.imageDigest)
      || !/^linux\/(amd64|arm64)$/.test(witness.platform) || !nonempty(witness.libc) || !nonempty(witness.localeData)
      || !(witness.icu === null || nonempty(witness.icu)) || !/^[A-Za-z0-9_-]{8,100}$/.test(witness.approvalId)) fail("config");
  if (loc.provider === "icu" && !witness.icu) fail("config");
}
export function privateReferenceCreateSql(name: string, config: PrivateReferenceConfig) {
  validatePrivateReferenceConfig(config);
  if (!/^aqlan_ortho_reference_[a-f0-9]{32}$/.test(name)) fail("config");
  const loc = config.locale;
  return `CREATE DATABASE ${quote(name)} OWNER ${quote(config.databaseOwner)} TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER ${loc.provider} LC_COLLATE ${literal(loc.lcCollate)} LC_CTYPE ${literal(loc.lcCtype)}`
    + (loc.provider === "icu" ? ` ICU_LOCALE ${literal(loc.locale!)}${loc.rules === null ? "" : ` ICU_RULES ${literal(loc.rules)}`}` : "")
    + (loc.provider === "builtin" ? ` BUILTIN_LOCALE ${literal(loc.locale!)}` : "");
}
export async function validatePrivateOutputDirectory(directory: string) {
  if (!isAbsolute(directory) || resolve(directory) !== directory || await realpath(directory) !== directory) fail("output");
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.()) fail("output");
  let cursor = directory;
  for (;;) {
    try {
      const marker = join(cursor, ".git");
      const metadata = await lstat(marker);
      // Some sandboxes mount an empty read-only .git sentinel in /tmp.
      // Files, symlinks and any populated metadata remain forbidden.
      if (!metadata.isDirectory() || (await readdir(marker)).length !== 0) fail("output");
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return directory;
}
export const PRIVATE_REFERENCE_LOCALE_SQL = `SELECT pg_encoding_to_char(encoding) AS encoding,
 CASE datlocprovider WHEN 'c' THEN 'libc' WHEN 'i' THEN 'icu' WHEN 'b' THEN 'builtin' END AS provider,
 datcollate AS "lcCollate", datctype AS "lcCtype", datlocale AS locale, daticurules AS rules,
 datcollversion AS "storedVersion", pg_database_collation_actual_version(oid) AS "actualVersion"
 FROM pg_catalog.pg_database WHERE datname=current_database()`;
const compare = (actual: Record<string, unknown>, expected: Record<string, unknown>) =>
  Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([key, value]) => actual[key] === value);

/** Standalone synthetic generator: no role creation, grants, security edits,
 * catalog normalization or target SQL input. Existing roles/ACL defaults must
 * already express the separately reviewed isolated-cluster security recipe.
 */
export async function generatePrivateReference(config: PrivateReferenceConfig, outputParent: string) {
  validatePrivateReferenceConfig(config);
  await validatePrivateOutputDirectory(outputParent);
  const target = validateLocalVerificationTarget(process.env.TEST_DATABASE_URL, process.env,
    { varName: "TEST_DATABASE_URL", databaseName: "aqlan_p1_test", errorPrefix: "PRIVATE_REFERENCE_UNSAFE_TARGET" });
  if (!["127.0.0.1", "[::1]"].includes(target.hostname) || process.env.USE_LOCAL_DB === "true") fail("config");
  const root = fileURLToPath(new URL("..", import.meta.url));
  try {
    execFileSync("git", ["diff", "--quiet", ORTHO_REFERENCE_SOURCE, "--", "lib/db.ts", "lib/migrations.ts", "lib/ortho-assessment-runtime.ts", "lib/ortho-assessment-runtime.generated.json", "migrations"], { cwd: root, stdio: "ignore" });
    for (const file of contracts) if (await readFile(new URL(`../migrations/${file.filename}`, import.meta.url), "utf8") !== file.sql) fail("source");
  } catch { fail("source"); }
  const directory = await mkdtemp(join(outputParent, "ortho-reference-"));
  const name = `aqlan_ortho_reference_${randomUUID().replaceAll("-", "")}`;
  const journal = (state: string, identity?: unknown) => writeFile(join(directory, "journal.json"),
    JSON.stringify({ state, database: name, clusterSystemIdentifier: config.cluster.systemIdentifier, identity }, null, 2) + "\n", { mode: 0o600 });
  await journal("not_connected");
  const adminUrl = new URL(target); adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString(), ssl: false, connectionTimeoutMillis: OPERATOR_LIMITS.connectionTimeoutMillis,
    query_timeout: OPERATOR_LIMITS.query_timeout, options: "-c search_path=pg_catalog,public -c statement_timeout=60000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=10000 -c transaction_timeout=120000 -c standard_conforming_strings=on" });
  const envNames = ["DATABASE_URL", "SKIP_SEED", "DB_POOL_MAX", "PGOPTIONS"] as const;
  const saved = envNames.map(key => [key, process.env[key]] as const);
  let identity: { oid: string; owner: string } | undefined;
  let reference: unknown;
  let witness: unknown;
  let connected = false, creationAttempted = false, cleanupFailed = false, connectionError = false;
  let failure: unknown;
  admin.on("error", () => { connectionError = true; });
  try {
    await admin.connect(); connected = true;
    const observed = (await admin.query(`SELECT system_identifier::text AS "systemIdentifier",current_setting('server_version_num') AS "versionNum",
      version() AS version,current_user AS "bootstrapRole" FROM pg_catalog.pg_control_system()`)).rows[0];
    if (!observed || !compare(observed, config.cluster)) fail("cluster");
    const roles = (await admin.query("SELECT rolname FROM pg_catalog.pg_roles WHERE rolname=ANY($1::text[])", [[config.databaseOwner, config.initializerRole]])).rows;
    if (new Set(roles.map(row => row.rolname)).size !== new Set([config.databaseOwner, config.initializerRole]).size) fail("config");
    await journal("create_pending"); creationAttempted = true;
    await admin.query(privateReferenceCreateSql(name, config));
    identity = (await admin.query("SELECT oid::text,datdba::text AS owner FROM pg_catalog.pg_database WHERE datname=$1", [name])).rows[0];
    if (!identity) fail("cleanup");
    await journal("created", identity);
    const url = new URL(target); url.pathname = `/${name}`;
    process.env.DATABASE_URL = url.toString(); process.env.SKIP_SEED = "true"; process.env.DB_POOL_MAX = "1";
    // Safe scalar role grammar prevents startup-option injection. No inherited
    // PGOPTIONS or role-specific search_path can redirect source DDL.
    process.env.PGOPTIONS = `-c role=${config.initializerRole} -c search_path=public -c standard_conforming_strings=on -c lock_timeout=10000 -c transaction_timeout=120000`;
    await resetPoolForTesting();
    const pool = getPool();
    const owner = (await pool.query("SELECT current_user AS role,pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()")).rows[0];
    if (owner?.role !== config.initializerRole || owner?.owner !== config.databaseOwner) fail("cluster");
    const locale = (await pool.query(PRIVATE_REFERENCE_LOCALE_SQL)).rows[0];
    if (!locale || !compare(locale, config.locale)) fail("locale");
    await ensureSchema(); await resetPoolForTesting();
    const client = new Client({ connectionString: url.toString(), ssl: false, connectionTimeoutMillis: OPERATOR_LIMITS.connectionTimeoutMillis,
      query_timeout: OPERATOR_LIMITS.query_timeout, options: "-c search_path=pg_catalog,public -c default_transaction_read_only=on -c statement_timeout=60000 -c idle_in_transaction_session_timeout=10000 -c transaction_timeout=120000" });
    client.on("error", () => { connectionError = true; });
    try {
      await client.connect(); await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const finalLocale = (await client.query(PRIVATE_REFERENCE_LOCALE_SQL)).rows[0];
      if (!compare(finalLocale, config.locale)) fail("locale");
      reference = { source: ORTHO_REFERENCE_SOURCE, catalog: await readOrthoCatalog(client, "0051"), registryCatalog: await readRegistryCatalog(client), auditCatalog: await readReconciliationAuditCatalog(client) };
      witness = { format: 1, source: ORTHO_REFERENCE_SOURCE, cluster: observed, databaseOwner: config.databaseOwner, initializerRole: config.initializerRole,
        locale: finalLocale, declaredEnvironmentWitness: config.environmentWitness, imageAndLibraryProvenanceIndependentlyVerified: false,
        generatedFromFrozenSourceInSeparateDatabase: true };
      await client.query("ROLLBACK");
    } finally { await client.end(); }
  } catch (error) { failure = error; }
  finally {
    try {
      await resetPoolForTesting();
      if (identity) {
        const actual = (await admin.query("SELECT oid::text,datdba::text AS owner FROM pg_catalog.pg_database WHERE datname=$1", [name])).rows[0];
        if (!actual || !compare(actual, identity)) fail("cleanup");
        await admin.query(`DROP DATABASE ${quote(name)}`);
        await journal("database_removed", identity);
      } else if (creationAttempted) { await journal("creation_outcome_uncertain"); cleanupFailed = true; }
    } catch { cleanupFailed = true; }
    try { await admin.end(); } catch { cleanupFailed = true; }
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  if (cleanupFailed || connectionError) fail("cleanup");
  if (failure) throw failure;
  if (!connected || !reference || !witness) fail("generation");
  // Never publish a reference before rollback, exact owned-DB removal and all
  // connection cleanup have succeeded. Existing files are never overwritten.
  await writeFile(join(directory, "reference.json"), JSON.stringify(reference, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await writeFile(join(directory, "witness.json"), JSON.stringify(witness, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const digest = catalogHash(reference);
  await journal("complete", identity);
  return { event: "ortho_private_reference_generated", digest, directory };
}
