/**
 * (DAY1 — ملاحظة المالك من أول يوم تشغيل) عملة الزيارة وأسعار الدليل بكل عملة.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0026_visit_currency.sql`
 * حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * - `services.price_sar_minor` / `price_usd_minor`: سعر الخدمة بالسعودي/الدولار كما يقرّره
 *   المالك (قرار المالك: أسعار خاصة بكل عملة). الفارغ يُحوَّل من السعر اليمني بسعر الصرف.
 * - `visits.billing_currency`: عملة فاتورة الزيارة الحرّة (غير المرتبطة بخطة). الفارغ = الأساس.
 */
export const VISIT_CURRENCY_SQL = `ALTER TABLE services ADD COLUMN IF NOT EXISTS price_sar_minor BIGINT;
ALTER TABLE services ADD COLUMN IF NOT EXISTS price_usd_minor BIGINT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS billing_currency TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'services_foreign_prices_nonnegative') THEN
    ALTER TABLE services ADD CONSTRAINT services_foreign_prices_nonnegative
      CHECK ((price_sar_minor IS NULL OR price_sar_minor >= 0) AND (price_usd_minor IS NULL OR price_usd_minor >= 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visits_billing_currency_known') THEN
    ALTER TABLE visits ADD CONSTRAINT visits_billing_currency_known
      CHECK (billing_currency IS NULL OR billing_currency IN ('YER', 'SAR', 'USD'));
  END IF;
END $$;`;
