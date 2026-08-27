import fs from "node:fs";
import path from "node:path";

import EmbeddedPostgres from "embedded-postgres";

/**
 * Global setup for PostgreSQL integration tests.
 *
 * Boots a REAL PostgreSQL 18 server (embedded binaries) once per test run
 * on a random port. Connection info is written to
 * node_modules/.cache/pg-test-connection.json for the test files; the
 * exported teardown stops the server after all tests finish.
 */

const CACHE_DIR = path.resolve(import.meta.dirname, "../../node_modules/.cache");
const CONFIG_FILE = path.join(CACHE_DIR, "pg-test-connection.json");
const DATA_DIR = path.join(CACHE_DIR, "pg-test-data");

export default async function globalSetup() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // Fresh cluster per run (initdb is cheap and avoids stale state).
  fs.rmSync(DATA_DIR, { recursive: true, force: true });

  const port = 40000 + Math.floor(Math.random() * 10000);

  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
  });

  await pg.initialise();
  await pg.start();

  const url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ url }), "utf8");
  console.log(`[integration] embedded PostgreSQL ready on port ${port}`);

  return async () => {
    fs.rmSync(CONFIG_FILE, { force: true });
    await pg.stop();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    console.log("[integration] embedded PostgreSQL stopped");
  };
}
