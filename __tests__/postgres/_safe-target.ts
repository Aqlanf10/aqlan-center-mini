import {
  validateOwnershipHarnessEnvironment,
  type OwnershipHarnessTarget,
} from "../../scripts/verify-schema-ownership";

/** Test infrastructure only. pg connection-string query keys can override the
 * authority/database, so the ownership harness's URL check alone is insufficient. */
export function validatePostgresTestTarget(
  environment: NodeJS.ProcessEnv = process.env,
  options: { allowDatabaseUrlFallback?: boolean } = {},
): OwnershipHarnessTarget {
  // Retain the original classifications and Railway markers. Only an UNSET test
  // URL can use the documented global-setup fallback; never rescue an invalid one.
  const checkedEnvironment = options.allowDatabaseUrlFallback && environment.TEST_DATABASE_URL === undefined
    ? { ...environment, TEST_DATABASE_URL: environment.DATABASE_URL }
    : environment;
  const target = validateOwnershipHarnessEnvironment(checkedEnvironment);
  const parameters = [...target.testUrl.searchParams];
  if (parameters.length > 1 || parameters.some(([key, value]) => key !== "sslmode" || value !== "disable")) {
    throw new Error("POSTGRES_TEST_UNSAFE_QUERY: only one sslmode=disable parameter is permitted.");
  }
  return target;
}
