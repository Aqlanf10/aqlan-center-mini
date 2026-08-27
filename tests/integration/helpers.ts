import fs from "node:fs";
import path from "node:path";

import fsExtra from "node:fs";
import postgres, { type Sql } from "postgres";

/**
 * Helpers for PostgreSQL integration tests.
 *
 * Each test file gets its own database (created from the migration files —
 * a real install-from-scratch) and sets process.env.DATABASE_URL so the
 * application modules under @/ resolve their lazy singleton to it.
 */

const CONFIG_FILE = path.resolve(
  import.meta.dirname,
  "../../node_modules/.cache/pg-test-connection.json"
);

const DRIZZLE_DIR = path.resolve(import.meta.dirname, "../../drizzle");

export function readPgUrl(): string {
  const config = JSON.parse(fsExtra.readFileSync(CONFIG_FILE, "utf8")) as {
    url: string;
  };
  return config.url;
}

/** Apply every drizzle migration file (in order) to the connected database. */
export async function applyMigrations(sql: Sql): Promise<void> {
  const files = fs
    .readdirSync(DRIZZLE_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const raw = fs.readFileSync(path.join(DRIZZLE_DIR, file), "utf8");
    const statements = raw
      .split("--> statement-breakpoint")
      .map((chunk) => chunk.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
  }
}

export type TestDatabase = {
  /** Connection string of the fresh database (already migrated). */
  url: string;
  /** Admin client on the maintenance database (for extra statements). */
  admin: Sql;
  dbName: string;
  cleanup: () => Promise<void>;
};

/**
 * Create a uniquely-named database and apply ALL migrations to it.
 * Sets process.env.DATABASE_URL — import application modules AFTER calling
 * this (their lazy db singleton reads the variable on first query).
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = readPgUrl();
  const admin = postgres(adminUrl, { max: 1 });
  const dbName =
    "t_" +
    Date.now().toString(36) +
    "_" +
    Math.random().toString(36).slice(2, 8);

  await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  const dbUrl = adminUrl.replace(/\/[^/]+$/, `/${dbName}`);

  const migrator = postgres(dbUrl, { max: 1 });
  try {
    await applyMigrations(migrator);
  } finally {
    await migrator.end();
  }

  process.env.DATABASE_URL = dbUrl;

  return {
    url: dbUrl,
    admin,
    dbName,
    cleanup: async () => {
      // Terminate every connection to the test database (including the app
      // singleton's pool) so DROP DATABASE cannot be blocked.
      await admin.unsafe(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`
      );
      await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    },
  };
}

/** Parse a Postgres numeric string to minor units safely in tests. */
export function toMinor(amount: string | number | null): number {
  if (amount === null) return Number.NaN;
  return Math.round(parseFloat(String(amount)) * 100);
}
