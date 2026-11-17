import { describe, expect, it } from "vitest";
import { validateStandaloneWitnessEnvironment } from "./postgres/_standalone-restore-witness-guard";

const valid: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  GITHUB_ACTIONS: "true", CI: "true", GITHUB_RUN_ID: "123456",
  GITHUB_WORKSPACE: "/tmp/synthetic-workspace", SYNTHETIC_PRESERVE_EVIDENCE: "1",
  SYNTHETIC_STANDALONE_SERVER: "/tmp/synthetic-workspace/.next/standalone/server.js",
  TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:55472/aqlan_p1_test?sslmode=disable",
  DATABASE_URL: "postgresql://ci:ci@127.0.0.1:55472/aqlan_p1_test?sslmode=disable",
};

describe("standalone restore witness target gate", () => {
  it("accepts only the exact dedicated CI target", () => {
    expect(() => validateStandaloneWitnessEnvironment(valid)).not.toThrow();
  });
  it.each([
    { GITHUB_ACTIONS: "false" }, { CI: "false" }, { GITHUB_RUN_ID: "local" },
    { SYNTHETIC_PRESERVE_EVIDENCE: "0" },
    { TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:55472/other?sslmode=disable" },
    { TEST_DATABASE_URL: "postgresql://ci:ci@127.0.0.1:55472/aqlan_p1_test?host=example.com" },
    { DATABASE_URL: "postgresql://ci:ci@example.com/aqlan_p1_test" },
    { RAILWAY_PROJECT_ID: "synthetic-marker" },
    { SYNTHETIC_STANDALONE_SERVER: "/tmp/elsewhere/.next/standalone/server.js" },
  ])("refuses unsafe configuration before connecting: %#", (change) => {
    expect(() => validateStandaloneWitnessEnvironment({ ...valid, ...change })).toThrow();
  });
});
