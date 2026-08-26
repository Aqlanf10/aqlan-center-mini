import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and provide the Neon PostgreSQL connection string."
    );
  }
  return url;
}

/**
 * Drizzle client over Neon's serverless HTTP driver.
 *
 * The connection is lazy: nothing touches the database until the first
 * query is executed, so builds never require a live database.
 */
export const db = drizzle(neon(resolveDatabaseUrl()), { schema });

export type Database = typeof db;

export { schema };
