import path from "node:path";
import { validateOperationalVerificationEnvironment } from "../../lib/verification-target-policy.mjs";

/** Called before the global setup or fixture opens any connection. */
export function validateStandaloneWitnessEnvironment(env: NodeJS.ProcessEnv): void {
  const ciDatabase = "postgresql://ci:ci@127.0.0.1:55472/aqlan_p1_test?sslmode=disable";
  if (env.GITHUB_ACTIONS !== "true" || env.CI !== "true" || !/^\d+$/.test(env.GITHUB_RUN_ID ?? "")
      || env.SYNTHETIC_PRESERVE_EVIDENCE !== "1" || env.TEST_DATABASE_URL !== ciDatabase
      || env.DATABASE_URL !== ciDatabase
      || !env.GITHUB_WORKSPACE || !path.isAbsolute(env.GITHUB_WORKSPACE)
      || env.SYNTHETIC_STANDALONE_SERVER !== path.join(env.GITHUB_WORKSPACE, ".next/standalone/server.js")) {
    throw new Error("Standalone restore witness requires the dedicated GitHub CI synthetic service and built server.");
  }
  // Check every original database alias and deployment marker, not merely the
  // URL from which our freshly created fixture names will be derived.
  validateOperationalVerificationEnvironment(env);
}
