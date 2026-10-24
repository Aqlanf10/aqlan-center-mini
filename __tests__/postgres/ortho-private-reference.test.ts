import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { generatePrivateReference, PRIVATE_REFERENCE_LOCALE_SQL, type PrivateReferenceConfig } from "../../lib/ortho-private-reference";
import { validatePostgresTestTarget } from "./_safe-target";

describe("isolated private reference generation", () => {
  let admin: Client, config: PrivateReferenceConfig, output: string;
  const owner = `reference_test_${randomBytes(8).toString("hex")}`;
  beforeAll(async () => {
    const target = validatePostgresTestTarget(process.env);
    admin = new Client({ connectionString: target.testUrl.toString(), ssl: false });
    await admin.connect();
    const cluster = (await admin.query(`SELECT system_identifier::text AS "systemIdentifier",current_setting('server_version_num') AS "versionNum",version() AS version,current_user AS "bootstrapRole" FROM pg_control_system()`)).rows[0];
    const locale = (await admin.query(PRIVATE_REFERENCE_LOCALE_SQL)).rows[0];
    await admin.query(`CREATE ROLE "${owner}" NOLOGIN NOSUPERUSER`);
    output = await mkdtemp(join(tmpdir(), "ortho-reference-integration-"));
    config = { format: 1, disposableCluster: true, cluster, databaseOwner: owner, initializerRole: owner, locale,
      environmentWitness: { imageDigest: `synthetic.invalid/test@sha256:${"a".repeat(64)}`, platform: "linux/amd64", libc: "synthetic-test", localeData: "synthetic-test", icu: null, approvalId: "synthetic-test-only" } };
  });
  afterAll(async () => {
    if (admin) { await admin.query(`DROP ROLE "${owner}"`); await admin.end(); }
    if (output) await rm(output, { recursive: true, force: true });
  });
  it("retains configured owners and natural locale, reproduces the digest, and removes owned databases", async () => {
    const first = await generatePrivateReference(config, output);
    const second = await generatePrivateReference(config, output);
    expect(first.digest).toBe(second.digest);
    const reference = await readFile(join(first.directory, "reference.json"), "utf8");
    expect(reference).toContain(owner);
    const raw = JSON.parse(reference);
    const language = (await admin.query("SELECT oid::text AS oid FROM pg_language WHERE lanname='plpgsql'")).rows[0].oid;
    for (const row of raw.catalog.filter((row: { section: string }) => row.section === "function")) {
      expect(row.properties.owner).toBe(owner);
      expect(row.properties.prolang).toBe(language);
    }
    const witness = JSON.parse(await readFile(join(first.directory, "witness.json"), "utf8"));
    expect(witness.locale).toEqual(config.locale);
    expect(witness.databaseOwner).toBe(owner);
    expect(witness.imageAndLibraryProvenanceIndependentlyVerified).toBe(false);
    for (const name of ["reference.json", "witness.json", "journal.json"]) expect((await stat(join(first.directory, name))).mode & 0o777).toBe(0o600);
    expect((await stat(first.directory)).mode & 0o777).toBe(0o700);
    for (const result of [first, second]) {
      const journal = JSON.parse(await readFile(join(result.directory, "journal.json"), "utf8"));
      expect(journal.state).toBe("complete");
      expect((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [journal.database])).rowCount).toBe(0);
    }
  });
  it.each(["cluster", "locale"])("refuses mismatched %s and publishes no reference", async defect => {
    const changed = structuredClone(config);
    if (defect === "cluster") changed.cluster.systemIdentifier = "1234567890123456789";
    else { changed.locale.storedVersion = "deliberately-wrong"; changed.locale.actualVersion = "deliberately-wrong"; }
    const before = new Set(await readdir(output));
    await expect(generatePrivateReference(changed, output)).rejects.toThrow(`PRIVATE_REFERENCE_${defect.toUpperCase()}`);
    const created = (await readdir(output)).filter(name => !before.has(name));
    expect(created).toHaveLength(1);
    const directory = join(output, created[0]);
    expect(await readdir(directory)).toEqual(["journal.json"]);
    const journal = JSON.parse(await readFile(join(directory, "journal.json"), "utf8"));
    expect((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [journal.database])).rowCount).toBe(0);
  });
});
