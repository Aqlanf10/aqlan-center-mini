import {
  validateOwnershipHarnessEnvironment,
  type OwnershipHarnessTarget,
} from "../../scripts/verify-schema-ownership";

/** Test infrastructure only. Reuse the canonical ownership target/query guard
 * with the global setup's explicitly allowed DATABASE_URL fallback. */
export function validatePostgresTestTarget(
  environment: NodeJS.ProcessEnv = process.env,
  options: { allowDatabaseUrlFallback?: boolean } = {},
): OwnershipHarnessTarget {
  // Retain the original classifications and Railway markers. Only an UNSET test
  // URL can use the documented global-setup fallback; never rescue an invalid one.
  const checkedEnvironment = options.allowDatabaseUrlFallback && environment.TEST_DATABASE_URL === undefined
    ? { ...environment, TEST_DATABASE_URL: environment.DATABASE_URL }
    : environment;
  return validateOwnershipHarnessEnvironment(checkedEnvironment);
}
