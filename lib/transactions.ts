import type { DbClient, DbPool } from "./db";

/**
 * معاملات مضمونة التراجع (P1.20) — بديل منظم عن كتل BEGIN/COMMIT اليدوية
 * المتناثرة، مع ضمانين بنيويين:
 *
 *  ١) التراجع مضمون: أي خطأ يرميه `work` (أو ينفجر داخل الاستعلامات) يمر
 *     عبر ROLLBACK قبل إعادة الرمي — فلا تظل معاملة معلّقة تُمسك أقفالًا
 *     (FOR UPDATE) وتُفسد التزامن التالي.
 *
 *  ٢) لا تسريب اتصال: `release()` في finally دائمًا، حتى لو فشل ROLLBACK
 *     نفسه — الاتصال يعود إلى الـpool في كل الأحوال.
 *
 * لا إعادة محاولة تلقائية هنا عمدًا: الكتابات المالية لا تُعاد محاولة تنفيذها
 * تلقائيًا (قد تُنفَّذ مرتين إذا كان الخطأ بعد COMMIT — unbounded retry ممنوع
 * في P1.20). إعادة المحاولة قرارٌ في الطبقة الأعلى وللعمليات القابلة
 * للإثبات idempotent فقط.
 */
export async function withTransaction<T>(
  pool: DbPool,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN");
    began = true;
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (began) {
      await client.query("ROLLBACK").catch(() => {
        /* الاتصال سيُرجَع للـpool تالفًا أحيانًا — pg يدمّره عند release بعد فشل
           المعاملة؛ تجاهُل فشل ROLLBACK نفسه أفضل من تسريب الاتصال. */
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * مستوى عزل صريح للمعاملات المالية الحساسة — READ COMMITTED (الافتراضي في
 * PostgreSQL) يكفي مع الأقفال الصفّية (FOR UPDATE)، أما SERIALIZABLE فيُستخدم
 * حيث يلزم إثبات عدم التداخل البنيوي. تُستخدم داخل withTransaction:
 *
 *   await withTransaction(pool, (client) => { ... })
 */
export async function beginIsolation(
  client: DbClient,
  level: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE",
): Promise<void> {
  await client.query(`BEGIN ISOLATION LEVEL ${level}`);
}

/** معاملة بمستوى عزل صريح — نفس ضمانات withTransaction. */
export async function withIsolation<T>(
  pool: DbPool,
  level: "READ COMMITTED" | "REPEATABLE READ" | "SERIALIZABLE",
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let began = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${level}`);
    began = true;
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    if (began) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
