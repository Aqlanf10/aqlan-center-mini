import { Client } from "pg";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildPreflightArtifact } from "../../scripts/build-preflight";
import { validateOwnershipHarnessEnvironment } from "../../scripts/verify-schema-ownership";
import { preflightConnection } from "../../scripts/db-preflight";
import { projectDetailedSchemaReadOnly } from "../../lib/schema-manifest";
import { loadMigrationFiles } from "../../lib/migration-files";

const execute = promisify(execFile);
const database = `aqlan_preflight_artifact_${randomUUID().replace(/-/g, "")}`;
let client: Client;
let temporary: string;
let artifact: string;
let url: string;
let maintenanceUrl: string;
let created = false;
let sourceMigrationCount = 0;

beforeAll(async () => {
  const target = validateOwnershipHarnessEnvironment();
  preflightConnection({ ...process.env, DATABASE_URL: target.testUrl.toString() });
  maintenanceUrl = target.maintenanceUrl.toString();
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE ${database}`); created = true; }
  finally { await admin.end(); }
  target.testUrl.pathname = `/${database}`; url = target.testUrl.toString();
  client = new Client({ connectionString: url, ssl: false }); await client.connect();
  await client.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,name text NOT NULL,checksum text NOT NULL,adopted boolean NOT NULL)");
  await client.query("CREATE TABLE synthetic_artifact_fixture(id serial PRIMARY KEY,note text)");
  await client.query("INSERT INTO synthetic_artifact_fixture(note) VALUES ('synthetic unchanged')");
  const sourceFiles = await loadMigrationFiles();
  sourceMigrationCount = sourceFiles.length;
  for (const file of sourceFiles) {
    await client.query("INSERT INTO schema_migrations VALUES ($1,$2,$3,false)", [file.version, file.name, file.checksum]);
  }
  temporary = await mkdtemp(path.join(tmpdir(), "aqlan-preflight-artifact-pg-"));
  artifact = path.join(temporary, "preflight");
  await buildPreflightArtifact(artifact);
});

afterAll(async () => {
  await client?.end();
  if (temporary) await rm(temporary, { recursive: true, force: true });
  if (!created) return;
  const admin = new Client({ connectionString: maintenanceUrl, ssl: false }); await admin.connect();
  try { await admin.query(`DROP DATABASE ${database} WITH (FORCE)`); }
  finally { await admin.end(); }
});

const run = (args: string[] = []) => execute(process.execPath, [path.join(artifact, "runner/run.mjs"), ...args], {
  cwd: temporary, env: { ...process.env, NODE_ENV: "test", DATABASE_ENVIRONMENT: "test", DATABASE_URL: url, USE_LOCAL_DB: "false" },
});

it("packages the optional drilldown and binds report provenance to verified source and bundle bytes", async () => {
  const baseline = JSON.parse((await run()).stdout);
  const { stdout } = await run(["--fingerprint-drilldown"]);
  const { fingerprintDrilldown, provenance, ...unchanged } = JSON.parse(stdout);
  expect(unchanged).toEqual(baseline);
  expect(fingerprintDrilldown.mode).toBe("buckets");
  expect(stdout.trim().split("\n")).toHaveLength(1);
  expect(Buffer.byteLength(stdout)).toBeLessThanOrEqual(48 * 1024);
  expect(fingerprintDrilldown.sections.columns.withheldIdentityCount).toBe(2);
  expect(fingerprintDrilldown.postgresVersionNum).toBe(Number((await client.query("SHOW server_version_num")).rows[0].server_version_num));
  const manifest = JSON.parse(await readFile(path.join(artifact, "manifest.json"), "utf8"));
  expect(provenance.bundleSha256).toBe(manifest.bundleSha256);
  expect(provenance.sourceFiles).toEqual(manifest.sourceFiles);
  expect(provenance.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(provenance.migrationsSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(stdout).not.toContain("synthetic_artifact_fixture");
  expect(stdout).not.toContain("synthetic unchanged");
  expect(stdout).not.toContain(url);
  const bucket = fingerprintDrilldown.sections.columns.buckets.find((item: { count: number }) => item.count > 0);
  const { stdout: detailText } = await run([`--fingerprint-drilldown=columns:${bucket.bucket}`]);
  const selected = JSON.parse(detailText);
  expect(selected.fingerprintDrilldown.mode).toBe("bucket");
  expect(selected.fingerprintDrilldown.detail).toMatchObject(bucket);
  expect(selected.fingerprintDrilldown.detail.entries).toHaveLength(bucket.count);
  expect(selected.provenance).toEqual(provenance);
  expect(selected.catalog).toEqual(baseline.catalog);
  expect(Buffer.byteLength(detailText)).toBeLessThanOrEqual(48 * 1024);
});

it("executes the delivered artifact against PG18 with exact provenance and no changes", async () => {
  const before = await projectDetailedSchemaReadOnly(client);
  const { stdout } = await run();
  const report = JSON.parse(stdout);
  expect(report.registry).toMatchObject({ present: true, registeredCount: sourceMigrationCount, matchesFiles: true });
  expect(report.transaction).toEqual({ readOnly: true, isolation: "repeatable read" });
  expect(report.adoptionAssessment).toBe("NOT_PERFORMED");
  expect(report.schemaEquivalence).toBe("NOT_ASSESSED");
  expect(stdout).not.toContain("synthetic unchanged");
  expect(stdout).not.toContain(url);
  expect(await projectDetailedSchemaReadOnly(client)).toEqual(before);
  expect((await client.query("SELECT note FROM synthetic_artifact_fixture")).rows[0].note).toBe("synthetic unchanged");
});

it("fails closed with no partial report when migration assets are absent", async () => {
  await rename(path.join(artifact, "migrations"), path.join(artifact, "migrations-held"));
  try {
    await expect(run()).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("PREFLIGHT_ARTIFACT_INVALID") });
  } finally {
    await rename(path.join(artifact, "migrations-held"), path.join(artifact, "migrations"));
  }
});
