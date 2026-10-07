import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertBackupTimestampFixtureIdentity, validateBackupTimestampFixtureTarget } from "./postgres/_backup-timestamp-fixture";

const safe: NodeJS.ProcessEnv = {
  TEST_DATABASE_URL: "postgresql://synthetic@127.0.0.1:5432/aqlan_p1_test?sslmode=disable",
  NODE_ENV: "test",
};
const unsafe: Partial<NodeJS.ProcessEnv>[] = [
  { TEST_DATABASE_URL: "postgresql://synthetic@db.example/aqlan_p1_test" },
  { TEST_DATABASE_URL: "postgresql://synthetic@127.0.0.1/real_patient_data" },
  { TEST_DATABASE_URL: "postgresql://synthetic@127.0.0.1/aqlan_p1_test?host=remote" },
  { TEST_DATABASE_URL: "" }, { NODE_ENV: "production" }, { DATABASE_ENVIRONMENT: "production" },
  { RAILWAY_PROJECT_ID: "present" }, { RAILWAY_ENVIRONMENT_ID: "present" }, { USE_LOCAL_DB: "true" },
  { POSTGRES_URL: "postgresql://synthetic@db.example/other" },
];

describe("backup timestamp fixture admission (pure; no connection or SQL)", () => {
  it("derives maintenance only from the validated synthetic test target", () => {
    const target = validateBackupTimestampFixtureTarget(safe);
    expect(target.testUrl.pathname).toBe("/aqlan_p1_test");
    expect(target.maintenanceUrl.pathname).toBe("/postgres");
  });
  it.each(unsafe)("rejects unsafe original environment %j", (override) => {
    expect(() => validateBackupTimestampFixtureTarget({ ...safe, ...override })).toThrow();
  });
  it("requires generated name, database OID and owner before cleanup", () => {
    const expected = { name: `aqlan_backup_precision_${"a".repeat(32)}`, oid: "123", owner: "10" };
    expect(() => assertBackupTimestampFixtureIdentity(expected, { ...expected })).not.toThrow();
    for (const actual of [
      { ...expected, name: `${expected.name}\n` }, { ...expected, oid: "124" }, { ...expected, owner: "11" },
    ]) expect(() => assertBackupTimestampFixtureIdentity(expected, actual)).toThrow();
    for (const name of ["aqlan_p1_test", `${expected.name}\n`, `${expected.name}x`]) {
      expect(() => assertBackupTimestampFixtureIdentity({ ...expected, name }, { ...expected, name })).toThrow();
    }
  });
  it("never resets a supplied DB, registers migrations or forces cleanup", () => {
    const source = readFileSync("__tests__/postgres/_backup-timestamp-fixture.ts", "utf8");
    expect(source).toContain('CREATE DATABASE "${name}" TEMPLATE template0');
    expect(source).not.toMatch(/DROP DATABASE IF EXISTS|WITH \(FORCE\)|DROP SCHEMA|dropPublicSchema|ensureSchema|PERIODONTAL_SQL/);
    expect(source.indexOf("owned.push(database)")).toBeGreaterThan(source.indexOf('CREATE DATABASE "${name}"'));
    expect(source).toContain("assertBackupTimestampFixtureIdentity(database.identity, rows[0])");
    expect(source).not.toMatch(/process\.env\s*\[.*\]\s*=|process\.env\.\w+\s*=/);
  });
});
