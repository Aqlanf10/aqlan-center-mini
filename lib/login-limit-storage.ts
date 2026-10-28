import type { DbClient } from "./db";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";

/**
 * تخزين حدود محاولات الدخول — الطبقتان كما هما، بلا أي تهيئة للمخطط.
 *
 * هذا هو المصدر الوحيد لجمل SQL الخاصة بالحدّين: الدخول القديم يستدعيه بعد
 * `ensureSchema` (lib/db.ts) كما كان، والدخول الموحّد (canonical) يستدعيه على
 * جداول منصّبة سلفًا دون أن يلمس التهيئة أبدًا. الجدول الغائب خطأٌ يُغلق الباب
 * (42P01) — لا تجاوزٌ في الذاكرة ولا فتحٌ صامت.
 */
type Executor = { query: DbClient["query"] };
/** `schema` undefined keeps the legacy search_path behaviour; canonical callers pass it explicitly. */
type Connector = Executor & { connect(): Promise<DbClient> };

export interface LoginLimitDecision { allowed: boolean; retryAfterSeconds: number }

/** الحدّ القديم للحساب: ٥ محاولات في ربع ساعة، بمفتاح sha256 لاسم المستخدم. */
export async function consumeStaffAccountLimit(executor: Executor, accountKey: string, schema?: string): Promise<LoginLimitDecision> {
  const s = schema === undefined ? "" : `${staffIdentitySchemaName(schema)}.`;
  const { rows } = await executor.query<{ attempts: number; retry_seconds: number }>(
    `INSERT INTO ${s}staff_login_limits(account_key, window_started_at, attempts)
     VALUES ($1, NOW(), 1)
     ON CONFLICT(account_key) DO UPDATE SET
       attempts = CASE WHEN staff_login_limits.window_started_at <= NOW() - INTERVAL '15 minutes'
         THEN 1 ELSE LEAST(staff_login_limits.attempts + 1, 6) END,
       window_started_at = CASE WHEN staff_login_limits.window_started_at <= NOW() - INTERVAL '15 minutes'
         THEN NOW() ELSE staff_login_limits.window_started_at END
     RETURNING attempts, GREATEST(1, CEIL(EXTRACT(EPOCH FROM (window_started_at + INTERVAL '15 minutes' - NOW()))))::int AS retry_seconds`,
    [accountKey],
  );
  if (rows.length !== 1) throw new Error("LOGIN_LIMIT_STORAGE_INVALID");
  return { allowed: rows[0].attempts <= 5, retryAfterSeconds: rows[0].retry_seconds };
}

/** الحدّ المشترك (مفاتيح HMAC للحساب والمصدر) في معاملة واحدة مرتّبة المفاتيح. */
export async function consumeSharedLoginLimits(
  pool: Connector,
  limits: { key: string; maximum: number }[],
  windowMinutes: number,
  schema?: string,
): Promise<LoginLimitDecision> {
  if (limits.length === 0) return { allowed: true, retryAfterSeconds: 0 };
  const s = schema === undefined ? "" : `${staffIdentitySchemaName(schema)}.`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let allowed = true;
    let retryAfter = 1;
    for (const limit of [...limits].sort((a, b) => a.key.localeCompare(b.key))) {
      const { rows } = await client.query<{ attempts: number; retry: number }>(
        `INSERT INTO ${s}login_limits (key, window_start, attempts)
         VALUES ($1, NOW(), 1)
         ON CONFLICT (key) DO UPDATE SET
           attempts = CASE WHEN login_limits.window_start <= NOW() - ($3::text::interval)
             THEN 1 ELSE LEAST(login_limits.attempts + 1, $2 + 1) END,
           window_start = CASE WHEN login_limits.window_start <= NOW() - ($3::text::interval)
             THEN NOW() ELSE login_limits.window_start END
         RETURNING attempts, GREATEST(1, CEIL(EXTRACT(EPOCH FROM
           (window_start + ($3::text::interval) - NOW()))))::int AS retry`,
        [limit.key, limit.maximum, `${windowMinutes} minutes`],
      );
      if (rows.length !== 1) throw new Error("LOGIN_LIMIT_STORAGE_INVALID");
      if (rows[0].attempts > limit.maximum) {
        allowed = false;
        retryAfter = Math.max(retryAfter, rows[0].retry);
      }
    }
    await client.query(`DELETE FROM ${s}login_limits WHERE window_start < NOW() - INTERVAL '1 day'`);
    await client.query("COMMIT");
    return { allowed, retryAfterSeconds: retryAfter };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** يصفّر عدّادات الحساب وحدها بعد دخولٍ ناجح؛ عدّاد المصدر لا يُمسّ. */
export async function clearAccountLoginLimits(executor: Executor, legacyAccountKey: string, sharedAccountKeys: string[], schema?: string): Promise<void> {
  const s = schema === undefined ? "" : `${staffIdentitySchemaName(schema)}.`;
  await executor.query(`DELETE FROM ${s}staff_login_limits WHERE account_key = $1`, [legacyAccountKey]);
  if (sharedAccountKeys.length > 0) {
    await executor.query(`DELETE FROM ${s}login_limits WHERE key = ANY($1::text[])`, [sharedAccountKeys]);
  }
}
