import type { DbClient, DbPool } from "./db";

/**
 * معاملات مضمونة التراجع (P1.20) — بديل منظم عن كتل BEGIN/COMMIT اليدوية
 * المتناثرة، مع ضمانين بنيويين:
 *
 *  ١) التراجع مضمون: أي خطأ يرميه `work` (أو ينفجر داخل الاستعلامات) يمر
 *     عبر ROLLBACK قبل إعادة الرمي — فلا تظل معاملة معلّقة تُمسك أقفالًا
 *     (FOR UPDATE) وتُفسد التزامن التالي.
 *
 *  ٢) لا تسريب اتصال ولا إعادة اتصال ملوّث: يُحرَّر الاتصال في finally دائمًا؛
 *     يعود إلى الـpool فقط بعد COMMIT أو ROLLBACK ناجح، وإلا يُدمَّر
 *     (`release(true)`) — فلا تُورَّث معاملة مفتوحة أو حالة مجهولة لمستعير لاحق.
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
  return runOwnedTransaction(pool, "BEGIN", work);
}

/**
 * النواة المشتركة لـwithTransaction وwithIsolation (مراجعة Dot R1):
 *  - يُعاد الاتصال إلى الـpool فقط إذا ثبت أنه نظيف: COMMIT نجح، أو ROLLBACK نجح.
 *  - فشل BEGIN أو ROLLBACK ⇒ حالة الاتصال غير مؤكدة ⇒ `release(true)` يدمّره.
 *  - فشل COMMIT لا يثبت التراجع: قد يكون الاتصال انقطع بعد أن ثبتت المعاملة. لذلك
 *    يُرمى الخطأ دائمًا (لا نتيجة ولا كوكي ولا قرار بعد COMMIT غير مؤكد)، ثم يُحاول
 *    ROLLBACK للتنظيف فقط؛ ونجاحه يعني أن الاتصال صالح، لا أن الكتابة لم تحدث.
 *  - الخطأ الأصلي يبقى هو المرمي؛ فشل التنظيف لا يحجبه.
 */
async function runOwnedTransaction<T>(
  pool: DbPool,
  begin: string,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let reusable = false;
  try {
    // A failed BEGIN may still have reached the server: `reusable` stays false.
    await client.query(begin);
    let result: T;
    try {
      result = await work(client);
    } catch (error) {
      reusable = await rollbackQuietly(client);
      throw error;
    }
    try {
      await client.query("COMMIT");
    } catch (error) {
      // Outcome unknown to the caller: the error propagates; cleanup only decides reuse.
      reusable = await rollbackQuietly(client);
      throw error;
    }
    reusable = true;
    return result;
  } finally {
    try {
      if (reusable) client.release();
      else client.release(true);
    } catch {
      /* release failure never masks the original outcome */
    }
  }
}
async function rollbackQuietly(client: DbClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    return false;
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
  return runOwnedTransaction(pool, `BEGIN ISOLATION LEVEL ${level}`, work);
}
