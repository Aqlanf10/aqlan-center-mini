import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";

import * as schema from "./schema";

function createDatabase() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and provide the Neon PostgreSQL connection string."
    );
  }
  return drizzle(neon(url), { schema });
}

type Database = ReturnType<typeof createDatabase>;

let database: Database | undefined;

/**
 * Drizzle client over Neon's serverless HTTP driver.
 *
 * Lazily initialized: nothing touches `DATABASE_URL` (or the network) until
 * the first query is executed, so production builds and CI never require a
 * live database. The first failed call throws a clear error message.
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
