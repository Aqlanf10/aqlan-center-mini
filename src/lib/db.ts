/**
 * Public database entrypoint for the rest of the application.
 *
 * Usage:
 *   import { db, schema } from "@/lib/db";
 *   const rows = await db.select().from(schema.patients);
 */
export { db, schema, type Database } from "@/db";
