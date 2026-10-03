import { afterAll, beforeAll } from "vitest";
import { inventoryCalendarDateContract } from "../helpers/inventory-calendar-date";
import { validatePostgresTestTarget } from "./_safe-target";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";

// Guard the original target before any test environment stubbing can remove
// Railway markers. Synthetic append-only fixtures in an owned test DB only.
// No schema reset, historical updates, Production target or global PG parser.
validatePostgresTestTarget(process.env, { allowDatabaseUrlFallback: true });
assertRealPostgresUrl();
stubPostgresEnv();
const db = await import("../../lib/db");

beforeAll(async () => {
  await db.resetPoolForTesting();
  await db.ensureSchema();
}, 180_000);

afterAll(async () => { await db.resetPoolForTesting(); });

inventoryCalendarDateContract("PostgreSQL", () => db);
