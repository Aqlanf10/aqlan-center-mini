import { Client } from "pg";

import {
  AQLAN_CENTER_MINI_DATABASE_NAME,
  assertCorrectDatabaseProject,
} from "../lib/database-scope";
import {
  ensureSchema,
  getPool,
  rawConnectionStringFromEnv,
  sslFor,
} from "../lib/db";

async function main(): Promise<void> {
  assertCorrectDatabaseProject();

  const configuredConnectionString = rawConnectionStringFromEnv();
  if (!configuredConnectionString) {
    throw new Error("DATABASE_URL غير مضبوط.");
  }
  const tunnelPort = process.env.RAILWAY_DB_TUNNEL_PORT?.trim();
  const adminUrl = new URL(configuredConnectionString);
  if (tunnelPort) {
    if (!/^\d{2,5}$/.test(tunnelPort)) {
      throw new Error("RAILWAY_DB_TUNNEL_PORT غير صالح.");
    }
    adminUrl.hostname = "127.0.0.1";
    adminUrl.port = tunnelPort;
    adminUrl.searchParams.set("sslmode", "no-verify");
  }
  const adminConnectionString = adminUrl.toString();
  process.env.DATABASE_URL = adminConnectionString;
  if (!/^[a-z][a-z0-9_]*$/.test(AQLAN_CENTER_MINI_DATABASE_NAME)) {
    throw new Error("اسم قاعدة البيانات المخصصة غير آمن.");
  }

  const admin = new Client({
    connectionString: adminConnectionString,
    ssl: sslFor(adminConnectionString),
  });

  await admin.connect();
  try {
    const existing = await admin.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
      [AQLAN_CENTER_MINI_DATABASE_NAME],
    );

    if (!existing.rows[0]?.exists) {
      await admin.query(`CREATE DATABASE "${AQLAN_CENTER_MINI_DATABASE_NAME}"`);
      console.log(`Created isolated database: ${AQLAN_CENTER_MINI_DATABASE_NAME}`);
    } else {
      console.log(`Isolated database already exists: ${AQLAN_CENTER_MINI_DATABASE_NAME}`);
    }
  } finally {
    await admin.end();
  }

  await ensureSchema();
  await getPool().end?.();
  console.log("Aqlan Center Mini v2 schema is ready.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Database provisioning failed.");
  process.exitCode = 1;
});
