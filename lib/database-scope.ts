type RailwayEnvironment = Readonly<Record<string, string | undefined>>;

/** بيانات المحاكي وحساباته لا تدخل قاعدة تشغيل فعلية. */
export function allowLocalDemoData(environment: RailwayEnvironment = process.env): boolean {
  return environment.USE_LOCAL_DB === "true" && environment.NODE_ENV !== "production" && !environment.RAILWAY_PROJECT_ID;
}

/** Railway project that owns Aqlan Center Mini and its PostgreSQL service. */
export const AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID =
  "7f3b5a7b-4508-4b7f-be3d-ad268fc5675a";

/**
 * Dedicated database for the rebuilt application inside Mini's PostgreSQL
 * service. The existing `railway` database remains untouched as a rollback
 * source until the owner approves the final cutover.
 */
export const AQLAN_CENTER_MINI_DATABASE_NAME = "aqlan_center_mini_v2";

export type DatabaseProjectScope =
  | "local"
  | "correct-project"
  | "wrong-project";

export function databaseProjectScope(
  environment: RailwayEnvironment = process.env,
): DatabaseProjectScope {
  const currentProjectId = environment.RAILWAY_PROJECT_ID?.trim();

  // Local development and CI do not have Railway's runtime identity. Their
  // DATABASE_URL is supplied explicitly and is allowed to point at a disposable
  // test database.
  if (!currentProjectId) return "local";

  return currentProjectId === AQLAN_CENTER_MINI_RAILWAY_PROJECT_ID
    ? "correct-project"
    : "wrong-project";
}

export function assertCorrectDatabaseProject(
  environment: RailwayEnvironment = process.env,
): void {
  const scope = databaseProjectScope(environment);
  if (scope === "wrong-project") {
    throw new Error(
      "تم إيقاف الاتصال بقاعدة البيانات: هذا الفرع يعمل فقط داخل مشروع Aqlan Center Mini على Railway.",
    );
  }
}

function hasExplicitTrustedCa(environment: RailwayEnvironment): boolean {
  return Boolean(
    environment.PGSSL_ROOT_CERT_PEM?.trim()
    || environment.PGSSL_ROOT_CERT?.trim(),
  );
}

/**
 * node-postgres replaces an explicit `ssl` object when the connection URI itself
 * contains sslmode/sslcert/sslkey/sslrootcert. Inside the known Railway project,
 * once a trusted CA is configured, TLS policy must come from lib/db-tls.ts rather
 * than from URI query parameters. `sslmode=disable` is deliberately preserved so
 * the production TLS guard can reject it instead of silently stripping it.
 */
function removePgSslOverridesWhenUsingTrustedCa(
  target: URL,
  environment: RailwayEnvironment,
): void {
  if (!hasExplicitTrustedCa(environment)) return;

  const sslmode = target.searchParams.get("sslmode")?.toLowerCase();
  if (sslmode === "disable") return;

  target.searchParams.delete("sslmode");
  target.searchParams.delete("sslcert");
  target.searchParams.delete("sslkey");
  target.searchParams.delete("sslrootcert");
}

export function databaseUrlForProject(
  rawConnectionString: string,
  environment: RailwayEnvironment = process.env,
): string {
  if (databaseProjectScope(environment) === "local") {
    return rawConnectionString;
  }

  assertCorrectDatabaseProject(environment);
  const target = new URL(rawConnectionString);
  if (target.protocol !== "postgres:" && target.protocol !== "postgresql:") {
    throw new Error("رابط قاعدة البيانات ليس رابط PostgreSQL صالحًا.");
  }
  target.pathname = `/${AQLAN_CENTER_MINI_DATABASE_NAME}`;
  removePgSslOverridesWhenUsingTrustedCa(target, environment);
  return target.toString();
}
