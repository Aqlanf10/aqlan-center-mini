/** Pure target policy shared by plain-Node verification CLIs and TS harnesses.
 * Never import pg, runtime bootstrap, environment loaders, or filesystem tools.
 * The static environment diagnostic retains its broader remote policy. */
export const RUNTIME_DATABASE_URL_ENV_NAMES = Object.freeze([
  "DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "POSTGRES_URL_NON_POOLING",
]);

export const GATE_DATABASE_URL_ENV_NAMES = Object.freeze([
  ...RUNTIME_DATABASE_URL_ENV_NAMES, "TEST_DATABASE_URL", "SOURCE_DATABASE_URL",
]);

// Known runtime identities only. A local Railway CLI credential is not one.
export const RAILWAY_ENV_NAMES = Object.freeze([
  "RAILWAY_PROJECT_ID", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_SERVICE_ID",
  "RAILWAY_DEPLOYMENT_ID", "RAILWAY_PUBLIC_DOMAIN", "RAILWAY_PRIVATE_DOMAIN",
  "RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_VOLUME_MOUNT_PATH",
  "RAILWAY_GIT_COMMIT_SHA", "RAILWAY_DB_TUNNEL_PORT", "RAILWAY_MOUNTS",
  "RAILWAY_MOUNTS_TMPFS_DATA",
]);

export function isLoopbackHost(host) {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function looksLikeRailwayDatabaseHost(host) {
  const normalized = host.trim().toLowerCase();
  return normalized.endsWith(".rlwy.net")
    || normalized.endsWith(".railway.app")
    || normalized.endsWith(".railway.internal")
    || normalized === "railway.internal";
}

export function validateLocalVerificationEnvironment(environment, errorPrefix = "VERIFICATION_UNSAFE_TARGET") {
  // Match explicitDatabaseEnvironment's target classification normalization;
  // NODE_ENV retains the application's exact runtime-flag semantics.
  const databaseEnvironment = environment.DATABASE_ENVIRONMENT?.trim().toLowerCase();
  if (environment.NODE_ENV === "production" || databaseEnvironment === "production") {
    throw new Error(`${errorPrefix}: production environment is forbidden.`);
  }
  for (const name of RAILWAY_ENV_NAMES) {
    if (environment[name]?.trim()) {
      throw new Error(`${errorPrefix}: Railway runtime detected via ${name}.`);
    }
  }
}

/** pg query options can change the host/database or read SSL files while a
 * Client is constructed. Keep the canonical #185 allowlist and error contract. */
export function validateVerificationQueryParameters(url) {
  const parameters = [...url.searchParams];
  if (parameters.length > 1 || parameters.some(([key, value]) => key !== "sslmode" || value !== "disable")) {
    throw new Error("POSTGRES_TEST_UNSAFE_QUERY: only one sslmode=disable parameter is permitted.");
  }
}

function hasMalformedPercentEncoding(value) {
  return /%(?![0-9a-f]{2})/i.test(value);
}

export function validateLocalVerificationTarget(raw, environment, {
  varName,
  databaseName,
  errorPrefix = "VERIFICATION_UNSAFE_TARGET",
}) {
  if (!raw?.trim()) throw new Error(`${errorPrefix}: ${varName} is required.`);
  validateLocalVerificationEnvironment(environment, errorPrefix);
  let target;
  try {
    target = new URL(raw.trim());
  } catch {
    throw new Error(`${errorPrefix}: ${varName} is not a valid URL.`);
  }
  if (target.protocol !== "postgresql:" && target.protocol !== "postgres:") {
    throw new Error(`${errorPrefix}: PostgreSQL URL required.`);
  }
  if (!isLoopbackHost(target.hostname) || looksLikeRailwayDatabaseHost(target.hostname)) {
    throw new Error(`${errorPrefix}: loopback PostgreSQL only.`);
  }
  let configuredDb;
  try {
    // Match pg-connection-string exactly: remove one path separator, and keep
    // reserved escapes literal. //aqlan_p1_test is a different database.
    configuredDb = decodeURI(target.pathname.slice(1));
  } catch {
    throw new Error(`${errorPrefix}: ${varName} has an invalid database name.`);
  }
  if (databaseName !== undefined && configuredDb !== databaseName) {
    throw new Error(`${errorPrefix}: ${varName} must target ${databaseName}.`);
  }
  if (!configuredDb.trim()) {
    throw new Error(`${errorPrefix}: ${varName} must name an explicit database.`);
  }
  validateVerificationQueryParameters(target);
  // Even a malformed fragment/credential escape can trigger pg's whole-string
  // encodeURI preprocessing and change an otherwise validated database name.
  if (hasMalformedPercentEncoding(target.toString())) {
    throw new Error(`${errorPrefix}: ${varName} has invalid percent encoding.`);
  }
  try {
    decodeURIComponent(target.username);
    decodeURIComponent(target.password);
  } catch {
    throw new Error(`${errorPrefix}: ${varName} has invalid credential encoding.`);
  }
  return target;
}

/** Mutating operational tools are loopback-only. This does not alter the
 * broader static checkDatabaseUrlForGates diagnostic or integration DB role.
 * Validate original aliases and markers before a caller rewrites DATABASE_URL.
 * Missing maintenance still permits verify-ci to report its existing SKIPs. */
export function validateOperationalVerificationEnvironment(environment, { requireSource = false } = {}) {
  validateLocalVerificationEnvironment(environment);
  if (requireSource && environment.USE_LOCAL_DB === "true") {
    throw new Error("VERIFICATION_UNSAFE_TARGET: this journey requires PostgreSQL, not USE_LOCAL_DB.");
  }
  for (const varName of GATE_DATABASE_URL_ENV_NAMES) {
    const raw = environment[varName];
    // Blank fallback aliases are absent, but an explicitly blank SOURCE wins
    // nullish selection and must never silently fall back to DATABASE_URL.
    if (raw === undefined || (!raw.trim() && varName !== "SOURCE_DATABASE_URL")) continue;
    // pg parses the original string, and its whitespace handling can differ
    // from URL(raw.trim()). Do not validate one host then forward another form.
    if (raw !== raw.trim()) {
      throw new Error(`VERIFICATION_UNSAFE_TARGET: ${varName} must not have surrounding whitespace.`);
    }
    if (/[\u0000-\u001f\u007f]/.test(raw)) {
      throw new Error(`VERIFICATION_UNSAFE_TARGET: ${varName} must not contain control characters.`);
    }
    if (raw.includes(" ") || hasMalformedPercentEncoding(raw)) {
      throw new Error(`VERIFICATION_UNSAFE_TARGET: ${varName} must use valid percent encoding, with no literal spaces.`);
    }
    validateLocalVerificationTarget(raw, environment, { varName });
  }
  const source = environment.SOURCE_DATABASE_URL ?? environment.DATABASE_URL;
  if (requireSource || source?.trim()) {
    return validateLocalVerificationTarget(source, environment, {
      varName: environment.SOURCE_DATABASE_URL !== undefined ? "SOURCE_DATABASE_URL" : "DATABASE_URL",
    }).toString();
  }
  return source;
}
