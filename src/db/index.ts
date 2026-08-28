import postgres, { type Sql } from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import * as schema from "./schema";

/**
 * PostgreSQL client over the `postgres` (postgres.js) wire-protocol driver.
 *
 * Designed for standard PostgreSQL — including Railway — and works the same
 * way for local development:
 *
 * - Every connection parameter (host, port, user, password, database, ssl)
 *   comes from `DATABASE_URL` (or the optional `DATABASE_SSL` /
 *   `DATABASE_POOL_MAX` overrides). Nothing is hard-coded.
 * - SSL is derived from the connection string:
 *     1. `DATABASE_SSL=true|false` wins when set (explicit override).
 *     2. `sslmode=...` / `ssl=...` URL parameters are honored natively by
 *        postgres.js (`require`/`prefer` enable TLS, `disable` turns it off,
 *        `verify-full` verifies certificates).
 *     3. With no explicit parameter, TLS is enabled automatically for remote
 *        hosts (e.g. Railway's public database proxy) and disabled for local
 *        development and private-network hosts (`localhost`, `127.0.0.1`,
 *        `::1`, `*.internal` such as Railway's private networking).
 * - One client per process (singleton, kept across Next.js dev hot reloads
 *   via `globalThis`). postgres.js pools connections internally — do not
 *   create a client per request/query.
 */

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (LOCAL_HOSTNAMES.has(host)) {
    return true;
  }
  // Railway private networking (and similar) uses *.internal hostnames
  // that do not terminate TLS on the database port.
  return host.endsWith(".internal") || host.endsWith(".internal.");
}

/**
 * Pure decision function (unit-tested in ssl.test.ts):
 *   DATABASE_SSL env > explicit sslmode/ssl URL param (handled natively by
 *   postgres.js) > default: TLS for remote hosts, plain for local/private.
 */
export function resolveSsl(
  url: URL,
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean | "verify-full" | undefined {
  const override = env.DATABASE_SSL?.trim().toLowerCase();
  if (override === "true") return true;
  if (override === "false") return false;
  if (override === "verify-full") return "verify-full";

  // An explicit sslmode/ssl in the URL is handled by postgres.js itself —
  // do not interfere (return undefined = pass the URL through untouched).
  const mode = (
    url.searchParams.get("sslmode") ?? url.searchParams.get("ssl")
  )?.toLowerCase();
  if (mode) {
    return undefined;
  }

  return !isLocalOrPrivateHost(url.hostname);
}

function createSqlClient(): Sql {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and provide the PostgreSQL connection string (Railway provides it as a reference variable)."
    );
  }

  const parsed = new URL(url);
  const ssl = resolveSsl(parsed);
  const max = Number.parseInt(process.env.DATABASE_POOL_MAX ?? "", 10);

  return postgres(url, {
    // A single logical service = a modest pool. Override via DATABASE_POOL_MAX.
    max: Number.isFinite(max) && max > 0 ? max : 10,
    idle_timeout: 30, // return idle connections after 30s
    connect_timeout: 10, // fail fast when the database is unreachable
    ...(ssl === undefined ? {} : { ssl }),
  });
}

type Database = ReturnType<typeof createDatabase>;

function createDatabase() {
  const globalStore = globalThis as typeof globalThis & {
    __aqlanCenterPgClient?: Sql;
  };
  // Reuse the singleton across HMR reloads and module duplicates.
  const client = (globalStore.__aqlanCenterPgClient ??= createSqlClient());
  return drizzle(client, { schema });
}

let database: Database | undefined;

/**
 * Drizzle client over postgres.js.
 *
 * Lazily initialized: nothing reads `DATABASE_URL` (and no socket is opened)
 * until the first query executes, so production builds and CI never require
 * a live database. The first failed call throws a clear error.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, property, receiver) {
    database ??= createDatabase();
    const value = Reflect.get(database as object, property, receiver);
    return typeof value === "function" ? value.bind(database) : value;
  },
});

export { schema };
export type { Database };
