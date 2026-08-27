/**
 * Production release orchestrator for Aqlan Center Mini.
 *
 * Runs as a single Railway pre-deploy command (shell chaining with && was
 * observed to execute only the first command in pre-deploy, so this script
 * performs every release step inside one node process):
 *
 *   1. Apply Drizzle migrations (same journal as drizzle-kit migrate).
 *   2. Verify schema state (read-only proof, no secrets printed).
 *   3. Seed the first admin ONLY if missing AND ADMIN_USERNAME +
 *      ADMIN_PASSWORD are provided. Once the admin exists this is a no-op,
 *      so it stays safe on every deploy.
 *
 * Any failure exits non-zero and fails the deployment.
 * Usage: npm run db:release
 */
import "dotenv/config";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";

import { db } from "../src/db";
import { users } from "../src/db/schema";
import { auth } from "../src/lib/auth/server";

const EXPECTED_TABLES = [
  "users",
  "sessions",
  "accounts",
  "verifications",
  "patients",
  "appointments",
  "visits",
  "patient_contacts",
  "charges",
  "payments",
  "audit_logs",
] as const;

interface Row {
  [column: string]: unknown;
}

async function q(query: ReturnType<typeof sql>): Promise<Row[]> {
  const result: unknown = await db.execute(query);
  if (Array.isArray(result)) return result as Row[];
  return (result as { rows?: Row[] }).rows ?? [];
}

async function applyMigrations(): Promise<void> {
  console.log("[release] applying drizzle migrations ...");
  await migrate(db, { migrationsFolder: "drizzle" });
  console.log("[release] migrations: OK");
}

async function verifySchema(): Promise<void> {
  const idRows = await q(sql`select current_database() as db, current_schema() as schema`);
  const identity = idRows[0] as { db: string; schema: string } | undefined;
  console.log(`[release] database: ${identity?.db ?? "?"} schema: ${identity?.schema ?? "?"}`);

  const tableRows = await q(sql`
    select table_name from information_schema.tables
    where table_schema not in ('pg_catalog', 'information_schema')
    order by table_name
  `);
  const names = tableRows.map((r) => String(r.table_name));
  console.log(`[release] user tables (${names.length}): ${names.join(", ")}`);

  const missing = EXPECTED_TABLES.filter((t) => !names.includes(t));
  if (missing.length > 0) {
    throw new Error(`expected tables missing: ${missing.join(", ")}`);
  }
  console.log(`[release] all ${EXPECTED_TABLES.length} expected tables: PRESENT`);

  const journalRows = await q(sql`
    select count(*)::int as count
    from drizzle.__drizzle_migrations
  `);
  const applied = Number((journalRows[0] as { count: number } | undefined)?.count ?? 0);
  console.log(`[release] drizzle journal: ${applied} migrations applied`);
}

async function seedAdminIfMissing(): Promise<void> {
  const username = process.env.ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username ?? ""))
    .limit(1);

  if (existing) {
    console.log(`[release] admin "${username}": already exists (seed skipped)`);
    return;
  }

  if (!username || !password) {
    console.log("[release] admin: not present and ADMIN_* vars unset (skip seed)");
    return;
  }
  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must be at least 8 characters");
  }

  const name = process.env.ADMIN_NAME?.trim() || "System Administrator";
  const email =
    process.env.ADMIN_EMAIL?.trim().toLowerCase() ||
    `${username}@staff.aqlan-center.local`;

  console.log(`[release] seeding first admin "${username}" via Better Auth createUser ...`);
  const result = await auth.api.createUser({
    body: { name, email, password, role: "ADMIN", data: { username, active: true } },
  });
  const userId = result?.user?.id;
  if (!userId) {
    throw new Error("admin creation returned no user id");
  }
  await db
    .update(users)
    .set({ username, active: true, role: "ADMIN" })
    .where(eq(users.id, userId));

  const accounts = await q(
    sql`select provider_id from accounts where user_id = ${userId}`
  );
  const providers = accounts.map((a) => String(a.provider_id)).join(", ");
  if (!providers.includes("credential")) {
    throw new Error(`admin credential account missing (providers: ${providers})`);
  }
  console.log(`[release] admin "${username}" created with credential account (id: ${userId})`);
}

async function main(): Promise<void> {
  console.log("=== RELEASE: migrate -> verify -> seed-if-missing ===");
  await applyMigrations();
  await verifySchema();
  await seedAdminIfMissing();
  console.log("=== RELEASE COMPLETE ===");
}

main().catch((error: unknown) => {
  console.error("RELEASE FAILED:", error instanceof Error ? error.message : error);
  process.exit(1);
});
