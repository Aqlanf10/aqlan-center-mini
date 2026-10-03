import { afterAll, beforeAll, vi } from "vitest";
import { inventoryCalendarDateContract } from "./helpers/inventory-calendar-date";

// Exercise the actual local SQL writer/readers too: PGlite returns DATE as a
// UTC-midnight Date, unlike pg's local-midnight Date. No mocked row conversion.
let db: typeof import("../lib/db") | undefined;

beforeAll(async () => {
  vi.stubEnv("USE_LOCAL_DB", "true");
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("RAILWAY_PROJECT_ID", "");
  vi.stubEnv("SKIP_SEED", "true");
  db = await import("../lib/db");
  await db.resetPoolForTesting();
  await db.ensureSchema();
}, 60_000);

afterAll(async () => {
  try { await db?.resetPoolForTesting(); }
  finally { vi.unstubAllEnvs(); }
});

inventoryCalendarDateContract("PGlite", () => {
  if (!db) throw new Error("Inventory calendar-date database is not initialized");
  return db;
});
