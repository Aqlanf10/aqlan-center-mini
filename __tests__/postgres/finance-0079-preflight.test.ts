import { expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openBackupTimestampFixture } from "./_backup-timestamp-fixture";
import { loadMigrationFiles, migrate } from "../../lib/migrations";
import { inspectSchemaReadOnly } from "../../lib/schema-preflight";
import type { FingerprintSection } from "../../lib/schema-fingerprint";

it("recognizes preflight fingerprints for synthetic fresh and historical 0079 schemas after financial migrations", async () => {
  const fixture = await openBackupTimestampFixture(process.env);
  try {
    const files = await loadMigrationFiles();
    await migrate(fixture.source, { apply: true, files });
    await migrate(fixture.sqlTarget, { apply: true, files, historical0079: true });
    for (const pool of [fixture.source, fixture.sqlTarget]) {
      const client = await pool.connect();
      try {
        const report = await inspectSchemaReadOnly(client, files, { fingerprintBuckets: null });
        const summary = report.fingerprintBuckets;
        expect(summary?.mode).toBe("buckets");
        if (!summary || summary.mode !== "buckets") throw new Error("Missing bounded preflight summary");
        for (const section of ["columns", "constraints", "internalTriggers"] as FingerprintSection[]) {
          expect(summary.sections[section].withheldIdentityCount, section).toBe(0);
          expect(summary.sections[section].withheldPropertyCount, section).toBe(0);
          expect(summary.sections[section].buckets).toHaveLength(64);
        }
      } finally { client.release(); }
      const env = { ...process.env, DATABASE_URL: pool.options.connectionString!, DATABASE_ENVIRONMENT: "test" };
      for (const arg of ["--fingerprint-drilldown", "--fingerprint-drilldown=columns:00"]) {
        const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/db-preflight.ts", arg],
          { env, timeout: 60_000, maxBuffer: 48 * 1024 });
        expect(Buffer.byteLength(stdout, "utf8")).toBeLessThanOrEqual(48 * 1024);
        const response = JSON.parse(stdout);
        expect(response.fingerprintDrilldown.mode).toBe(arg.endsWith("columns:00") ? "bucket" : "buckets");
        for (const section of ["columns", "constraints", "internalTriggers"] as FingerprintSection[]) {
          expect(response.fingerprintDrilldown.sections[section].withheldIdentityCount, section).toBe(0);
          expect(response.fingerprintDrilldown.sections[section].withheldPropertyCount, section).toBe(0);
          if (response.fingerprintDrilldown.mode === "buckets") expect(response.fingerprintDrilldown.sections[section].buckets).toHaveLength(64);
        }
      }
    }
  } finally { await fixture.close(); }
}, 180000);
