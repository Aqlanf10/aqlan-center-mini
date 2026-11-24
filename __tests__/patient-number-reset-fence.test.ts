import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RESET_SEQUENCES } from "../lib/clinic-reset";
import { PATIENT_NUMBER_SQL, paddedSequenceSql } from "../lib/document-numbers";

/**
 * P0-A archival numbering fence.
 *
 * The old main branch reset patient_number_seq to 1. Staging deliberately
 * excludes it: the patient archive ID is durable even across an owner reset.
 * This is a fast, synthetic regression guard, NOT a PostgreSQL restore drill.
 */
describe("patient archive IDs survive clinic reset", () => {
  it("never rewinds the patient sequence when resetting test records", () => {
    expect(RESET_SEQUENCES).not.toContain("patient_number_seq");
  });

  it("generates patient numbers from the durable sequence rather than a financial document counter", () => {
    expect(PATIENT_NUMBER_SQL).toContain("nextval('patient_number_seq')");
    expect(PATIENT_NUMBER_SQL).not.toMatch(/invoice_number_seq|receipt_number_seq|voucher_number_seq/);
  });

  it("does not truncate archive IDs after five digits", () => {
    expect(paddedSequenceSql("patient_number_seq")).toContain("regexp_replace");
    expect(paddedSequenceSql("patient_number_seq")).toContain("LPAD(nextval('patient_number_seq')::text, 20, '0')");
    expect(paddedSequenceSql("patient_number_seq")).not.toContain("LPAD(nextval('patient_number_seq')::text, 5,");
  });
});

describe("direct backup drill target fence", () => {
  const script = fileURLToPath(new URL("../scripts/verify-backup.mjs", import.meta.url));
  const local = "postgresql://fixture:fixture@127.0.0.1:1/postgres?sslmode=disable";

  it.each([
    ["remote source", { SOURCE_DATABASE_URL: "postgresql://fixture:fixture@synthetic.invalid:1/postgres" }, /loopback PostgreSQL only/],
    ["production marker", { DATABASE_ENVIRONMENT: "production" }, /production environment is forbidden/],
    ["ambient host override", { PGHOST: "synthetic.invalid" }, /Legacy restore refused/],
  ] as const)("rejects %s before database I/O", (_label, overrides, expected) => {
    // No real DB credentials, and port 1 is deliberately not the CI database.
    const result = spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH, NODE_ENV: "test", DATABASE_ENVIRONMENT: "test",
        DATABASE_URL: local, SOURCE_DATABASE_URL: local, TEST_DATABASE_URL: local, ...overrides },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(expected);
  });
});

describe("backup drill cleanup ownership (source contract)", () => {
  const source = readFileSync(new URL("../scripts/verify-backup.mjs", import.meta.url), "utf8");

  it("registers ownership only after each CREATE succeeds", () => {
    for (const name of ["sourceDb", "restoreDb"]) {
      const create = 'await admin.query(`CREATE DATABASE ${' + name + '}`);';
      expect(source).toContain(create + "\n  ownedDatabases.push(" + name + ");");
    }
    expect(source).toContain("const ownedDatabases = [];");
    expect(source).not.toContain("for (const name of [sourceDb, restoreDb])");
  });

  it("closes the application pool in finally before dropping fixture databases", () => {
    const cleanup = source.slice(source.lastIndexOf("} finally {"));
    expect(cleanup).toContain("await db.resetPoolForTesting()");
    expect(cleanup).toContain('check("close application fixture pool", false)');
    expect(cleanup.indexOf("await db.resetPoolForTesting()")).toBeLessThan(cleanup.indexOf("for (const name of ownedDatabases.reverse())"));
  });

  it("cleans only registered databases and fails the drill if both drops fail", () => {
    expect(source).toContain("for (const name of ownedDatabases.reverse())");
    expect(source).toContain("check(`cleanup of owned fixture ${name}`, false);");
  });
});
