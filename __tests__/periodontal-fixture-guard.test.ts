import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertPeriodontalFixtureIdentity, validatePeriodontalFixtureTarget } from "./postgres/_periodontal-fixture";

const safe: NodeJS.ProcessEnv = { TEST_DATABASE_URL: "postgresql://synthetic@127.0.0.1:5432/aqlan_p1_test?sslmode=disable", NODE_ENV: "test" };
const unsafeOverrides: Partial<NodeJS.ProcessEnv>[] = [
  { TEST_DATABASE_URL: "postgresql://synthetic@db.example/aqlan_p1_test" },
  { TEST_DATABASE_URL: "postgresql://synthetic@127.0.0.1/real_patient_data" },
  { TEST_DATABASE_URL: "postgresql://synthetic@127.0.0.1/aqlan_p1_test?host=remote" },
  { TEST_DATABASE_URL: "" }, { NODE_ENV: "production" }, { DATABASE_ENVIRONMENT: "production" },
  { RAILWAY_PROJECT_ID: "present" }, { RAILWAY_ENVIRONMENT_ID: "present" }, { USE_LOCAL_DB: "true" },
  { POSTGRES_URL: "postgresql://synthetic@db.example/other" },
];
describe("periodontal PG fixture admission (pure; no connection or SQL)", () => {
  it("admits only the canonical synthetic test target and derives maintenance safely", () => {
    const target = validatePeriodontalFixtureTarget(safe);
    expect(target.testUrl.pathname).toBe("/aqlan_p1_test");
    expect(target.maintenanceUrl.pathname).toBe("/postgres");
  });
  it.each(unsafeOverrides)("refuses unsafe original environment %j", (override) => {
    expect(() => validatePeriodontalFixtureTarget({ ...safe, ...override })).toThrow();
  });
  it("requires exact generated name, database OID and owner before cleanup", () => {
    const name = `aqlan_perio_${"a".repeat(32)}`;
    const row = { name, oid: "123", owner: "10" };
    expect(() => assertPeriodontalFixtureIdentity(name, "123", row, "10")).not.toThrow();
    for (const wrong of [{ ...row, name: `${name}\n` }, { ...row, oid: "124" }, { ...row, owner: "11" }]) {
      expect(() => assertPeriodontalFixtureIdentity(name, "123", wrong, "10")).toThrow();
    }
    expect(() => assertPeriodontalFixtureIdentity("aqlan_p1_test", "123", row, "10")).toThrow();
  });
  it("does not reset an existing target or use force cleanup", () => {
    const source = readFileSync("__tests__/postgres/_periodontal-fixture.ts", "utf8");
    expect(source).toContain('CREATE DATABASE "${name}" TEMPLATE template0');
    expect(source).not.toMatch(/DROP DATABASE IF EXISTS|WITH \(FORCE\)|DROP SCHEMA|dropPublicSchema/);
    expect(source).toContain("created = true");
    expect(source).toContain("assertPeriodontalFixtureIdentity(name, identity.oid, rows[0], identity.owner)");
  });
});
