import { expect, it } from "vitest";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { projectDetailedSchemaReadOnly } from "../../lib/schema-manifest";
import { fingerprintCatalog, type FingerprintSection } from "../../lib/schema-fingerprint";

it("recognizes preflight fingerprints for synthetic fresh and historical 0079 schemas after financial migrations", async () => {
  const fixture = await openBackupTimestampFixture(process.env);
  try {
    const files = await loadMigrationFiles();
    await migrate(fixture.source, { apply: true, files });
    await migrate(fixture.sqlTarget, { apply: true, files, historical0079: true });
    for (const pool of [fixture.source, fixture.sqlTarget]) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await client.query("SET LOCAL search_path = pg_catalog");
        const catalog = await projectDetailedSchemaReadOnly(client, "public", { includeMutableSequenceState: false });
        const report = fingerprintCatalog(catalog, 180006);
        for (const section of ["columns", "constraints", "internalTriggers"] as FingerprintSection[]) {
          expect(report.sections[section].withheldIdentityCount, section).toBe(0);
          expect(report.sections[section].entries.filter(entry => entry.withheldPropertyCount > 0), section).toEqual([]);
        }
        await client.query("COMMIT");
      } finally { client.release(); }
    }
  } finally { await fixture.close(); }
}, 180000);
