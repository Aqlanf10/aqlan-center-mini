/**
 * (P2-9) زرعُ صفٍّ قديمٍ فاسد كما يوجد فعلًا في قاعدةٍ سبقت القيد.
 *
 * قيود المال تُضاف NOT VALID: تمنع كل صفٍّ جديد، ولا تُسقط الهجرة بصفٍّ قديم — فقد
 * يبقى في قاعدة إنتاجٍ قديمة صفٌّ بعملة مجهولة، ومسارات القراءة يجب أن تُغلق فاشلةً
 * عليه. هذا المساعد يعيد إنتاج تلك الحالة حرفيًّا: يرفع القيد، يزرع الصف، ثم يعيد
 * القيد بتعريفه نفسه NOT VALID — فتبقى القاعدة كما تكون في الإنتاج: قيدٌ قائم وصفٌّ
 * قديم يخالفه.
 */
interface Queryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

export async function insertLegacyRow<T>(
  pool: Queryable,
  table: string,
  constraint: string,
  insert: () => Promise<T>,
): Promise<T> {
  const { rows } = await pool.query(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [constraint],
  );
  const definition = rows[0]?.def as string | undefined;
  if (!definition) return insert();
  await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
  try {
    return await insert();
  } finally {
    const notValid = /NOT VALID\s*$/i.test(definition) ? definition : `${definition} NOT VALID`;
    await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ${notValid}`);
  }
}
