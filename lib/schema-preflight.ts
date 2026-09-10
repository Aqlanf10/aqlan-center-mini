import type { DbPool } from "./db";

export interface SchemaRegistrationPreflight {
  registryExists: boolean;
  versions: string[];
  adoptedVersions: string[];
}

/**
 * فحص إنتاجي منخفض الأثر — SELECT فقط.
 *
 * لا ينشئ schema_migrations إن كان غائبًا، ولا يشغّل baseline probe ولا أي DDL.
 * الهدف في Final Production Activation هو معرفة هل قاعدة التشغيل دخلت نظام
 * الهجرات المُرقّمة قبل تعطيل ensureSchema التراكمي.
 */
export async function readSchemaRegistrationPreflight(
  pool: DbPool,
): Promise<SchemaRegistrationPreflight> {
  const { rows: registry } = await pool.query<{ exists: boolean }>(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists",
  );
  if (!registry[0]?.exists) {
    return { registryExists: false, versions: [], adoptedVersions: [] };
  }

  const { rows } = await pool.query<{ version: string; adopted: boolean }>(
    "SELECT version, adopted FROM schema_migrations ORDER BY version",
  );
  return {
    registryExists: true,
    versions: rows.map((row) => row.version),
    adoptedVersions: rows.filter((row) => Boolean(row.adopted)).map((row) => row.version),
  };
}

let preflightLogged = false;

/**
 * يطبع مرة واحدة فقط إلى سجل التشغيل، ولا يغيّر جواب /api/health ولا يعرّض
 * التفاصيل للعميل. لا يعمل إلا عند تفعيل العلم الصريح في بيئة إنتاجية.
 */
export async function logSchemaRegistrationPreflightOnce(pool: DbPool): Promise<void> {
  const production =
    process.env.NODE_ENV === "production"
    || process.env.DATABASE_ENVIRONMENT === "production"
    || Boolean(process.env.RAILWAY_PROJECT_ID);
  if (!production || process.env.SCHEMA_PREFLIGHT_LOG_ONCE !== "true" || preflightLogged) return;

  preflightLogged = true;
  try {
    const status = await readSchemaRegistrationPreflight(pool);
    console.info(
      `[schema-preflight] registry=${status.registryExists ? "present" : "absent"} `
      + `versions=${status.versions.join(",") || "none"} `
      + `adopted=${status.adoptedVersions.join(",") || "none"}`,
    );
  } catch (error) {
    console.warn(
      `[schema-preflight] read-only preflight failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
