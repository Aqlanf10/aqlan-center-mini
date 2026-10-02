import type { DbPool } from "./db";
import { DEFAULT_LAB_SERVICES } from "./lab";

/**
 * Bootstrap only an empty lab catalog, without overwriting or filling an existing
 * owner's catalog. One statement keeps all new defaults atomic if any row fails.
 * Never call the explicit owner reset here: it initializes the schema again and
 * intentionally updates existing rows, which is not startup's responsibility.
 */
export async function seedDefaultLabServices(pool: DbPool): Promise<void> {
  await pool.query(
    `INSERT INTO lab_services (
       name, code, category, tooth_scope, requires_shade,
       default_days, description, sort_order
     )
     SELECT x.name, x.code, x.category, x.tooth_scope, x.requires_shade,
            x.default_days, x.description, x.sort_order
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[],
                   $5::boolean[], $6::int[], $7::text[], $8::int[])
         AS x(name, code, category, tooth_scope, requires_shade,
              default_days, description, sort_order)
      WHERE NOT EXISTS (SELECT 1 FROM lab_services)
     ON CONFLICT (code) DO NOTHING`,
    [
      DEFAULT_LAB_SERVICES.map((item) => item.name),
      DEFAULT_LAB_SERVICES.map((item) => item.code),
      DEFAULT_LAB_SERVICES.map((item) => item.category),
      DEFAULT_LAB_SERVICES.map((item) => item.toothScope),
      DEFAULT_LAB_SERVICES.map((item) => item.requiresShade),
      DEFAULT_LAB_SERVICES.map((item) => item.defaultDays),
      DEFAULT_LAB_SERVICES.map((item) => item.description),
      DEFAULT_LAB_SERVICES.map((item) => item.sortOrder),
    ],
  );
}
