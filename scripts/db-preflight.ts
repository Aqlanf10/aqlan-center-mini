#!/usr/bin/env node
// Explicit environment only: intentionally does not auto-load .env files.
import { Client } from "pg";
import { decideTls } from "../lib/db-tls";
import { classifyDbTarget } from "../lib/db-target";
import { AQLAN_CENTER_MINI_DATABASE_NAME, databaseUrlForProject } from "../lib/database-scope";
import { loadMigrationFiles } from "../lib/migration-files";
import { inspectSchemaReadOnly, SchemaPreflightError, type SchemaPreflightReport } from "../lib/schema-preflight";

async function bounded<T>(operation: Promise<T>, milliseconds: number, timeout: SchemaPreflightError, destroy: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(timeout); destroy(); }, milliseconds);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

export function preflightConnection(env: NodeJS.ProcessEnv) {
  const raw = env.DATABASE_URL?.trim() ?? "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new SchemaPreflightError("DATABASE_URL_REQUIRED", "A valid explicit DATABASE_URL is required."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length < 2
    || env.USE_LOCAL_DB === "true") throw new SchemaPreflightError("POSTGRES_TARGET_REQUIRED", "An explicit PostgreSQL database is required.");
  // libpq URL options can override host/database or TLS decisions in node-postgres.
  if ([...url.searchParams.keys()].some((key) => !["sslmode", "application_name"].includes(key))) {
    throw new SchemaPreflightError("CONNECTION_OPTIONS_INVALID", "Unsupported connection URL options.");
  }
  // Match the application's existing logical-database routing. Railway's raw
  // URI may name its old default database while MINI uses its dedicated one.
  let effectiveUrl: string;
  try { effectiveUrl = databaseUrlForProject(raw, env); url = new URL(effectiveUrl); }
  catch { throw new SchemaPreflightError("PROJECT_SCOPE_INVALID", "Database project scope rejected this target."); }
  let target: ReturnType<typeof classifyDbTarget>;
  try { target = classifyDbTarget(effectiveUrl, env); }
  catch { throw new SchemaPreflightError("TARGET_CLASSIFICATION_INVALID", "Invalid target classification."); }
  if (!target.localHost && !target.explicit) throw new SchemaPreflightError("REMOTE_CLASSIFICATION_REQUIRED", "Remote targets require DATABASE_ENVIRONMENT.");
  if (target.environment === "production" && url.pathname !== `/${AQLAN_CENTER_MINI_DATABASE_NAME}`) {
    throw new SchemaPreflightError("APPLICATION_DATABASE_REQUIRED", "Production preflight requires MINI's effective database target.");
  }
  let tls: ReturnType<typeof decideTls>;
  try {
    tls = decideTls(effectiveUrl, {
      productionRuntime: target.environment === "production",
      rootCertPath: env.PGSSL_ROOT_CERT, rootCertPem: env.PGSSL_ROOT_CERT_PEM,
    });
  } catch { throw new SchemaPreflightError("TLS_POLICY_REJECTED", "TLS policy rejected this connection."); }
  // Keep the existing TLS decision authoritative; pg's sslmode URL parser must
  // not replace its explicit CA/rejectUnauthorized configuration.
  url.searchParams.delete("sslmode");
  return { connectionString: url.toString(), ssl: tls.ssl, environment: target.environment, tls: tls.mode };
}

export async function runPreflightCli(args = process.argv.slice(2), env = process.env): Promise<number> {
  if (args.length === 1 && args[0] === "--help") {
    console.log("db:preflight: explicit DATABASE_URL, plus DATABASE_ENVIRONMENT for remote targets. JSON only; no writes. Exit 0 = evidence collected, 1 = incomplete/failed. Registry status is separate from adoption readiness.");
    return 0;
  }
  if (args.length) throw new SchemaPreflightError("CLI_ARGUMENTS_INVALID", "Unsupported arguments.");
  const connection = preflightConnection(env);
  const files = await loadMigrationFiles().catch(() => {
    throw new SchemaPreflightError("MIGRATION_FILES_INVALID", "Migration files could not be validated.");
  });
  const client = new Client({
    connectionString: connection.connectionString, ssl: connection.ssl,
    connectionTimeoutMillis: 5_000, application_name: "aqlan-read-only-preflight",
  });
  // pg emits idle connection/FATAL errors outside a query promise. Listen before
  // connecting so those failures also reach the redacted CLI error handler.
  const connectionFailure = new Promise<never>((_resolve, reject) => {
    client.on("error", reject);
  });
  const destroy = () => { client.connection.stream.destroy(); };
  let report: SchemaPreflightReport | undefined;
  let failure: unknown;
  try {
    report = await bounded(Promise.race([
      (async () => {
        await client.connect();
        return inspectSchemaReadOnly(client, files);
      })(),
      connectionFailure,
    ]), 40_000, new SchemaPreflightError("CLIENT_TIMEOUT", "Preflight client deadline exceeded."), destroy);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await bounded(client.end(), 2_000, new SchemaPreflightError("CLEANUP_TIMEOUT", "Preflight cleanup deadline exceeded."), destroy);
    } catch (error) { failure ??= error; }
  }
  if (failure) throw failure;
  // Publish evidence only after bounded cleanup also succeeds.
  console.log(JSON.stringify({ ...report, targetEnvironment: connection.environment, tls: connection.tls }, null, 2));
  return 0;
}

export function preflightErrorCode(error: unknown): string {
  if (error instanceof SchemaPreflightError) return error.code;
  const code = (error as { code?: unknown })?.code;
  if (typeof code === "string" && (/^[A-Z0-9]{5}$/.test(code)
    || ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EHOSTUNREACH"].includes(code))) return code;
  return "PREFLIGHT_FAILED";
}

// Importable for validation tests; errors never print a URL, credentials, SQL,
// server detail, role name, application data or a partial catalog report.
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/db-preflight.ts")) {
  runPreflightCli().then((code) => { process.exitCode = code; }).catch((error: unknown) => {
    console.error(JSON.stringify({ error: preflightErrorCode(error), complete: false }));
    process.exitCode = 1;
  });
}
