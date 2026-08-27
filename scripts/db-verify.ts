/**
 * Production database verification for Aqlan Center Mini.
 *
 * Runs read-only SQL against the same DATABASE_URL the app uses.
 * Prints ONLY non-sensitive facts: database name, schema, table
 * existence, migration journal state, and admin account presence.
 * Never prints connection strings, credentials, or passwords.
 *
 * Usage: npm run db:verify
 */
import "dotenv/config";
import { sql } from "drizzle-orm";

import { db } from "../src/db";

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
  const maybe = result as { rows?: Row[] };
  return maybe.rows ?? [];
}

async function main(): Promise<void> {
  console.log("=== DATABASE VERIFICATION (read-only) ===");

  // 1. Current database + schema
  const idRows = await q(sql`select current_database() as db, current_schema() as schema`);
  const identity = idRows[0] as { db: string; schema: string } | undefined;
  console.log(`current_database: ${identity?.db ?? "unknown"}`);
  console.log(`current_schema:   ${identity?.schema ?? "unknown"}`);

  // 2. All user tables
  const tableRows = await q(sql`
    select table_schema, table_name
    from information_schema.tables
    where table_schema not in ('pg_catalog', 'information_schema')
    order by table_schema, table_name
  `);
  console.log(`\nuser tables (${tableRows.length}):`);
  const tableNames = new Set<string>();
  for (const row of tableRows) {
    console.log(`  ${row.table_schema}.${row.table_name}`);
    tableNames.add(String(row.table_name));
  }

  // 3. Expected tables check
  console.log("\nexpected tables:");
  for (const name of EXPECTED_TABLES) {
    console.log(`  ${name}: ${tableNames.has(name) ? "YES" : "NO"}`);
  }

  // 4. Drizzle migration journal (drizzle schema, __drizzle_migrations)
  const journalRows = await q(sql`
    select table_schema, table_name
    from information_schema.tables
    where table_name like '%drizzle%migrations%'
  `);
  let appliedCount = 0;
  if (journalRows.length > 0) {
    for (const row of journalRows) {
      try {
        const counts = await q(
          sql`select count(*)::int as count from ${sql.identifier(String(row.table_schema))}.${sql.identifier(String(row.table_name))}`
        );
        const count = Number((counts[0] as { count: number } | undefined)?.count ?? 0);
        if (String(row.table_name).includes("__drizzle_migrations")) appliedCount = count;
        console.log(`\nmigration journal: ${row.table_schema}.${row.table_name} (${count} rows)`);
      } catch {
        console.log(`\nmigration journal: ${row.table_schema}.${row.table_name} (count failed)`);
      }
    }
    console.log(`drizzle journal: FOUND, applied migrations: ${appliedCount}`);
  } else {
    console.log("\nmigration journal: NOT FOUND");
  }

  // 5. users columns (Better Auth compatibility)
  if (tableNames.has("users")) {
    const colRows = await q(sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'users'
      order by ordinal_position
    `);
    console.log(`\nusers columns (${colRows.length}): ${colRows.map((c) => c.column_name).join(", ")}`);

    // 6. Admin account state
    try {
      const adminRows = await q(
        sql`select id, username, role, active from users where username = 'admin' limit 1`
      );
      const admin = adminRows[0] as { id: string; username: string; role: string; active: boolean } | undefined;
      console.log(`\nadmin user exists: ${admin ? "YES" : "NO"}`);
      if (admin) {
        console.log(`admin role: ${admin.role}, active: ${admin.active}`);
        const acctRows = await q(
          sql`select provider_id, count(*)::int as count from accounts where user_id = ${admin.id} group by provider_id`
        );
        for (const a of acctRows) {
          console.log(`admin account provider: ${a.provider_id} (x${a.count})`);
        }
        console.log(`credential account exists: ${acctRows.some((a) => a.provider_id === "credential") ? "YES" : "NO"}`);
        const sessRows = await q(sql`select count(*)::int as count from sessions`);
        console.log(`sessions rows: ${(sessRows[0] as { count: number } | undefined)?.count ?? 0}`);
      }
    } catch (error) {
      console.log(`\nadmin check failed: ${(error as Error).message}`);
    }
  } else {
    console.log("\nadmin check skipped (users table missing)");
  }

  console.log("\n=== VERIFICATION DONE ===");
  process.exit(0);
}

main().catch((error: Error) => {
  console.error("VERIFICATION FAILED:", error.message);
  process.exit(1);
});
