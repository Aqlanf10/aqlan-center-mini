import type { DbPool } from "./db";
import { DEFAULT_SERVICES } from "./services-catalog";
import { withTransaction } from "./transactions";

/**
 * Seed the billing catalog once, on one checked-out connection. Pool.query()
 * releases its connection after each statement, which can lose the transaction
 * and its advisory lock when another request borrows that connection.
 *
 * This helper deliberately does not initialize the schema: its caller is already
 * inside ensureSchema(). Keep the catalog and its marker in the same transaction.
 */
export async function seedDefaultServices(pool: DbPool): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(7461)`);
    const marker = await client.query<{ key: string }>(
      `SELECT key FROM settings WHERE key = 'services.seeded' FOR UPDATE`,
    );
    if (!marker.rows[0]) {
      // Preserve an owner-created catalog; record the decision even when nonempty.
      const existing = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM services`,
      );
      if (Number(existing.rows[0]?.count ?? "0") === 0) {
        await client.query(
          `INSERT INTO services (name, category, price_minor, sort_order)
           SELECT x.name, x.category, x.price, x.sort_order
           FROM unnest($1::text[], $2::text[], $3::bigint[], $4::int[])
                AS x(name, category, price, sort_order)`,
          [
            DEFAULT_SERVICES.map((s) => s.name),
            DEFAULT_SERVICES.map((s) => s.category),
            DEFAULT_SERVICES.map((s) => s.priceMinor),
            DEFAULT_SERVICES.map((s) => s.sortOrder),
          ],
        );
      }
      await client.query(
        `INSERT INTO settings (key, value) VALUES ('services.seeded', '1')
         ON CONFLICT (key) DO NOTHING`,
      );
    }
  });
}
